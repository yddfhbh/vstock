const config = require('./config');

const lastTradeAt = new Map();
const holdingPeaks = new Map();
const holdingFirstSeenAt = new Map();
const buyConfirmMap = new Map();

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const algo = {
  evaluateTopN: numberEnv('EVALUATE_TOP_N', 60),
  maxBuysPerLoop: numberEnv('MAX_BUYS_PER_LOOP', 1),
  buyScoreThreshold: numberEnv('BUY_SCORE_THRESHOLD', 18),

  minMomentum1h: numberEnv('MIN_MOMENTUM_1H', 2),
  maxMomentum1h: numberEnv('MAX_MOMENTUM_1H', 14),
  maxVolatility1h: numberEnv('MAX_VOLATILITY_1H', 16),
  maxPullbackFromHigh: numberEnv('MAX_PULLBACK_FROM_HIGH', -1.2),

  trailingStartRate: numberEnv('TRAILING_START_RATE', 1.0),
  trailingDropRate: numberEnv('TRAILING_DROP_RATE', -0.6),

  maxEntryPrice: numberEnv('MAX_ENTRY_PRICE', 120000),
  buyConfirmCount: numberEnv('BUY_CONFIRM_COUNT', 2),
  buyConfirmWindowMs: numberEnv('BUY_CONFIRM_WINDOW_MS', 60000),
  minMicroMomentum: numberEnv('MIN_MICRO_MOMENTUM', -0.1),
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
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .map(p => Number(p.price));

  if (valid.length < 5) {
    return null;
  }

  const first = valid[0];
  const last = fallbackPrice || valid[valid.length - 1];
  const high = Math.max(...valid, last);
  const low = Math.min(...valid, last);

  const shortBase = valid[Math.max(0, valid.length - 4)];
  const microBase = valid[Math.max(0, valid.length - 2)];

  const momentum1h = percentChange(first, last);
  const momentumShort = percentChange(shortBase, last);
  const momentumMicro = percentChange(microBase, last);
  const pullbackFromHigh = percentChange(high, last);
  const volatility1h = percentChange(low, high);

  return {
    first,
    last,
    high,
    low,
    momentum1h,
    momentumShort,
    momentumMicro,
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

      // 비싼 종목은 1주만 사도 총자산 변동이 너무 커서 제외
      if (currentPrice > algo.maxEntryPrice) return false;

      // 1day 등락률은 너무 극단적인 종목만 제외
      if (stock.changeRate > config.maxChangeRateOnEntry) return false;
      if (stock.changeRate < -20) return false;

      const bufferedPrice = Math.ceil(
        currentPrice * (1 + config.buyPriceBufferRate / 100)
      );

      if (usableCash < bufferedPrice) return false;
      if (maxTradeCash < bufferedPrice) return false;

      if (!canTrade(stock.id)) return false;

      return true;
    })
    .sort((a, b) => {
      const aLive = a.isLive ? 1 : 0;
      const bLive = b.isLive ? 1 : 0;

      if (bLive !== aLive) return bLive - aLive;

      const aMovement = Math.min(Math.abs(Number(a.changeRate) || 0), 100);
      const bMovement = Math.min(Math.abs(Number(b.changeRate) || 0), 100);

      return bMovement - aMovement;
    })
    .slice(0, algo.evaluateTopN);
}

function updateBuyConfirm(stockId) {
  const now = Date.now();
  const prev = buyConfirmMap.get(stockId);

  const count =
    prev && now - prev.lastSeenAt <= algo.buyConfirmWindowMs
      ? prev.count + 1
      : 1;

  buyConfirmMap.set(stockId, {
    count,
    lastSeenAt: now,
  });

  return count;
}

function cleanupBuyConfirm() {
  const now = Date.now();

  for (const [stockId, value] of buyConfirmMap.entries()) {
    if (now - value.lastSeenAt > algo.buyConfirmWindowMs) {
      buyConfirmMap.delete(stockId);
    }
  }
}

async function getBuySignals(stocks, portfolio, getStockPrices) {
  const signals = [];
  const candidates = preFilterCandidates(stocks, portfolio);

  cleanupBuyConfirm();

  for (const stock of candidates) {
    try {
      const priceData = await getStockPrices(stock.id, '1h');
      const analysis = analyzePricePoints(priceData.points, stock.currentPrice);

      if (!analysis) continue;

      const {
        momentum1h,
        momentumShort,
        momentumMicro,
        pullbackFromHigh,
        volatility1h,
      } = analysis;

      const momentumOk =
        momentum1h >= algo.minMomentum1h &&
        momentum1h <= algo.maxMomentum1h;

      const shortMomentumOk = momentumShort >= config.minShortMomentum;

      // 방금 전 틱이 꺾인 종목은 바로 안 삼
      const microMomentumOk = momentumMicro >= algo.minMicroMomentum;

      const volatilityOk = volatility1h <= algo.maxVolatility1h;
      const pullbackOk = pullbackFromHigh >= algo.maxPullbackFromHigh;

      if (
        !momentumOk ||
        !shortMomentumOk ||
        !microMomentumOk ||
        !volatilityOk ||
        !pullbackOk
      ) {
        continue;
      }

      let score = 0;

      // 1day changeRate 거의 배제
      // 1h, short, micro 중심
      score += momentum1h * 1.2;
      score += momentumShort * 3.0;
      score += momentumMicro * 2.0;
      score += stock.changeRate * 0.001;

      if (stock.isLive) {
        score += 0.3;
      }

      if (volatility1h > 12) {
        score -= (volatility1h - 12) * 0.45;
      }

      if (pullbackFromHigh < -0.8) {
        score -= Math.abs(pullbackFromHigh + 0.8) * 1.5;
      }

      if (stock.changeRate > 80) {
        score -= (stock.changeRate - 80) * 0.03;
      }

      if (score < algo.buyScoreThreshold) {
        continue;
      }

      const confirmCount = updateBuyConfirm(stock.id);

      if (confirmCount < algo.buyConfirmCount) {
        console.log(
          `[BUY WAIT] ${stock.channelName} 확인 대기 ` +
          `${confirmCount}/${algo.buyConfirmCount} / ` +
          `score ${score.toFixed(2)} / ` +
          `1h ${momentum1h.toFixed(2)}% / ` +
          `short ${momentumShort.toFixed(2)}% / ` +
          `micro ${momentumMicro.toFixed(2)}% / ` +
          `high ${pullbackFromHigh.toFixed(2)}%`
        );
        continue;
      }

      buyConfirmMap.delete(stock.id);

      signals.push({
        type: 'BUY',
        reason:
          `단타 점수 ${score.toFixed(2)} / ` +
          `1h ${momentum1h.toFixed(2)}% / ` +
          `short ${momentumShort.toFixed(2)}% / ` +
          `micro ${momentumMicro.toFixed(2)}% / ` +
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