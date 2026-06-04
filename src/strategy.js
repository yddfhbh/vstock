const config = require('./config');

const lastTradeAt = new Map();
const holdingPeaks = new Map();

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const algo = {
  evaluateTopN: numberEnv('EVALUATE_TOP_N', 20),
  maxBuysPerLoop: numberEnv('MAX_BUYS_PER_LOOP', 1),
  buyScoreThreshold: numberEnv('BUY_SCORE_THRESHOLD', 8),

  minMomentum1h: numberEnv('MIN_MOMENTUM_1H', 2),
  maxMomentum1h: numberEnv('MAX_MOMENTUM_1H', 35),
  maxVolatility1h: numberEnv('MAX_VOLATILITY_1H', 45),
  maxPullbackFromHigh: numberEnv('MAX_PULLBACK_FROM_HIGH', -18),

  trailingStartRate: numberEnv('TRAILING_START_RATE', 3),
  trailingDropRate: numberEnv('TRAILING_DROP_RATE', -2),
};

function canTrade(stockId) {
  const last = lastTradeAt.get(stockId) || 0;
  return Date.now() - last >= config.tradeCooldownMs;
}

function markTraded(stockId) {
  lastTradeAt.set(stockId, Date.now());
}

function makeHoldingMap(portfolio) {
  const map = new Map();

  for (const holding of portfolio.holdings || []) {
    map.set(holding.stockId, holding);
  }

  return map;
}

function percentChange(from, to) {
  if (!from || from <= 0) return 0;
  return ((to - from) / from) * 100;
}

function analyzePricePoints(points, fallbackPrice) {
  const valid = (points || [])
    .filter(p => Number.isFinite(Number(p.price)))
    .map(p => Number(p.price));

  if (valid.length < 5) {
    return null;
  }

  const first = valid[0];
  const last = fallbackPrice || valid[valid.length - 1];
  const high = Math.max(...valid, last);
  const low = Math.min(...valid, last);

  const shortBase = valid[Math.max(0, valid.length - 4)];

  const momentum1h = percentChange(first, last);
  const momentumShort = percentChange(shortBase, last);
  const pullbackFromHigh = percentChange(high, last);
  const volatility1h = percentChange(low, high);

  return {
    first,
    last,
    high,
    low,
    momentum1h,
    momentumShort,
    pullbackFromHigh,
    volatility1h,
  };
}

function getSellSignals(portfolio) {
  const signals = [];

  for (const holding of portfolio.holdings || []) {
    const stockId = holding.stockId;
    const currentPrice = Number(holding.currentPrice);
    const prevPeak = holdingPeaks.get(stockId) || currentPrice;
    const newPeak = Math.max(prevPeak, currentPrice);

    holdingPeaks.set(stockId, newPeak);

    const peakDrawdown = percentChange(newPeak, currentPrice);

    if (!canTrade(stockId)) continue;

    if (holding.profitRate >= config.takeProfitRate) {
      signals.push({
        type: 'SELL',
        reason: `익절 조건 도달: ${holding.profitRate}%`,
        stockId,
        stockName: holding.stockName,
        quantity: holding.quantity,
      });
      continue;
    }

    if (holding.profitRate <= config.stopLossRate) {
      signals.push({
        type: 'SELL',
        reason: `손절 조건 도달: ${holding.profitRate}%`,
        stockId,
        stockName: holding.stockName,
        quantity: holding.quantity,
      });
      continue;
    }

    if (
      holding.profitRate >= algo.trailingStartRate &&
      peakDrawdown <= algo.trailingDropRate
    ) {
      signals.push({
        type: 'SELL',
        reason: `트레일링 매도: 고점 대비 ${peakDrawdown.toFixed(2)}%`,
        stockId,
        stockName: holding.stockName,
        quantity: holding.quantity,
      });
    }
  }

  return signals;
}

function preFilterCandidates(stocks, portfolio) {
  const holdings = makeHoldingMap(portfolio);
  const positionCount = portfolio.holdings?.length || 0;

  if (positionCount >= config.maxPositions) {
    return [];
  }

  const usableCash = Math.max(0, Number(portfolio.me.balance || 0) - config.buyCashReserve);

  return stocks
    .filter(stock => {
      if (holdings.has(stock.id)) return false;
      if (stock.isDelisted) return false;
      if (!Number.isFinite(Number(stock.currentPrice))) return false;
      if (stock.currentPrice <= 0) return false;
      if (stock.changeRate > config.maxChangeRateOnEntry) return false;

      const bufferedPrice = Math.ceil(
        stock.currentPrice * (1 + config.buyPriceBufferRate / 100)
      );

      if (usableCash < bufferedPrice) return false;

      if (!canTrade(stock.id)) return false;

      return true;
    })
    .sort((a, b) => b.changeRate - a.changeRate)
    .slice(0, algo.evaluateTopN);
}

async function getBuySignals(stocks, portfolio, getStockPrices) {
  const signals = [];
  const candidates = preFilterCandidates(stocks, portfolio);

  for (const stock of candidates) {
    try {
      const priceData = await getStockPrices(stock.id, '1h');
      const analysis = analyzePricePoints(priceData.points, stock.currentPrice);

      if (!analysis) continue;

      const {
        momentum1h,
        momentumShort,
        pullbackFromHigh,
        volatility1h,
      } = analysis;

      const momentumOk =
        momentum1h >= algo.minMomentum1h &&
        momentum1h <= algo.maxMomentum1h;

      const shortMomentumOk = momentumShort >= 0.5;
      const volatilityOk = volatility1h <= algo.maxVolatility1h;
      const pullbackOk = pullbackFromHigh >= algo.maxPullbackFromHigh;

      if (!momentumOk || !shortMomentumOk || !volatilityOk || !pullbackOk) {
        continue;
      }

      let score = 0;

      score += momentum1h * 1.5;
      score += momentumShort * 1.0;
      score += stock.changeRate * 0.03;

      if (stock.isLive) {
        score += 1;
      }

      if (volatility1h > 20) {
        score -= (volatility1h - 20) * 0.2;
      }

      if (pullbackFromHigh < -8) {
        score -= Math.abs(pullbackFromHigh + 8) * 0.3;
      }

      if (stock.changeRate > 80) {
        score -= (stock.changeRate - 80) * 0.08;
      }

      if (score < algo.buyScoreThreshold) {
        continue;
      }

      signals.push({
        type: 'BUY',
        reason:
          `모멘텀 점수 ${score.toFixed(2)} / ` +
          `1h ${momentum1h.toFixed(2)}% / ` +
          `short ${momentumShort.toFixed(2)}% / ` +
          `vol ${volatility1h.toFixed(2)}% / ` +
          `high ${pullbackFromHigh.toFixed(2)}%`,
        stockId: stock.id,
        stockName: stock.channelName,
        quantity: config.buyQuantity,
        price: stock.currentPrice,
        score,
      });
    } catch (err) {
      console.log(`[PRICE ERROR] ${stock.channelName} / ${err.message}`);
    }
  }

  return signals
    .sort((a, b) => b.score - a.score)
    .slice(0, algo.maxBuysPerLoop);
}

function markSignalTraded(signal) {
  markTraded(signal.stockId);
}

module.exports = {
  getBuySignals,
  getSellSignals,
  markSignalTraded,
};