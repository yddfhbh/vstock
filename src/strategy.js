const config = require('./config');

const lastBuyAt = new Map();
const lastExitAt = new Map();
const holdingPeaks = new Map();
const holdingFirstSeenAt = new Map();
const buyConfirmMap = new Map();

// LIVE 전환 추적용
const lastLiveState = new Map();
const liveStartedAt = new Map();
let liveStateSeeded = false;
let lastAnyBuyAt = 0;
let consecutiveLossSells = 0;
let buyPausedUntil = 0;

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const algo = {
  evaluateTopN: numberEnv('EVALUATE_TOP_N', 100),
  maxBuysPerLoop: numberEnv('MAX_BUYS_PER_LOOP', 1),
  buyScoreThreshold: numberEnv('BUY_SCORE_THRESHOLD', 13),

  minMomentum1h: numberEnv('MIN_MOMENTUM_1H', 1.2),
  maxMomentum1h: numberEnv('MAX_MOMENTUM_1H', 24),
  maxVolatility1h: numberEnv('MAX_VOLATILITY_1H', 24),
  maxPullbackFromHigh: numberEnv('MAX_PULLBACK_FROM_HIGH', -2.2),

  trailingStartRate: numberEnv('TRAILING_START_RATE', 0.9),
  trailingDropRate: numberEnv('TRAILING_DROP_RATE', -0.7),

  maxEntryPrice: numberEnv('MAX_ENTRY_PRICE', 140000),
  buyConfirmCount: numberEnv('BUY_CONFIRM_COUNT', 2),
  buyConfirmWindowMs: numberEnv('BUY_CONFIRM_WINDOW_MS', 70000),
  minMicroMomentum: numberEnv('MIN_MICRO_MOMENTUM', -0.1),

  priceFetchConcurrency: numberEnv('PRICE_FETCH_CONCURRENCY', 8),
  confirmCandidatesN: numberEnv('CONFIRM_CANDIDATES_N', 5),
  waitLogTopN: numberEnv('WAIT_LOG_TOP_N', 4),

  liveTransitionBoost: numberEnv('LIVE_TRANSITION_BOOST', 8),
  liveTransitionWindowMs: numberEnv('LIVE_TRANSITION_WINDOW_MS', 900000),
  liveTransitionRelaxMomentum: numberEnv('LIVE_TRANSITION_RELAX_MOMENTUM', 0.7),
  liveTransitionRelaxScore: numberEnv('LIVE_TRANSITION_RELAX_SCORE', 3),

  dividendMaxPositions: numberEnv('DIVIDEND_MAX_POSITIONS', 3),
  dividendBuyQuantity: numberEnv('DIVIDEND_BUY_QUANTITY', 2),
  dividendStopLossRate: numberEnv('DIVIDEND_STOP_LOSS_RATE', -5),
  dividendMinScore: numberEnv('DIVIDEND_MIN_SCORE', 10),

  buyGlobalCooldownMs: numberEnv('BUY_GLOBAL_COOLDOWN_MS', 45000),
  lossPauseCount: numberEnv('LOSS_PAUSE_COUNT', 2),
  lossPauseMs: numberEnv('LOSS_PAUSE_MS', 180000),
};

function nowKstMinutes() {
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return kst.getHours() * 60 + kst.getMinutes();
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return String(raw).trim().toLowerCase() === 'true';
}

function hasHoldingLoss(portfolio) {
  return (portfolio.holdings || []).some(h => Number(h.profitRate || 0) < -0.3);
}

function canOpenNewPosition(portfolio) {
  const now = Date.now();

  if (now < buyPausedUntil) {
    console.log(`[BUY PAUSE] 손절 연속 발생으로 매수 중단 중: ${Math.ceil((buyPausedUntil - now) / 1000)}초 남음`);
    return false;
  }

  if (now - lastAnyBuyAt < algo.buyGlobalCooldownMs) {
    return false;
  }

  if (
    boolEnv('BLOCK_BUY_WHEN_HOLDING_LOSS', true) &&
    hasHoldingLoss(portfolio)
  ) {
    console.log('[BUY BLOCK] 보유 종목 중 손실 종목이 있어 신규매수 보류');
    return false;
  }

  return true;
}

function isDividendMode() {
  const current = nowKstMinutes();

  const start =
    config.dividendModeStartHour * 60 + config.dividendModeStartMinute;

  const end =
    config.dividendModeEndHour * 60 + config.dividendModeEndMinute;

  // 23:40 ~ 00:05처럼 자정 넘기는 구간
  if (start > end) {
    return current >= start || current <= end;
  }

  return current >= start && current <= end;
}

