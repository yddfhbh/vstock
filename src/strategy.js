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
  minRecentMomentum: numberEnv('MIN_RECENT_MOMENTUM', 0.15),
  recentMomentumLookbackTicks: numberEnv('RECENT_MOMENTUM_LOOKBACK_TICKS', 8),
  trendWindowTicks: numberEnv('TREND_WINDOW_TICKS', 12),
  minTrendConsistency: numberEnv('MIN_TREND_CONSISTENCY', 0.48),
  maxConsecutiveDownTicks: numberEnv('MAX_CONSECUTIVE_DOWN_TICKS', 2),
  minRangePosition: numberEnv('MIN_RANGE_POSITION', 0.35),
  overheatRangePosition: numberEnv('OVERHEAT_RANGE_POSITION', 0.94),
  overheatMicroMomentum: numberEnv('OVERHEAT_MICRO_MOMENTUM', 1.2),
  chopPenaltyWeight: numberEnv('CHOP_PENALTY_WEIGHT', 0.35),
  liveStockScoreBonus: numberEnv('LIVE_STOCK_SCORE_BONUS', 0.6),
  stockTypeBlueChipWeight: numberEnv('STOCK_TYPE_BLUE_CHIP_WEIGHT', 0.8),
  stockTypeGrowthWeight: numberEnv('STOCK_TYPE_GROWTH_WEIGHT', 0.3),
  stockTypeNewWeight: numberEnv('STOCK_TYPE_NEW_WEIGHT', -0.2),
  stockTypeIpoWeight: numberEnv('STOCK_TYPE_IPO_WEIGHT', -1.2),

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

  dividendAggressiveStartHour: numberEnv('DIVIDEND_AGGRESSIVE_START_HOUR', 23),
  dividendAggressiveStartMinute: numberEnv('DIVIDEND_AGGRESSIVE_START_MINUTE', 50),
  dividendCashReserve: numberEnv('DIVIDEND_CASH_RESERVE', 30000),
  dividendMaxBuyCashPerTradeRate: numberEnv('DIVIDEND_MAX_BUY_CASH_PER_TRADE_RATE', 60),
  dividendAddBuyQuantity: numberEnv('DIVIDEND_ADD_BUY_QUANTITY', 3),

  earlyStopMs: numberEnv('EARLY_STOP_MS', 90000),
  earlyStopLossRate: numberEnv('EARLY_STOP_LOSS_RATE', -0.8),
  panicPeakDrawdownRate: numberEnv('PANIC_PEAK_DRAWDOWN_RATE', -1.8),
  timeExitNeutralRate: numberEnv('TIME_EXIT_NEUTRAL_RATE', -0.15),

  dividendRateWeight: numberEnv('DIVIDEND_RATE_WEIGHT', 1.2),
  dividendCountWeight: numberEnv('DIVIDEND_COUNT_WEIGHT', 1.0),
  dividendRateWalkDog: numberEnv('DIVIDEND_RATE_WALKDOG', 3),
  dividendRateNative: numberEnv('DIVIDEND_RATE_NATIVE', 15),
  dividendRateUnknownTier: numberEnv('DIVIDEND_RATE_UNKNOWN_TIER', 0),

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

