const fs = require('fs');
const path = require('path');

const config = require('./config');

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const MEMORY_PATH = path.join(__dirname, '..', 'data', 'strategy-memory.json');

const DEFAULT_WEIGHTS = Object.freeze({
  bias: 0,
  momentum1h: 1.05,
  momentumShort: 0.95,
  momentumMicro: 0.35,
  momentumRecent: 0.85,
  trend: 1.25,
  rangeSweetSpot: 0.8,
  pullbackHealth: 0.55,
  volatility: -0.8,
  downStreak: -0.65,
  highChaseRisk: -1.1,
  live: 0.35,
  liveStart: 0.55,
  typeBlueChip: 0.45,
  typeGrowth: 0.2,
  typeNew: -0.15,
  typeIpo: -0.45,
});

const algo = {
  evaluateTopN: numberEnv('LEARN_EVALUATE_TOP_N', numberEnv('EVALUATE_TOP_N', 160)),
  maxBuysPerLoop: numberEnv('LEARN_MAX_BUYS_PER_LOOP', numberEnv('MAX_BUYS_PER_LOOP', 2)),
  baseScoreThreshold: numberEnv('LEARN_BUY_SCORE_THRESHOLD', 1.6),
  minScoreThreshold: numberEnv('LEARN_MIN_SCORE_THRESHOLD', 0.8),
  maxScoreThreshold: numberEnv('LEARN_MAX_SCORE_THRESHOLD', 3.8),

  learningRate: numberEnv('LEARN_RATE', 0.08),
  weightDecay: numberEnv('LEARN_WEIGHT_DECAY', 0.006),
  rewardScaleRate: numberEnv('LEARN_REWARD_SCALE_RATE', 8),
  memoryMaxClosedTrades: numberEnv('LEARN_MEMORY_MAX_TRADES', 240),

  explorationRate: numberEnv('LEARN_EXPLORATION_RATE', 0.06),
  explorationBonus: numberEnv('LEARN_EXPLORATION_BONUS', 0.35),

  priceFetchConcurrency: numberEnv('LEARN_PRICE_FETCH_CONCURRENCY', numberEnv('PRICE_FETCH_CONCURRENCY', 8)),
  confirmCandidatesN: numberEnv('LEARN_CONFIRM_CANDIDATES_N', numberEnv('CONFIRM_CANDIDATES_N', 8)),
  buyConfirmCount: numberEnv('LEARN_BUY_CONFIRM_COUNT', 1),
  buyConfirmWindowMs: numberEnv('LEARN_BUY_CONFIRM_WINDOW_MS', 60000),
  waitLogTopN: numberEnv('LEARN_WAIT_LOG_TOP_N', numberEnv('WAIT_LOG_TOP_N', 4)),

  maxEntryPrice: numberEnv('LEARN_MAX_ENTRY_PRICE', numberEnv('MAX_ENTRY_PRICE', 300000)),
  minChangeRateOnEntry: numberEnv('LEARN_MIN_CHANGE_RATE_ON_ENTRY', -35),
  minMomentum1h: numberEnv('LEARN_MIN_MOMENTUM_1H', -3.5),
  maxMomentum1h: numberEnv('LEARN_MAX_MOMENTUM_1H', 32),
  maxVolatility1h: numberEnv('LEARN_MAX_VOLATILITY_1H', 42),
  maxPullbackFromHigh: numberEnv('LEARN_MAX_PULLBACK_FROM_HIGH', -18),
  highChaseRangePosition: numberEnv('LEARN_HIGH_CHASE_RANGE_POSITION', 0.985),
  highChaseMicroMomentum: numberEnv('LEARN_HIGH_CHASE_MICRO_MOMENTUM', 2.2),
  lateTopMomentum1h: numberEnv('LEARN_LATE_TOP_MOMENTUM_1H', 12),
  lateTopShortMomentum: numberEnv('LEARN_LATE_TOP_SHORT_MOMENTUM', 5),
  lateTopRecentMomentum: numberEnv('LEARN_LATE_TOP_RECENT_MOMENTUM', 8),

  positionCashRate: numberEnv('LEARN_POSITION_CASH_RATE', 12),
  minPositionCash: numberEnv('LEARN_MIN_POSITION_CASH', 30000),
  minRiskMultiplier: numberEnv('LEARN_MIN_RISK_MULTIPLIER', 0.45),
  maxRiskMultiplier: numberEnv('LEARN_MAX_RISK_MULTIPLIER', 1.35),
  maxPortfolioExposureRate: numberEnv('LEARN_MAX_PORTFOLIO_EXPOSURE_RATE', 88),
  minAutoPositions: numberEnv('LEARN_MIN_AUTO_POSITIONS', 3),
  maxAutoPositions: numberEnv('LEARN_MAX_AUTO_POSITIONS', 6),
  minTradeCashRate: numberEnv('LEARN_MIN_TRADE_CASH_RATE', 18),
  maxTradeCashRate: numberEnv('LEARN_MAX_TRADE_CASH_RATE', 58),

  globalCooldownMs: numberEnv('LEARN_BUY_GLOBAL_COOLDOWN_MS', 30000),
  lossPauseCount: numberEnv('LEARN_LOSS_PAUSE_COUNT', 2),
  lossPauseMs: numberEnv('LEARN_LOSS_PAUSE_MS', 240000),
  earlyStopPauseMs: numberEnv('LEARN_EARLY_STOP_PAUSE_MS', 180000),

  stopLossRate: numberEnv('LEARN_STOP_LOSS_RATE', config.stopLossRate),
  takeProfitRate: numberEnv('LEARN_TAKE_PROFIT_RATE', config.takeProfitRate),
  trailingStartRate: numberEnv('LEARN_TRAILING_START_RATE', 3.2),
  trailingDropRate: numberEnv('LEARN_TRAILING_DROP_RATE', -1.35),
  earlyStopMinMs: numberEnv('LEARN_EARLY_STOP_MIN_MS', 90000),
  earlyStopMs: numberEnv('LEARN_EARLY_STOP_MS', 900000),
  earlyStopLossRate: numberEnv('LEARN_EARLY_STOP_LOSS_RATE', -5.5),
  timeExitNeutralRate: numberEnv('LEARN_TIME_EXIT_NEUTRAL_RATE', 0.15),
  maxHoldMs: numberEnv('LEARN_MAX_HOLD_MS', 3600000),
};

