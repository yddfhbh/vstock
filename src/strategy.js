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
  evaluateTopN: numberEnv('EVALUATE_TOP_N', 80),
  maxBuysPerLoop: numberEnv('MAX_BUYS_PER_LOOP', 1),
  buyScoreThreshold: numberEnv('BUY_SCORE_THRESHOLD', 13),

  minMomentum1h: numberEnv('MIN_MOMENTUM_1H', 1.5),
  maxMomentum1h: numberEnv('MAX_MOMENTUM_1H', 20),
  maxVolatility1h: numberEnv('MAX_VOLATILITY_1H', 24),
  maxPullbackFromHigh: numberEnv('MAX_PULLBACK_FROM_HIGH', -2.5),

  trailingStartRate: numberEnv('TRAILING_START_RATE', 1.0),
  trailingDropRate: numberEnv('TRAILING_DROP_RATE', -0.8),

  maxEntryPrice: numberEnv('MAX_ENTRY_PRICE', 160000),
  buyConfirmCount: numberEnv('BUY_CONFIRM_COUNT', 2),
  buyConfirmWindowMs: numberEnv('BUY_CONFIRM_WINDOW_MS', 60000),
  minMicroMomentum: numberEnv('MIN_MICRO_MOMENTUM', -0.3),

  priceFetchConcurrency: numberEnv('PRICE_FETCH_CONCURRENCY', 8),
  confirmCandidatesN: numberEnv('CONFIRM_CANDIDATES_N', 5),
  waitLogTopN: numberEnv('WAIT_LOG_TOP_N', 5),
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

      if (currentPrice > algo.maxEntryPrice) return false;

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

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const currentIndex = index++;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

async function getBuySignals(stocks, portfolio, getStockPrices) {
  const candidates = preFilterCandidates(stocks, portfolio);

  cleanupBuyConfirm();

  const analyzed = await mapLimit(
    candidates,
    algo.priceFetchConcurrency,
    async stock => {
      try {
        const priceData = await getStockPrices(stock.id, '1h');
        const analysis = analyzePricePoints(priceData.points, stock.currentPrice);

        if (!analysis) return null;

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
          return null;
        }

        let score = 0;

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
          return null;
        }

        return {
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
          momentum1h,
          momentumShort,
          momentumMicro,
          pullbackFromHigh,
        };
      } catch (err) {
        console.log(`[PRICE ERROR] ${stock.channelName} / ${err.message}`);
        return null;
      }
    }
  );

  const ranked = analyzed
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, algo.confirmCandidatesN);

  const signals = [];

  for (let i = 0; i < ranked.length; i++) {
    const signal = ranked[i];

    const confirmCount = updateBuyConfirm(signal.stockId);

    if (confirmCount < algo.buyConfirmCount) {
      if (i < algo.waitLogTopN) {
        console.log(
          `[BUY WAIT] ${signal.stockName} ` +
          `${confirmCount}/${algo.buyConfirmCount} / ` +
          `score ${signal.score.toFixed(2)} / ` +
          `1h ${signal.momentum1h.toFixed(2)}% / ` +
          `short ${signal.momentumShort.toFixed(2)}% / ` +
          `micro ${signal.momentumMicro.toFixed(2)}% / ` +
          `high ${signal.pullbackFromHigh.toFixed(2)}%`
        );
      }

      continue;
    }

    buyConfirmMap.delete(signal.stockId);

    signals.push(signal);

    if (signals.length >= algo.maxBuysPerLoop) {
      break;
    }
  }

  console.log(
    `[BUY DEBUG] candidates=${candidates.length} / ranked=${ranked.length} / signals=${signals.length}`
  );

  return signals;
}

function markSignalTraded(signal) {
  markTraded(signal.stockId);
}

module.exports = {
  getBuySignals,
  getSellSignals,
  markSignalTraded,
};