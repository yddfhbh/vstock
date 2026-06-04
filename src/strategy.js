const config = require('./config');

const lastTradeAt = new Map();
const holdingPeaks = new Map();
const holdingFirstSeenAt = new Map();

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const algo = {
  evaluateTopN: numberEnv('EVALUATE_TOP_N', 80),
  maxBuysPerLoop: numberEnv('MAX_BUYS_PER_LOOP', 1),
  buyScoreThreshold: numberEnv('BUY_SCORE_THRESHOLD', 15),

  minMomentum1h: numberEnv('MIN_MOMENTUM_1H', 3),
  maxMomentum1h: numberEnv('MAX_MOMENTUM_1H', 18),
  maxVolatility1h: numberEnv('MAX_VOLATILITY_1H', 22),
  maxPullbackFromHigh: numberEnv('MAX_PULLBACK_FROM_HIGH', -2.5),

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

  // 최근 4포인트 기준 초단기 모멘텀
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

      // 1day 등락률은 너무 극단적인 종목만 제외하는 용도로만 사용
      if (stock.changeRate > config.maxChangeRateOnEntry) return false;
      if (stock.changeRate < -20) return false;

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
    .sort((a, b) => {
      // changeRate 높은 순 몰빵 방지.
      // LIVE 종목을 조금 우선하고, 그다음은 움직임 있는 종목을 넓게 잡음.
      const aLive = a.isLive ? 1 : 0;
      const bLive = b.isLive ? 1 : 0;

      if (bLive !== aLive) return bLive - aLive;

      const aMovement = Math.min(Math.abs(Number(a.changeRate) || 0), 100);
      const bMovement = Math.min(Math.abs(Number(b.changeRate) || 0), 100);

      return bMovement - aMovement;
    })
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

      // 단타형: 최근 몇 포인트가 확실히 오르는 종목만
      const shortMomentumOk = momentumShort >= config.minShortMomentum;

      const volatilityOk = volatility1h <= algo.maxVolatility1h;

      // 고점 대비 많이 밀린 종목은 추세 꺾인 걸로 보고 제외
      const pullbackOk = pullbackFromHigh >= algo.maxPullbackFromHigh;

      if (!momentumOk || !shortMomentumOk || !volatilityOk || !pullbackOk) {
        continue;
      }

      let score = 0;

      // 핵심 변경:
      // 1day changeRate 비중 거의 제거
      // 1h와 short 모멘텀에 강한 가중치
      score += momentum1h * 1.4;
      score += momentumShort * 3.0;
      score += stock.changeRate * 0.003;

      if (stock.isLive) {
        score += 0.5;
      }

      // 변동성 과하면 감점
      if (volatility1h > 18) {
        score -= (volatility1h - 18) * 0.35;
      }

      // 고점에서 살짝만 꺾여도 강하게 감점
      if (pullbackFromHigh < -1.5) {
        score -= Math.abs(pullbackFromHigh + 1.5) * 1.2;
      }

      // 하루 기준 과열 종목은 약하게만 감점
      if (stock.changeRate > 80) {
        score -= (stock.changeRate - 80) * 0.05;
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