function isDividendAggressiveMode() {
  if (!isDividendMode()) return false;

  const current = nowKstMinutes();

  const start =
    algo.dividendAggressiveStartHour * 60 +
    algo.dividendAggressiveStartMinute;

  return current >= start;
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

function getDividendInfo(stock) {
  const gradeRaw =
    stock.oshiGrade ??
    stock.grade ??
    stock.oshiLevel ??
    stock.oshiRank ??
    stock.oshi?.grade ??
    stock.oshi?.level ??
    stock.dividendGrade ??
    '';

  const grade = String(gradeRaw || '');

  let rate = Number(
    stock.dividendRate ??
    stock.dividend_rate ??
    stock.oshiDividendRate ??
    stock.oshi_dividend_rate ??
    stock.oshi?.dividendRate ??
    stock.dividend?.rate
  );

  let count = Number(
    stock.dividendCount ??
    stock.dividend_count ??
    stock.oshiDividendCount ??
    stock.oshi_dividend_count ??
    stock.oshi?.dividendCount ??
    stock.dividend?.count
  );

  if (!Number.isFinite(rate)) rate = 0;
  if (!Number.isFinite(count)) count = 0;

  if (rate <= 0) {
    if (grade.includes('산책견')) {
      rate = algo.dividendRateWalkDog;
      if (count <= 0) count = 1;
    } else if (grade.includes('원주민')) {
      rate = algo.dividendRateNative;
      if (count <= 0) count = 3;
    } else if (grade.includes('???')) {
      rate = algo.dividendRateUnknownTier;
      if (count <= 0) count = 8;
    }
  }

  return { grade, rate, count };
}

function getDividendScoreBonus(stock) {
  const info = getDividendInfo(stock);

  const bonus =
    Math.max(0, info.rate) * algo.dividendRateWeight +
    Math.max(0, info.count) * algo.dividendCountWeight;

  return {
    ...info,
    bonus,
  };
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

function getStockTypeWeight(stock) {
  const type = String(stock.stockType || '').toUpperCase();

  if (type === 'BLUE_CHIP') return algo.stockTypeBlueChipWeight;
  if (type === 'GROWTH') return algo.stockTypeGrowthWeight;
  if (type === 'NEW') return algo.stockTypeNewWeight;
  if (type === 'IPO') return algo.stockTypeIpoWeight;

  return 0;
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
  const recentBase = valid[
    Math.max(0, valid.length - Math.max(2, algo.recentMomentumLookbackTicks))
  ];

  const trendWindow = valid.slice(
    Math.max(0, valid.length - Math.max(3, algo.trendWindowTicks))
  );

  let upTicks = 0;
  let downTicks = 0;

  for (let i = 1; i < trendWindow.length; i++) {
    const diff = trendWindow[i] - trendWindow[i - 1];

    if (diff > 0) upTicks += 1;
    if (diff < 0) downTicks += 1;
  }

  let consecutiveDownTicks = 0;

  for (let i = valid.length - 1; i > 0; i--) {
    if (valid[i] >= valid[i - 1]) break;
    consecutiveDownTicks += 1;
  }

  const momentum1h = percentChange(first, last);
  const momentumShort = percentChange(shortBase, last);
  const momentumMicro = percentChange(microBase, last);
  const momentumRecent = percentChange(recentBase, last);
  const pullbackFromHigh = percentChange(high, last);
  const volatility1h = percentChange(low, high);
  const trendTickCount = upTicks + downTicks;
  const trendConsistency = trendTickCount > 0 ? upTicks / trendTickCount : 0;
  const rangePosition = high > low ? (last - low) / (high - low) : 0.5;

  return {
    first,
    last,
    high,
    low,
    momentum1h,
    momentumShort,
    momentumMicro,
    momentumRecent,
    pullbackFromHigh,
    volatility1h,
    trendConsistency,
    consecutiveDownTicks,
    rangePosition,
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

  const ageMs = Date.now() - startedAt;
  if (ageMs > algo.liveTransitionWindowMs) return '';

  const sec = Math.round(ageMs / 1000);
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
      holdingMs <= algo.earlyStopMs &&
      holding.profitRate <= algo.earlyStopLossRate
    ) {
      signals.push({
        type: 'SELL',
        reason: `초반 실패 손절: ${Math.round(holdingMs / 1000)}초 / ${holding.profitRate}%`,
        stockId,
        stockName: holding.stockName,
        quantity: holding.quantity,
      });
      continue;
    }

    if (
      holdingMs >= 30000 &&
      peakDrawdown <= algo.panicPeakDrawdownRate
    ) {
      signals.push({
        type: 'SELL',
        reason: `고점 이탈 방어: 고점 대비 ${peakDrawdown.toFixed(2)}%`,
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
      holding.profitRate >= algo.timeExitNeutralRate
    ) {
      signals.push({
        type: 'SELL',
        reason: `시간 청산 보합: ${Math.round(holdingMs / 1000)}초 보유 / ${holding.profitRate}%`,
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

  const dividendMode = isDividendMode();
  const aggressiveDividendMode = isDividendAggressiveMode();

  // 일반 모드에서는 매수 잠금 조건 적용
  // 공격 배당 모드에서는 현금 소진을 위해 매수 잠금 일부 무시
  if (!aggressiveDividendMode && !canOpenNewPosition(portfolio)) {
    return [];
  }

  const holdings = makeHoldingMap(portfolio);
  const positionCount = portfolio.holdings?.length || 0;

  const maxPositions = dividendMode
    ? algo.dividendMaxPositions
    : config.maxPositions;

  // 일반/배당 준비 모드에서는 최대 종목 수 도달 시 신규매수 중단
  // 공격 배당 모드에서는 이미 보유한 종목 추가매수는 허용
  if (!aggressiveDividendMode && positionCount >= maxPositions) {
    return [];
  }

  const cashReserve = aggressiveDividendMode
    ? algo.dividendCashReserve
    : config.buyCashReserve;

  const buyCashRate = aggressiveDividendMode
    ? algo.dividendMaxBuyCashPerTradeRate
    : config.maxBuyCashPerTradeRate;

  const usableCash = Math.max(
    0,
    Number(portfolio.me.balance || 0) - cashReserve
  );

  const maxTradeCash = Math.floor(
    usableCash * (buyCashRate / 100)
  );

  if (usableCash <= 0) return [];
  if (maxTradeCash < config.minBuyCash) return [];

  return stocks
    .filter(stock => {
      const alreadyHolding = holdings.has(stock.id);

      if (stock.isDelisted) return false;

      // 일반 모드에서는 이미 보유 중인 종목 추가매수 금지
      // 공격 배당 모드에서는 보유 종목 추가매수 허용
      if (alreadyHolding && !aggressiveDividendMode) return false;

      // 공격 배당 모드에서 이미 3종목 들고 있으면 새 종목은 금지하고 기존 보유 종목만 추가매수
      if (
        aggressiveDividendMode &&
        positionCount >= maxPositions &&
        !alreadyHolding
      ) {
        return false;
      }

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

      // 공격 배당 모드에서는 같은 종목 쿨다운도 완화
      if (!aggressiveDividendMode && !canBuy(stock.id)) return false;

      return true;
    })
    .sort((a, b) => {
      const aHolding = holdings.has(a.id) ? 1 : 0;
      const bHolding = holdings.has(b.id) ? 1 : 0;

      // 공격 배당 모드에서는 이미 보유 중인 종목을 우선 추가매수
      if (aggressiveDividendMode && bHolding !== aHolding) {
        return bHolding - aHolding;
      }

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

function makeDividendForceBuySignals(portfolio) {
  if (!isDividendAggressiveMode()) {
    return [];
  }

  if (!boolEnv('DIVIDEND_FORCE_BUY', true)) {
    return [];
  }

  const balance = Number(portfolio.me?.balance || 0);
  const reserve = algo.dividendCashReserve;
  const usableCash = Math.max(0, balance - reserve);

  if (usableCash < config.minBuyCash) {
    return [];
  }

  const minProfitRate = numberEnv('DIVIDEND_ADD_BUY_MIN_PROFIT_RATE', -5);

  const holdings = [...(portfolio.holdings || [])]
    .filter(h => Number(h.currentPrice || 0) > 0)
    .filter(h => Number(h.profitRate || 0) >= minProfitRate)
    .sort((a, b) => {
      const ap = Number(a.profitRate || 0);
      const bp = Number(b.profitRate || 0);

      // 수익률 좋은 종목 우선
      if (bp !== ap) return bp - ap;

      // 같으면 평가금액 큰 종목 우선
      return holdingValue(b) - holdingValue(a);
    })
    .slice(0, algo.dividendMaxPositions);

  return holdings.map(h => ({
    type: 'BUY',
    reason:
      `배당 강제 추가매수 / ` +
      `보유 ${h.quantity}주 / ` +
      `수익률 ${h.profitRate}% / ` +
      `잔고 ${balance.toLocaleString()}원`,
    stockId: h.stockId,
    stockName: h.stockName,
    quantity: algo.dividendAddBuyQuantity,
    price: h.currentPrice,
    score: 999,
    allowAddToHolding: true,
  }));
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

  cleanupBuyConfirm();

  const forcedDividendSignals = makeDividendForceBuySignals(portfolio);

  if (forcedDividendSignals.length > 0) {
    console.log(
      `[DIVIDEND FORCE] 보유 종목 강제 추가매수 후보 ` +
      `${forcedDividendSignals.length}개 / ` +
      `signals=${Math.min(forcedDividendSignals.length, algo.maxBuysPerLoop)}`
    );

    return forcedDividendSignals.slice(0, algo.maxBuysPerLoop);
  }

  const candidates = preFilterCandidates(stocks, portfolio);

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
          momentumRecent,
          pullbackFromHigh,
          volatility1h,
          trendConsistency,
          consecutiveDownTicks,
          rangePosition,
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

        const minRecentMomentum = justLive
          ? Math.min(0, algo.minRecentMomentum)
          : algo.minRecentMomentum;

        const minTrendConsistency = justLive
          ? Math.max(0.4, algo.minTrendConsistency - 0.08)
          : algo.minTrendConsistency;

        const shortMomentumOk = momentumShort >= config.minShortMomentum;
        const microMomentumOk = momentumMicro >= algo.minMicroMomentum;
        const recentMomentumOk = momentumRecent >= minRecentMomentum;
        const trendOk = trendConsistency >= minTrendConsistency;
        const downStreakOk = consecutiveDownTicks <= algo.maxConsecutiveDownTicks;
        const rangePositionOk = rangePosition >= algo.minRangePosition;
        const overheatOk =
          justLive ||
          rangePosition < algo.overheatRangePosition ||
          momentumMicro <= algo.overheatMicroMomentum;
        const volatilityOk = volatility1h <= algo.maxVolatility1h;
        const pullbackOk = pullbackFromHigh >= algo.maxPullbackFromHigh;

        if (
          !momentumOk ||
          !shortMomentumOk ||
          !microMomentumOk ||
          !recentMomentumOk ||
          !trendOk ||
          !downStreakOk ||
          !rangePositionOk ||
          !overheatOk ||
          !volatilityOk ||
          !pullbackOk
        ) {
          return null;
        }

        let score = 0;
        const stockTypeWeight = getStockTypeWeight(stock);

        score += Math.min(momentum1h, algo.maxMomentum1h) * 1.0;
        score += momentumShort * 2.5;
        score += momentumMicro * 2.0;
        score += momentumRecent * 2.2;
        score += (trendConsistency - 0.5) * 8.0;
        score += Math.max(0, rangePosition - 0.5) * 2.0;
        score -= consecutiveDownTicks * 1.3;
        score += stockTypeWeight;
        score += stock.changeRate * 0.001;

        if (stock.isLive) {
          score += algo.liveStockScoreBonus;
        }

        if (justLive) {
          score += algo.liveTransitionBoost;
        }

                let dividendBonusInfo = null;

        if (dividendMode) {
          score += Math.min(Number(stock.currentPrice || 0) / 20000, 5);

          dividendBonusInfo = getDividendScoreBonus(stock);
          score += dividendBonusInfo.bonus;
        }

        if (volatility1h > 12) {
          score -= (volatility1h - 12) * 0.6;
        }

        const chopPenalty = Math.max(
          0,
          volatility1h - Math.max(4, Math.abs(momentum1h) * 2)
        );

        score -= chopPenalty * algo.chopPenaltyWeight;

        if (pullbackFromHigh < -0.8) {
          score -= Math.abs(pullbackFromHigh + 0.8) * 2.0;
        }

        if (stock.changeRate > 80) {
          score -= (stock.changeRate - 80) * 0.03;
        }

        if (score < minScore) {
          return null;
        }

        const aggressiveDividendMode = isDividendAggressiveMode();
        const alreadyHolding = makeHoldingMap(portfolio).has(stock.id);

        const quantity =
           aggressiveDividendMode && alreadyHolding
            ? algo.dividendAddBuyQuantity
            : getAdaptiveBuyQuantity(stock, dividendMode);

        return {
          type: 'BUY',
                    reason:
            `${dividendMode ? '배당+단타' : '단타'} 점수 ${score.toFixed(2)} / ` +
            `1h ${momentum1h.toFixed(2)}% / ` +
            `short ${momentumShort.toFixed(2)}% / ` +
            `micro ${momentumMicro.toFixed(2)}% / ` +
            `recent ${momentumRecent.toFixed(2)}% / ` +
            `vol ${volatility1h.toFixed(2)}% / ` +
            `high ${pullbackFromHigh.toFixed(2)}% / ` +
            `trend ${(trendConsistency * 100).toFixed(0)}% / ` +
            `range ${(rangePosition * 100).toFixed(0)}% / ` +
            `type ${stock.stockType || '-'}` +
            `${dividendBonusInfo && dividendBonusInfo.bonus > 0
              ? ` / 배당률 ${dividendBonusInfo.rate}% / 배당횟수 ${dividendBonusInfo.count}`
              : ''}` +
            `${justLive ? ' / LIVE 전환 감지' : ''}` +
            `${getLiveAgeText(stock.id)}`,
          stockId: stock.id,
          stockName: stock.channelName,
          quantity,
          price: stock.currentPrice,
          score,
          allowAddToHolding: aggressiveDividendMode && alreadyHolding,
          momentum1h,
          momentumShort,
          momentumMicro,
          momentumRecent,
          pullbackFromHigh,
          trendConsistency,
          rangePosition,
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
          `recent ${signal.momentumRecent.toFixed(2)}% / ` +
          `high ${signal.pullbackFromHigh.toFixed(2)}% / ` +
          `trend ${(signal.trendConsistency * 100).toFixed(0)}% / ` +
          `range ${(signal.rangePosition * 100).toFixed(0)}%` +
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