const lastBuyAt = new Map();
const lastExitAt = new Map();
const holdingPeaks = new Map();
const holdingFirstSeenAt = new Map();
const buyConfirmMap = new Map();
const lastLiveState = new Map();
const liveStartedAt = new Map();

let liveStateSeeded = false;
let lastAnyBuyAt = 0;
let buyPausedUntil = 0;
let memory = loadMemory();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function defaultMemory() {
  return {
    version: 1,
    scoreThreshold: algo.baseScoreThreshold,
    riskMultiplier: 1,
    weights: { ...DEFAULT_WEIGHTS },
    stats: {
      buys: 0,
      sells: 0,
      wins: 0,
      losses: 0,
      lossStreak: 0,
      winStreak: 0,
      realizedProfitRateSum: 0,
    },
    openTrades: {},
    closedTrades: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeMemory(raw) {
  const base = defaultMemory();

  if (!raw || typeof raw !== 'object') return base;

  return {
    ...base,
    ...raw,
    scoreThreshold: cleanNumber(raw.scoreThreshold, base.scoreThreshold),
    riskMultiplier: cleanNumber(raw.riskMultiplier, base.riskMultiplier),
    weights: {
      ...base.weights,
      ...(raw.weights || {}),
    },
    stats: {
      ...base.stats,
      ...(raw.stats || {}),
    },
    openTrades: raw.openTrades && typeof raw.openTrades === 'object'
      ? raw.openTrades
      : {},
    closedTrades: Array.isArray(raw.closedTrades)
      ? raw.closedTrades.slice(-algo.memoryMaxClosedTrades)
      : [],
  };
}

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_PATH)) return defaultMemory();
    const raw = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
    return normalizeMemory(raw);
  } catch (err) {
    console.log(`[LEARN MEMORY] failed to load memory, starting fresh: ${err.message}`);
    return defaultMemory();
  }
}

function saveMemory() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
    memory.updatedAt = new Date().toISOString();
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.log(`[LEARN MEMORY] failed to save memory: ${err.message}`);
  }
}

function percentChange(from, to) {
  if (!from || from <= 0) return 0;
  return ((to - from) / from) * 100;
}

function holdingValue(holding) {
  return cleanNumber(holding.currentPrice) * cleanNumber(holding.quantity);
}

function portfolioAsset(portfolio) {
  const totalAsset = cleanNumber(portfolio.me?.totalAsset);
  if (totalAsset > 0) return totalAsset;

  const balance = cleanNumber(portfolio.me?.balance);
  const holdingsValue = (portfolio.holdings || [])
    .reduce((sum, holding) => sum + holdingValue(holding), 0);

  return Math.max(0, balance + holdingsValue);
}

function portfolioExposureRate(portfolio) {
  const asset = portfolioAsset(portfolio);
  if (asset <= 0) return 0;

  const holdingsValue = (portfolio.holdings || [])
    .reduce((sum, holding) => sum + holdingValue(holding), 0);

  return (holdingsValue / asset) * 100;
}