function canBuy(stockId) {
  const now = Date.now();
  const lastBuy = lastBuyAt.get(stockId) || 0;
  const lastExit = lastExitAt.get(stockId) || 0;
  const last = Math.max(lastBuy, lastExit);

  return now - last >= config.tradeCooldownMs;
}

function markBought(stockId) {
  lastBuyAt.set(stockId, Date.now());
}

function markSold(stockId) {
  lastExitAt.set(stockId, Date.now());
  holdingPeaks.delete(stockId);
  holdingFirstSeenAt.delete(stockId);
  buyConfirmMap.delete(stockId);
}

function makeHoldingMap(portfolio) {
  const map = new Map();

  for (const holding of portfolio.holdings || []) {
    map.set(holding.stockId, holding);
  }

  return map;
}

function holdingValue(holding) {
  return Number(holding.currentPrice || 0) * Number(holding.quantity || 0);
}

function getDividendTopHoldingIds(portfolio) {
  return new Set(
    [...(portfolio.holdings || [])]
      .sort((a, b) => holdingValue(b) - holdingValue(a))
      .slice(0, algo.dividendMaxPositions)
      .map(h => h.stockId)
  );
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

function getAdaptiveBuyQuantity(stock, dividendMode) {
  const price = Number(stock.currentPrice || 0);

  if (dividendMode) {
    return algo.dividendBuyQuantity;
  }

  const multiBuyPriceLimit = numberEnv('MULTI_BUY_PRICE_LIMIT', 70000);
  const multiBuyQuantity = numberEnv('MULTI_BUY_QUANTITY', 2);

  if (price > 0 && price <= multiBuyPriceLimit) {
    return Math.max(config.buyQuantity, multiBuyQuantity);
  }

  return config.buyQuantity;
}

function updateLiveTransitions(stocks) {
  const now = Date.now();

  for (const stock of stocks) {
    const id = stock.id;
    const currentLive = stock.isLive === true;
    const prevLive = lastLiveState.get(id);

    // 첫 루프에서는 현재 상태만 저장하고 전환으로 보지 않음
    if (liveStateSeeded && prevLive === false && currentLive === true) {
      liveStartedAt.set(id, now);
    }

    lastLiveState.set(id, currentLive);
  }

  liveStateSeeded = true;
}

function isLiveJustStarted(stockId) {
  const startedAt = liveStartedAt.get(stockId);
  if (!startedAt) return false;

  return Date.now() - startedAt <= algo.liveTransitionWindowMs;
}

function getLiveAgeText(stockId) {
  const startedAt = liveStartedAt.get(stockId);
  if (!startedAt) return '';

  const sec = Math.round((Date.now() - startedAt) / 1000);
  return ` / live+${sec}s`;
}

function getSellSignals(portfolio) {
  const signals = [];
  const currentHoldingIds = new Set();
  const dividendMode = isDividendMode();
  const dividendTopIds = getDividendTopHoldingIds(portfolio);

  for (const holding of portfolio.holdings || []) {
    const stockId = holding.stockId;
    currentHoldingIds.add(stockId);

    const currentPrice = Number(holding.currentPrice);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;

    const prevPeak = holdingPeaks.get(stockId) || currentPrice;
    const newPeak = Math.max(prevPeak, currentPrice);
    holdingPeaks.set(stockId, newPeak);

    if (!holdingFirstSeenAt.has(stockId)) {
      holdingFirstSeenAt.set(stockId, Date.now());
    }

    const firstSeenAt = holdingFirstSeenAt.get(stockId);
    const holdingMs = Date.now() - firstSeenAt;
    const peakDrawdown = percentChange(newPeak, currentPrice);

    // 배당 모드:
    // 상위 3개는 자정 배당을 위해 최대한 유지.
    // 단, 큰 손실은 예외적으로 정리.
    if (dividendMode) {
      if (holding.profitRate <= algo.dividendStopLossRate) {
        signals.push({
          type: 'SELL',
          reason: `배당 모드 예외 손절: ${holding.profitRate}%`,
          stockId,
          stockName: holding.stockName,
          quantity: holding.quantity,
        });
        continue;
      }

      // 배당 상위 3개가 아닌 종목은 살짝 수익이면 정리해서 현금 확보
      if (!dividendTopIds.has(stockId) && holding.profitRate >= 0.5) {
        signals.push({
          type: 'SELL',
          reason: `배당 모드 비상위 정리: ${holding.profitRate}%`,
          stockId,
          stockName: holding.stockName,
          quantity: holding.quantity,
        });
        continue;
      }

      continue;
    }

    // 일반 모드: 매도에는 쿨다운 없음. 손절/익절 즉시.
    if (holding.profitRate <= config.stopLossRate) {
      signals.push({
        type: 'SELL',
        reason: `즉시 손절: ${holding.profitRate}%`,
        stockId,
        stockName: holding.stockName,
        quantity: holding.quantity,
      });
      continue;
    }

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
  updateLiveTransitions(stocks);

  const holdings = makeHoldingMap(portfolio);
  const positionCount = portfolio.holdings?.length || 0;
  const dividendMode = isDividendMode();
  const maxPositions = dividendMode
    ? algo.dividendMaxPositions
    : config.maxPositions;

  if (positionCount >= maxPositions) {
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

      if (!canBuy(stock.id)) return false;

      return true;
    })
    .sort((a, b) => {
      const aJustLive = isLiveJustStarted(a.id) ? 1 : 0;
      const bJustLive = isLiveJustStarted(b.id) ? 1 : 0;

      if (bJustLive !== aJustLive) return bJustLive - aJustLive;

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
  const dividendMode = isDividendMode();
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

        const justLive = isLiveJustStarted(stock.id);

        const minMomentum1h = justLive
          ? Math.max(0, algo.minMomentum1h - algo.liveTransitionRelaxMomentum)
          : algo.minMomentum1h;

        const minScore = dividendMode
          ? Math.min(algo.buyScoreThreshold, algo.dividendMinScore)
          : justLive
            ? Math.max(5, algo.buyScoreThreshold - algo.liveTransitionRelaxScore)
            : algo.buyScoreThreshold;

        const momentumOk =
          momentum1h >= minMomentum1h &&
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

        score += momentum1h * 1.0;
        score += momentumShort * 2.5;
        score += momentumMicro * 2.0;
        score += stock.changeRate * 0.001;

        if (stock.isLive) {
          score += 0.3;
        }

        if (justLive) {
          score += algo.liveTransitionBoost;
        }

        if (dividendMode) {
          // 배당 모드에서는 현재가가 어느 정도 있는 종목이 유리함.
          // 단 너무 비싼 종목은 maxEntryPrice에서 이미 제외.
          score += Math.min(Number(stock.currentPrice || 0) / 20000, 5);
        }

        if (volatility1h > 12) {
          score -= (volatility1h - 12) * 0.6;
        }

        if (pullbackFromHigh < -0.8) {
          score -= Math.abs(pullbackFromHigh + 0.8) * 2.0;
        }

        if (stock.changeRate > 80) {
          score -= (stock.changeRate - 80) * 0.03;
        }

        if (score < minScore) {
          return null;
        }

        const quantity = getAdaptiveBuyQuantity(stock, dividendMode);
        
        return {
          type: 'BUY',
          reason:
            `${dividendMode ? '배당+단타' : '단타'} 점수 ${score.toFixed(2)} / ` +
            `1h ${momentum1h.toFixed(2)}% / ` +
            `short ${momentumShort.toFixed(2)}% / ` +
            `micro ${momentumMicro.toFixed(2)}% / ` +
            `vol ${volatility1h.toFixed(2)}% / ` +
            `high ${pullbackFromHigh.toFixed(2)}%` +
            `${justLive ? ' / LIVE 전환 감지' : ''}` +
            `${getLiveAgeText(stock.id)}`,
          stockId: stock.id,
          stockName: stock.channelName,
          quantity,
          price: stock.currentPrice,
          score,
          momentum1h,
          momentumShort,
          momentumMicro,
          pullbackFromHigh,
          justLive,
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
          `high ${signal.pullbackFromHigh.toFixed(2)}%` +
          `${signal.justLive ? ' / LIVE 전환' : ''}`
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
    `[BUY DEBUG] candidates=${candidates.length} / ranked=${ranked.length} / signals=${signals.length} / dividendMode=${dividendMode}`
  );

  return signals;
}

function markSignalTraded(signal) {
  if (signal.type === 'BUY') {
    lastAnyBuyAt = Date.now();
    markBought(signal.stockId);
    return;
  }

  if (signal.type === 'SELL') {
    const reason = String(signal.reason || '');

    if (reason.includes('손절')) {
      consecutiveLossSells += 1;

      if (consecutiveLossSells >= algo.lossPauseCount) {
        buyPausedUntil = Date.now() + algo.lossPauseMs;
        console.log(`[BUY PAUSE] 손절 ${consecutiveLossSells}회 연속 → ${Math.round(algo.lossPauseMs / 1000)}초 매수 중단`);
        consecutiveLossSells = 0;
      }
    } else if (reason.includes('익절')) {
      consecutiveLossSells = 0;
    }

    markSold(signal.stockId);
  }
}

module.exports = {
  getBuySignals,
  getSellSignals,
  markSignalTraded,
};