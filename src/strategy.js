const config = require('./config');

const lastTradeAt = new Map();
const holdingPeaks = new Map();
const holdingFirstSeenAt = new Map();

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const algo = {
  evaluateTopN: numberEnv('EVALUATE_TOP_N', 25),
  maxBuysPerLoop: numberEnv('MAX_BUYS_PER_LOOP', 1),
  buyScoreThreshold: numberEnv('BUY_SCORE_THRESHOLD', 15),

  minMomentum1h: numberEnv('MIN_MOMENTUM_1H', 4),
  maxMomentum1h: numberEnv('MAX_MOMENTUM_1H', 22),
  maxVolatility1h: numberEnv('MAX_VOLATILITY_1H', 24),
  maxPullbackFromHigh: numberEnv('MAX_PULLBACK_FROM_HIGH', -3),

  trailingStartRate: numberEnv('TRAILING_START_RATE', 1.2),
  trailingDropRate: numberEnv('TRAILING_DROP_RATE', -0.8),
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

  // 최근 4포인트 기준 단기 모멘텀
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
  const currentHoldingIds = new Set();

  for (const holding of portfolio.holdings || []) {
    const stockId = holding.stockId;
    currentHoldingIds.add(stockId);

    const currentPrice = Number(holding.currentPrice);
    const prevPeak = holdingPeaks.get(stockId) || currentPrice;
    const newPeak = Math.max(prevPeak, currentPrice);

    holdingPeaks.set(stockId, newPeak);

    if (!holdingFirstSeenAt.has(stockId)) {
      holdingFirstSeenAt.set(stockId, Date.now());
    }

    const firstSeenAt = holdingFirstSeenAt.get(stockId);
    const holdingMs = Date.now() - firstSeenAt;
    const peakDrawdown = percentChange(newPeak, currentPrice);

    if (!canTrade(stockId)) continue;

    if (holding.profitRate >= config.takeProfitRate) {
      signals.push({
        type: 'SELL',
        reason: `단타 익절: ${holding.profitRate}%`,
        stockId,
        stockName: holding.stockName,
        quantity: holding.quantity,
      });
      continue;
    }

    if (holding.profitRate <= config.stopLossRate) {
      signals.push({
        type: 'SELL',
        reason: `단타 손절: ${holding.profitRate}%`,
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
        reason: `단타 트레일링: 고점 대비 ${peakDrawdown.toFixed(2)}%`,
        stockId,
        stockName: holding.stockName,
        quantity: holding.quantity,
      });
      continue;
    }

    if (
      holdingMs >= config.maxHoldMs &&
      holding.profitRate >= config.timeExitProfitRate
    ) {
      signals.push({
        type: 'SELL',
        reason: `시간 청산 익절: ${Math.round(holdingMs / 1000)}초 보유 / ${holding.profitRate}%`,
        stockId,
        stockName: holding.stockName,
        quantity: holding.quantity,
      });
      continue;
    }

    if (
      holdingMs >= config.maxHoldMs &&
      holding.profitRate <= config.timeExitLossRate
    ) {
      signals.push({
        type: 'SELL',
        reason: `시간 청산 손절: ${Math.round(holdingMs / 1000)}초 보유 / ${holding.profitRate}%`,
        stockId,
        stockName: holding.stockName,
        quantity: holding.quantity,
      });
      continue;
    }
  }

  // 이미 판 종목은 추적 데이터 삭제
  for (const stockId of holdingFirstSeenAt.keys()) {
    if (!currentHoldingIds.has(stockId)) {
      holdingFirstSeenAt.delete(stockId);
      holdingPeaks.delete(stockId);
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

  const usableCash = Math.max(
    0,
    Number(portfolio.me.balance || 0) - config.buyCashReserve
  );

  const maxTradeCash = Math.floor(
    usableCash * (config.maxBuyCashPerTradeRate / 100)
  );

  if (usableCash <= 0) return [];
  if (maxTradeCash < config.minBuyCash) return [];

  return stocks
    .filter(stock => {
      if (holdings.has(stock.id)) return false;
      if (stock.isDelisted) return false;

      const currentPrice = Number(stock.currentPrice);
      if (!Number.isFinite(currentPrice)) return false;
      if (currentPrice <= 0) return false;

      // 너무 이미 오른 종목 제외
      if (stock.changeRate > config.maxChangeRateOnEntry) return false;

      const bufferedPrice = Math.ceil(
        currentPrice * (1 + config.buyPriceBufferRate / 100)
      );

      // 전체 잔고로도 못 사면 제외
      if (usableCash < bufferedPrice) return false;

      // 1회 거래 한도로도 못 사면 제외
      if (maxTradeCash < bufferedPrice) return false;

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

      // 단타형: 최근 단기 상승이 약하면 제외
      const shortMomentumOk = momentumShort >= config.minShortMomentum;

      const volatilityOk = volatility1h <= algo.maxVolatility1h;

      // 고점에서 많이 밀린 종목 제외
      const pullbackOk = pullbackFromHigh >= algo.maxPullbackFromHigh;

      if (!momentumOk || !shortMomentumOk || !volatilityOk || !pullbackOk) {
        continue;
      }

      let score = 0;

      // 단타형: 1시간 전체보다 최근 단기 모멘텀 비중을 높임
      score += momentum1h * 1.0;
      score += momentumShort * 2.0;
      score += stock.changeRate * 0.02;

      if (stock.isLive) {
        score += 0.5;
      }

      if (volatility1h > 18) {
        score -= (volatility1h - 18) * 0.35;
      }

      if (pullbackFromHigh < -2) {
        score -= Math.abs(pullbackFromHigh + 2) * 0.8;
      }

      if (stock.changeRate > 60) {
        score -= (stock.changeRate - 60) * 0.12;
      }

      if (score < algo.buyScoreThreshold) {
        continue;
      }

      signals.push({
        type: 'BUY',
        reason:
          `단타 점수 ${score.toFixed(2)} / ` +
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