function canBuy(stockId, cooldownMs) {
  const now = Date.now();
  const lastBuy = lastBuyAt.get(stockId) || 0;
  const lastExit = lastExitAt.get(stockId) || 0;

  return now - Math.max(lastBuy, lastExit) >= cooldownMs;
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

function hasDividendSystemInfo(stock) {
  if (!config.dividendSystemAvailable) return false;

  const values = [
    stock.dividendRate,
    stock.dividend_rate,
    stock.dividendCount,
    stock.dividend_count,
    stock.dividendGrade,
    stock.oshiDividendRate,
    stock.oshi_dividend_rate,
    stock.oshiDividendCount,
    stock.oshi_dividend_count,
    stock.oshiGrade,
    stock.oshi?.dividendRate,
    stock.oshi?.dividendCount,
    stock.dividend?.rate,
    stock.dividend?.count,
  ];

  return values.some(value => value !== undefined && value !== null && value !== '');
}

function analyzePricePoints(points, fallbackPrice) {
  const valid = (points || [])
    .filter(point => Number.isFinite(Number(point.price)))
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    .map(point => Number(point.price));

  if (valid.length < 5) return null;

  const first = valid[0];
  const last = cleanNumber(fallbackPrice, valid[valid.length - 1]);
  const high = Math.max(...valid, last);
  const low = Math.min(...valid, last);
  const shortBase = valid[Math.max(0, valid.length - 4)];
  const microBase = valid[Math.max(0, valid.length - 2)];
  const recentBase = valid[Math.max(0, valid.length - 8)];
  const trendWindow = valid.slice(Math.max(0, valid.length - 12));

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

  const trendTickCount = upTicks + downTicks;

  return {
    first,
    last,
    high,
    low,
    momentum1h: percentChange(first, last),
    momentumShort: percentChange(shortBase, last),
    momentumMicro: percentChange(microBase, last),
    momentumRecent: percentChange(recentBase, last),
    pullbackFromHigh: percentChange(high, last),
    volatility1h: percentChange(low, high),
    trendConsistency: trendTickCount > 0 ? upTicks / trendTickCount : 0.5,
    consecutiveDownTicks,
    rangePosition: high > low ? (last - low) / (high - low) : 0.5,
  };
}

function updateLiveTransitions(stocks) {
  const now = Date.now();

  for (const stock of stocks) {
    const id = stock.id;
    const currentLive = stock.isLive === true;
    const prevLive = lastLiveState.get(id);

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

  return Date.now() - startedAt <= 120000;
}

function stockTypeFeatures(stock) {
  const type = String(stock.stockType || '').toUpperCase();

  return {
    typeBlueChip: type === 'BLUE_CHIP' ? 1 : 0,
    typeGrowth: type === 'GROWTH' ? 1 : 0,
    typeNew: type === 'NEW' ? 1 : 0,
    typeIpo: type === 'IPO' ? 1 : 0,
  };
}

function makeFeatures(stock, analysis) {
  const rangeSweetSpot = 1 - Math.abs(analysis.rangePosition - 0.68) / 0.45;
  const highChaseRisk =
    analysis.rangePosition >= algo.highChaseRangePosition &&
    analysis.momentumMicro >= algo.highChaseMicroMomentum &&
    analysis.pullbackFromHigh > -0.2
      ? 1
      : 0;

  return {
    momentum1h: clamp(analysis.momentum1h / 12, -1.5, 1.5),
    momentumShort: clamp(analysis.momentumShort / 6, -1.5, 1.5),
    momentumMicro: clamp(analysis.momentumMicro / 4, -1.5, 1.5),
    momentumRecent: clamp(analysis.momentumRecent / 7, -1.5, 1.5),
    trend: clamp((analysis.trendConsistency - 0.5) * 2, -1, 1),
    rangeSweetSpot: clamp(rangeSweetSpot, -1, 1),
    pullbackHealth: clamp((analysis.pullbackFromHigh + 5) / 5, -1, 1),
    volatility: clamp(analysis.volatility1h / 24, 0, 2),
    downStreak: clamp(analysis.consecutiveDownTicks / 5, 0, 1),
    highChaseRisk,
    live: stock.isLive ? 1 : 0,
    liveStart: isLiveJustStarted(stock.id) ? 1 : 0,
    ...stockTypeFeatures(stock),
  };
}

function weightedScore(features) {
  const weights = memory.weights || DEFAULT_WEIGHTS;
  let score = cleanNumber(weights.bias);

  for (const [key, value] of Object.entries(features)) {
    score += cleanNumber(weights[key], cleanNumber(DEFAULT_WEIGHTS[key])) * value;
  }

  return score;
}

function recentStats(limit = 30) {
  const recent = (memory.closedTrades || []).slice(-limit);

  if (recent.length === 0) {
    return {
      count: 0,
      winRate: 0,
      avgProfitRate: 0,
    };
  }

  const wins = recent.filter(trade => cleanNumber(trade.profitRate) > 0).length;
  const sum = recent.reduce(
    (total, trade) => total + cleanNumber(trade.profitRate),
    0
  );

  return {
    count: recent.length,
    winRate: wins / recent.length,
    avgProfitRate: sum / recent.length,
  };
}

function currentScoreThreshold() {
  const stats = recentStats(20);
  const exits = recentExitCounts(12);
  let threshold = cleanNumber(memory.scoreThreshold, algo.baseScoreThreshold);

  if (stats.count >= 5) {
    if (stats.avgProfitRate < -0.4) threshold += 0.25;
    if (stats.winRate < 0.42) threshold += 0.2;
    if (stats.avgProfitRate > 0.8 && stats.winRate > 0.5) threshold -= 0.15;
  }

  if (exits.earlyStops >= 3) threshold += 0.25;
  if (exits.total >= 6 && exits.losses / exits.total >= 0.5) threshold += 0.15;

  return clamp(threshold, algo.minScoreThreshold, algo.maxScoreThreshold);
}

function currentRiskMultiplier() {
  const stats = memory.stats || {};
  let multiplier = cleanNumber(memory.riskMultiplier, 1);

  if (cleanNumber(stats.lossStreak) >= 2) {
    multiplier *= 0.65;
  }

  return clamp(multiplier, algo.minRiskMultiplier, algo.maxRiskMultiplier);
}

function recentExitCounts(limit = 12) {
  const recent = (memory.closedTrades || []).slice(-limit);

  return recent.reduce(
    (counts, trade) => {
      const profitRate = cleanNumber(trade.profitRate);
      if (profitRate > 0) counts.wins += 1;
      if (profitRate <= 0) counts.losses += 1;
      if (trade.exitKind === 'earlyStop') counts.earlyStops += 1;
      if (trade.exitKind === 'takeProfit') counts.takeProfits += 1;
      if (trade.exitKind === 'trailing') counts.trailing += 1;
      return counts;
    },
    {
      wins: 0,
      losses: 0,
      earlyStops: 0,
      takeProfits: 0,
      trailing: 0,
      total: recent.length,
    }
  );
}

function adaptiveTradeLimits(portfolio) {
  const stats = recentStats(16);
  const exits = recentExitCounts(12);
  const risk = currentRiskMultiplier();
  const lossPressure =
    exits.total > 0
      ? exits.losses / exits.total + exits.earlyStops / Math.max(1, exits.total)
      : 0;
  const recentDamage =
    exits.earlyStops >= 2 ||
    exits.losses >= 3 ||
    lossPressure >= 0.65;
  const strongRecent =
    stats.count >= 8 &&
    stats.avgProfitRate > 1.2 &&
    stats.winRate >= 0.6 &&
    exits.earlyStops <= 1 &&
    exits.losses <= exits.wins;

  let maxPositions = Math.round(3 + risk * 3);
  if (strongRecent) {
    maxPositions += 1;
  }
  if (recentDamage) maxPositions -= 1;
  if (exits.earlyStops >= 3) maxPositions -= 1;

  let maxTradeCashRate = 14 + risk * 42;
  if (strongRecent) maxTradeCashRate += 8;
  if (stats.count >= 6 && stats.avgProfitRate < 0) maxTradeCashRate -= 8;
  if (exits.earlyStops >= 2) maxTradeCashRate -= 8;
  if (exits.earlyStops >= 3) maxTradeCashRate -= 8;
  if (lossPressure >= 0.85) maxTradeCashRate -= 6;

  let maxChangeRateOnEntry = 45 + risk * 30;
  if (recentDamage) maxChangeRateOnEntry -= 8;
  if (exits.earlyStops >= 2) maxChangeRateOnEntry -= 12;

  const buyPriceBufferRate = clamp(2 + risk * 2.2, 2.5, 5);
  const tradeCooldownMs =
    algo.globalCooldownMs +
    (exits.earlyStops >= 3 ? 120000 : exits.earlyStops >= 2 ? 60000 : 0) +
    (exits.losses >= 4 ? 90000 : exits.losses >= 3 ? 45000 : 0) +
    (cleanNumber(memory.stats?.lossStreak) > 0 ? 60000 : 0);

  return {
    maxPositions: clamp(maxPositions, algo.minAutoPositions, algo.maxAutoPositions),
    maxTradeCashRate: clamp(
      maxTradeCashRate,
      algo.minTradeCashRate,
      algo.maxTradeCashRate
    ),
    maxChangeRateOnEntry: clamp(maxChangeRateOnEntry, 28, 85),
    buyCashReserve: config.buyCashReserve,
    buyPriceBufferRate,
    maxPortfolioExposureRate: algo.maxPortfolioExposureRate,
    minBuyCash: config.minBuyCash,
    tradeCooldownMs,
    risk,
    lossPressure,
    recentDamage,
  };
}

function adaptiveExitRules() {
  const stats = recentStats(16);
  const exits = recentExitCounts(12);
  const risk = currentRiskMultiplier();
  const lossPressure =
    exits.total > 0
      ? exits.losses / exits.total + exits.earlyStops / Math.max(1, exits.total)
      : 0;

  let stopLossRate = -5.4 - risk * 1.8;
  if (lossPressure >= 0.55) stopLossRate += 1.2;
  if (exits.earlyStops >= 2) stopLossRate += 0.4;

  let takeProfitRate = 5.8 + risk * 2.8;
  if (stats.count >= 6 && stats.avgProfitRate < 0) takeProfitRate -= 0.7;
  if (lossPressure >= 0.55) takeProfitRate -= 0.5;

  let trailingStartRate = 2.6 + risk * 1.5;
  let trailingDropRate = -0.95 - risk * 0.8;
  if (exits.earlyStops >= 2) {
    trailingStartRate -= 0.3;
    trailingDropRate += 0.25;
  }

  let earlyStopLossRate = -3.9 - risk * 1.5;
  if (lossPressure >= 0.55) earlyStopLossRate += 0.8;
  if (exits.earlyStops >= 2) earlyStopLossRate += 0.4;

  return {
    stopLossRate: clamp(stopLossRate, -8.2, -4.0),
    takeProfitRate: clamp(takeProfitRate, 5.0, 9.5),
    trailingStartRate: clamp(trailingStartRate, 2.2, 4.8),
    trailingDropRate: clamp(trailingDropRate, -1.9, -0.7),
    earlyStopMinMs: algo.earlyStopMinMs,
    earlyStopMs: algo.earlyStopMs,
    earlyStopLossRate: clamp(earlyStopLossRate, -6.2, -3.4),
    timeExitNeutralRate: algo.timeExitNeutralRate,
    maxHoldMs: Math.round(algo.maxHoldMs * clamp(0.75 + risk * 0.5, 0.75, 1.35)),
  };
}

function portfolioPressure(portfolio) {
  const holdings = Array.isArray(portfolio?.holdings) ? portfolio.holdings : [];

  return holdings.reduce(
    (pressure, holding) => {
      const profitRate = cleanNumber(
        holding.profitRate ?? holding.profit ?? holding.changeRate
      );

      if (profitRate < 0) pressure.losing += 1;
      if (profitRate <= -3) pressure.weak += 1;
      return pressure;
    },
    {
      total: holdings.length,
      losing: 0,
      weak: 0,
    }
  );
}

function canOpenNewPosition(portfolio) {
  const now = Date.now();

  if (now < buyPausedUntil) {
    console.log(`[LEARN BUY PAUSE] ${Math.ceil((buyPausedUntil - now) / 1000)}s left`);
    return false;
  }

  const limits = adaptiveTradeLimits(portfolio);
  const pressure = portfolioPressure(portfolio);

  if (now - lastAnyBuyAt < limits.tradeCooldownMs) {
    return false;
  }

  if (
    limits.recentDamage &&
    pressure.total >= 3 &&
    pressure.losing >= Math.max(2, Math.ceil(pressure.total * 0.6))
  ) {
    console.log(`[LEARN BUY BLOCK] weak holdings ${pressure.losing}/${pressure.total}`);
    return false;
  }

  if (pressure.weak >= 3) {
    console.log(`[LEARN BUY BLOCK] deep weak holdings ${pressure.weak}/${pressure.total}`);
    return false;
  }

  if (portfolioExposureRate(portfolio) >= algo.maxPortfolioExposureRate) {
    console.log(`[LEARN BUY BLOCK] exposure ${portfolioExposureRate(portfolio).toFixed(1)}%`);
    return false;
  }

  return true;
}

function preFilterCandidates(stocks, portfolio) {
  updateLiveTransitions(stocks);

  if (!canOpenNewPosition(portfolio)) return [];

  const holdings = makeHoldingMap(portfolio);
  const positionCount = portfolio.holdings?.length || 0;
  const limits = adaptiveTradeLimits(portfolio);

  if (positionCount >= limits.maxPositions) return [];

  const usableCash = Math.max(
    0,
    cleanNumber(portfolio.me?.balance) - limits.buyCashReserve
  );
  const maxTradeCash = Math.floor(
    usableCash * (limits.maxTradeCashRate / 100)
  );

  if (usableCash <= 0) return [];
  if (maxTradeCash < limits.minBuyCash) return [];

  return stocks
    .filter(stock => {
      if (stock.isDelisted) return false;
      if (holdings.has(stock.id)) return false;
      if (!canBuy(stock.id, limits.tradeCooldownMs)) return false;

      const currentPrice = cleanNumber(stock.currentPrice);
      if (currentPrice <= 0) return false;
      if (currentPrice > algo.maxEntryPrice) return false;
      if (currentPrice > maxTradeCash) return false;

      const changeRate = cleanNumber(stock.changeRate);
      if (changeRate > limits.maxChangeRateOnEntry) return false;
      if (changeRate < algo.minChangeRateOnEntry) return false;

      const bufferedPrice = Math.ceil(
        currentPrice * (1 + limits.buyPriceBufferRate / 100)
      );

      return usableCash >= bufferedPrice && maxTradeCash >= bufferedPrice;
    })
    .sort((a, b) => {
      const aJustLive = isLiveJustStarted(a.id) ? 1 : 0;
      const bJustLive = isLiveJustStarted(b.id) ? 1 : 0;
      if (bJustLive !== aJustLive) return bJustLive - aJustLive;

      const aLive = a.isLive ? 1 : 0;
      const bLive = b.isLive ? 1 : 0;
      if (bLive !== aLive) return bLive - aLive;

      return Math.abs(cleanNumber(b.changeRate)) - Math.abs(cleanNumber(a.changeRate));
    })
    .slice(0, algo.evaluateTopN);
}

function hardRejectReason(stock, analysis) {
  const risk = currentRiskMultiplier();
  const highChaseRangePosition =
    risk <= 0.6
      ? Math.min(algo.highChaseRangePosition, 0.94)
      : algo.highChaseRangePosition;
  const highChaseMicroMomentum =
    risk <= 0.6
      ? Math.min(algo.highChaseMicroMomentum, 1.8)
      : algo.highChaseMicroMomentum;

  if (analysis.volatility1h > algo.maxVolatility1h) return 'volatility';
  if (analysis.momentum1h < algo.minMomentum1h && analysis.trendConsistency < 0.38) {
    return 'falling';
  }
  if (analysis.momentum1h > algo.maxMomentum1h && analysis.rangePosition > 0.92) {
    return 'overrun';
  }
  if (analysis.pullbackFromHigh < algo.maxPullbackFromHigh) return 'deepPullback';
  if (
    risk <= 0.7 &&
    analysis.rangePosition >= 0.96 &&
    analysis.pullbackFromHigh > -0.35 &&
    analysis.momentum1h >= algo.lateTopMomentum1h &&
    analysis.momentumShort >= algo.lateTopShortMomentum &&
    analysis.momentumRecent >= algo.lateTopRecentMomentum
  ) {
    return 'lateTop';
  }
  if (
    analysis.rangePosition >= highChaseRangePosition &&
    analysis.momentumMicro >= highChaseMicroMomentum
  ) {
    return 'highChase';
  }

  return '';
}

function learnedBuySizing(stock, portfolio, score, threshold, limits) {
  const currentPrice = cleanNumber(stock.currentPrice);
  const asset = portfolioAsset(portfolio);
  const riskMultiplier = currentRiskMultiplier();
  const qualityMultiplier = clamp(0.75 + (score - threshold) / 3, 0.55, 1.45);
  const targetCash = Math.max(
    limits.minBuyCash,
    algo.minPositionCash,
    Math.floor(asset * (algo.positionCashRate / 100) * riskMultiplier * qualityMultiplier)
  );

  if (currentPrice <= 0) {
    return {
      quantity: 1,
      targetCash,
    };
  }

  return {
    quantity: Math.max(1, Math.round(targetCash / currentPrice)),
    targetCash,
  };
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
  const filterStats = new Map();
  const threshold = currentScoreThreshold();
  const limits = adaptiveTradeLimits(portfolio);

  cleanupBuyConfirm();

  const candidates = preFilterCandidates(stocks, portfolio);
  const analyzed = await mapLimit(
    candidates,
    algo.priceFetchConcurrency,
    async stock => {
      try {
        const priceData = await getStockPrices(stock.id, '1h');
        const analysis = analyzePricePoints(priceData.points, stock.currentPrice);

        if (!analysis) {
          filterStats.set('shortHistory', (filterStats.get('shortHistory') || 0) + 1);
          return null;
        }

        const rejectReason = hardRejectReason(stock, analysis);
        if (rejectReason) {
          filterStats.set(rejectReason, (filterStats.get(rejectReason) || 0) + 1);
          return null;
        }

        const features = makeFeatures(stock, analysis);
        const modelScore = weightedScore(features);
        const explorationScore =
          Math.random() < algo.explorationRate
            ? Math.random() * algo.explorationBonus
            : 0;
        const finalScore = modelScore + explorationScore;

        if (finalScore < threshold) {
          filterStats.set('score', (filterStats.get('score') || 0) + 1);
          return null;
        }

        const sizing = learnedBuySizing(stock, portfolio, finalScore, threshold, limits);
        const stockName = stock.channelName || stock.stockName || stock.name || stock.id;
        const dividendNote = hasDividendSystemInfo(stock)
          ? ' / dividendSystem=present'
          : '';

        return {
          type: 'BUY',
          reason:
            `learn score ${finalScore.toFixed(2)} >= ${threshold.toFixed(2)} / ` +
            `1h ${analysis.momentum1h.toFixed(2)}% / ` +
            `short ${analysis.momentumShort.toFixed(2)}% / ` +
            `micro ${analysis.momentumMicro.toFixed(2)}% / ` +
            `recent ${analysis.momentumRecent.toFixed(2)}% / ` +
            `vol ${analysis.volatility1h.toFixed(2)}% / ` +
            `high ${analysis.pullbackFromHigh.toFixed(2)}% / ` +
            `trend ${(analysis.trendConsistency * 100).toFixed(0)}% / ` +
            `range ${(analysis.rangePosition * 100).toFixed(0)}% / ` +
            `risk ${limits.risk.toFixed(2)} / ` +
            `slots ${limits.maxPositions} / cashRate ${limits.maxTradeCashRate.toFixed(0)}%` +
            `${explorationScore > 0 ? ` / explore +${explorationScore.toFixed(2)}` : ''}` +
            `${dividendNote}`,
          stockId: stock.id,
          stockName,
          quantity: sizing.quantity,
          price: stock.currentPrice,
          targetCash: sizing.targetCash,
          maxPositions: limits.maxPositions,
          maxTradeCashRate: limits.maxTradeCashRate,
          buyCashReserve: limits.buyCashReserve,
          buyPriceBufferRate: limits.buyPriceBufferRate,
          maxPortfolioExposureRate: limits.maxPortfolioExposureRate,
          minBuyCash: limits.minBuyCash,
          score: finalScore,
          modelScore,
          explorationScore,
          features,
          analysis,
        };
      } catch (err) {
        console.log(`[PRICE ERROR] ${stock.channelName || stock.id} / ${err.message}`);
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
          `[LEARN BUY WAIT] ${signal.stockName} ` +
          `${confirmCount}/${algo.buyConfirmCount} / ` +
          `score ${signal.score.toFixed(2)} / threshold ${threshold.toFixed(2)}`
        );
      }

      continue;
    }

    buyConfirmMap.delete(signal.stockId);
    signals.push(signal);

    if (signals.length >= algo.maxBuysPerLoop) break;
  }

  console.log(
    `[LEARN BUY DEBUG] candidates=${candidates.length} / ` +
    `ranked=${ranked.length} / signals=${signals.length} / ` +
    `threshold=${threshold.toFixed(2)} / risk=${limits.risk.toFixed(2)} / ` +
    `slots=${limits.maxPositions} / cashRate=${limits.maxTradeCashRate.toFixed(0)}%`
  );

  if (candidates.length > 0 && ranked.length === 0 && filterStats.size > 0) {
    const topFilters = [...filterStats.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => `${key}:${count}`)
      .join(' / ');

    console.log(`[LEARN BUY FILTER] ${topFilters}`);
  }

  return signals;
}

function makeSellSignal(holding, reason, extra = {}) {
  return {
    type: 'SELL',
    reason,
    stockId: holding.stockId,
    stockName: holding.stockName,
    quantity: holding.quantity,
    profitRate: cleanNumber(holding.profitRate),
    ...extra,
  };
}

function getSellSignals(portfolio) {
  const signals = [];
  const currentHoldingIds = new Set();
  const exits = adaptiveExitRules();

  for (const holding of portfolio.holdings || []) {
    const stockId = holding.stockId;
    currentHoldingIds.add(stockId);

    const currentPrice = cleanNumber(holding.currentPrice);
    if (currentPrice <= 0) continue;

    const prevPeak = holdingPeaks.get(stockId) || currentPrice;
    const newPeak = Math.max(prevPeak, currentPrice);
    holdingPeaks.set(stockId, newPeak);

    if (!holdingFirstSeenAt.has(stockId)) {
      holdingFirstSeenAt.set(stockId, Date.now());
    }

    const holdingMs = Date.now() - holdingFirstSeenAt.get(stockId);
    const averagePrice = cleanNumber(holding.averagePrice);
    const profitRate = cleanNumber(holding.profitRate);
    const peakDrawdown = percentChange(newPeak, currentPrice);
    const peakProfitRate = averagePrice > 0
      ? percentChange(averagePrice, newPeak)
      : Math.max(0, profitRate);

    const stopLoss = exits.stopLossRate;

    if (profitRate <= stopLoss) {
      signals.push(makeSellSignal(
        holding,
        `adaptive stop: ${profitRate}% <= ${stopLoss.toFixed(2)}%`,
        { exitKind: 'stop', holdingMs, peakProfitRate, peakDrawdown }
      ));
      continue;
    }

    if (
      peakProfitRate >= exits.trailingStartRate &&
      peakDrawdown <= exits.trailingDropRate
    ) {
      signals.push(makeSellSignal(
        holding,
        `adaptive trailing: peak ${peakProfitRate.toFixed(2)}% / drawdown ${peakDrawdown.toFixed(2)}%`,
        { exitKind: 'trailing', holdingMs, peakProfitRate, peakDrawdown }
      ));
      continue;
    }

    if (profitRate >= exits.takeProfitRate) {
      signals.push(makeSellSignal(
        holding,
        `adaptive take profit: ${profitRate}%`,
        { exitKind: 'takeProfit', holdingMs, peakProfitRate, peakDrawdown }
      ));
      continue;
    }

    if (
      holdingMs >= exits.earlyStopMinMs &&
      holdingMs <= exits.earlyStopMs &&
      profitRate <= exits.earlyStopLossRate
    ) {
      signals.push(makeSellSignal(
        holding,
        `early failure stop: ${Math.round(holdingMs / 1000)}s / ${profitRate}%`,
        { exitKind: 'earlyStop', holdingMs, peakProfitRate, peakDrawdown }
      ));
      continue;
    }

    if (
      holdingMs >= exits.maxHoldMs &&
      profitRate >= exits.timeExitNeutralRate
    ) {
      signals.push(makeSellSignal(
        holding,
        `time profit exit: ${Math.round(holdingMs / 1000)}s / ${profitRate}%`,
        { exitKind: 'timeProfit', holdingMs, peakProfitRate, peakDrawdown }
      ));
      continue;
    }

    if (
      holdingMs >= exits.maxHoldMs &&
      profitRate <= exits.stopLossRate
    ) {
      signals.push(makeSellSignal(
        holding,
        `time loss exit: ${Math.round(holdingMs / 1000)}s / ${profitRate}%`,
        { exitKind: 'timeLoss', holdingMs, peakProfitRate, peakDrawdown }
      ));
      continue;
    }

    if (
      holdingMs >= exits.maxHoldMs * 2 &&
      profitRate >= exits.timeExitNeutralRate
    ) {
      signals.push(makeSellSignal(
        holding,
        `time neutral exit: ${Math.round(holdingMs / 1000)}s / ${profitRate}%`,
        { exitKind: 'timeNeutral', holdingMs, peakProfitRate, peakDrawdown }
      ));
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

function updateWeights(features, reward) {
  const nextWeights = {
    ...DEFAULT_WEIGHTS,
    ...(memory.weights || {}),
  };

  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const current = cleanNumber(nextWeights[key], DEFAULT_WEIGHTS[key]);
    const baseline = DEFAULT_WEIGHTS[key];
    const featureValue = key === 'bias' ? 0.25 : cleanNumber(features[key]);
    const learned = current + algo.learningRate * reward * featureValue;
    const decayed = baseline + (learned - baseline) * (1 - algo.weightDecay);
    nextWeights[key] = clamp(decayed, -4, 5);
  }

  memory.weights = nextWeights;
}

function recordClosedTrade(signal, profitRate, reward, openTrade) {
  memory.closedTrades = [
    ...(memory.closedTrades || []),
    {
      stockId: signal.stockId,
      stockName: signal.stockName,
      boughtAt: openTrade?.boughtAt || null,
      soldAt: new Date().toISOString(),
      score: openTrade?.score ?? null,
      profitRate,
      reward,
      exitKind: signal.exitKind || 'unknown',
      reason: signal.reason,
    },
  ].slice(-algo.memoryMaxClosedTrades);
}

function learnFromClosedTrade(signal) {
  const stockId = String(signal.stockId);
  const openTrade = memory.openTrades?.[stockId];
  const profitRate = cleanNumber(
    signal.executedProfitRate ?? signal.profitRate
  );
  const reward = clamp(profitRate / algo.rewardScaleRate, -1.25, 1.25);

  memory.stats.sells += 1;
  memory.stats.realizedProfitRateSum += profitRate;

  if (profitRate > 0) {
    memory.stats.wins += 1;
    memory.stats.winStreak += 1;
    memory.stats.lossStreak = 0;
  } else {
    memory.stats.losses += 1;
    memory.stats.lossStreak += 1;
    memory.stats.winStreak = 0;
  }

  if (openTrade?.features) {
    updateWeights(openTrade.features, reward);
  }

  const thresholdDelta = profitRate > 0
    ? -0.03 * Math.min(1, Math.max(0, reward))
    : 0.08 * Math.min(1.5, Math.abs(reward));

  memory.scoreThreshold = clamp(
    cleanNumber(memory.scoreThreshold, algo.baseScoreThreshold) + thresholdDelta,
    algo.minScoreThreshold,
    algo.maxScoreThreshold
  );

  const riskDelta = profitRate > 0
    ? 0.03 * Math.min(1, reward)
    : -0.08 * Math.min(1.5, Math.abs(reward));

  memory.riskMultiplier = clamp(
    cleanNumber(memory.riskMultiplier, 1) + riskDelta,
    algo.minRiskMultiplier,
    algo.maxRiskMultiplier
  );

  recordClosedTrade(signal, profitRate, reward, openTrade);

  if (memory.openTrades) {
    delete memory.openTrades[stockId];
  }

  saveMemory();

  console.log(
    `[LEARN UPDATE] ${signal.stockName} profit=${profitRate.toFixed(2)}% / ` +
    `reward=${reward.toFixed(2)} / threshold=${memory.scoreThreshold.toFixed(2)} / ` +
    `risk=${memory.riskMultiplier.toFixed(2)}`
  );
}

function recordOpenTrade(signal) {
  memory.openTrades = memory.openTrades || {};
  memory.openTrades[String(signal.stockId)] = {
    stockId: signal.stockId,
    stockName: signal.stockName,
    boughtAt: new Date().toISOString(),
    price: signal.executedPrice ?? signal.price ?? null,
    quantity: signal.executedQuantity ?? signal.quantity ?? null,
    score: signal.score ?? null,
    modelScore: signal.modelScore ?? null,
    explorationScore: signal.explorationScore ?? 0,
    features: signal.features || {},
    analysis: signal.analysis || {},
  };

  memory.stats.buys += 1;
  saveMemory();
}

function markSignalTraded(signal) {
  if (signal.type === 'BUY') {
    lastAnyBuyAt = Date.now();
    markBought(signal.stockId);
    recordOpenTrade(signal);
    return;
  }

  if (signal.type === 'SELL') {
    learnFromClosedTrade(signal);

    const recentExits = recentExitCounts(8);

    if (
      signal.exitKind === 'earlyStop' &&
      cleanNumber(signal.executedProfitRate ?? signal.profitRate) < 0
    ) {
      const pauseMs =
        algo.earlyStopPauseMs +
        Math.min(3, Math.max(0, recentExits.earlyStops - 1)) * 45000 +
        (recentExits.losses >= 3 ? 60000 : 0);

      buyPausedUntil = Math.max(
        buyPausedUntil,
        Date.now() + pauseMs
      );
      console.log(`[LEARN BUY PAUSE] early stop loss, pausing ${Math.round(pauseMs / 1000)}s`);
    }

    if (memory.stats.lossStreak >= algo.lossPauseCount) {
      const pauseMs =
        algo.lossPauseMs +
        (recentExits.earlyStops >= 2 ? 60000 : 0) +
        (recentExits.losses >= 4 ? 60000 : 0);

      buyPausedUntil = Math.max(buyPausedUntil, Date.now() + pauseMs);
      console.log(`[LEARN BUY PAUSE] repeated losses, pausing ${Math.round(pauseMs / 1000)}s`);
    }

    markSold(signal.stockId);
  }
}

module.exports = {
  getBuySignals,
  getSellSignals,
  markSignalTraded,
};
