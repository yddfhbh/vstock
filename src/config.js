require('dotenv').config();

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true';
}

const config = {
  baseUrl: process.env.VSTOCK_BASE_URL || 'https://virtual-stock.xyz',
  chromeCdpUrl: process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222',

  dryRun: boolEnv('DRY_RUN', true),
  enableTrading: boolEnv('ENABLE_TRADING', false),

  pollMs: numberEnv('POLL_MS', 30000),
  scanPages: numberEnv('SCAN_PAGES', 3),
  pageSize: numberEnv('PAGE_SIZE', 50),

  buyQuantity: numberEnv('BUY_QUANTITY', 1),
  maxPositions: numberEnv('MAX_POSITIONS', 3),
  maxChangeRateOnEntry: numberEnv('MAX_CHANGE_RATE_ON_ENTRY', 120),

  buyCashReserve: numberEnv('BUY_CASH_RESERVE', 0),
  buyPriceBufferRate: numberEnv('BUY_PRICE_BUFFER_RATE', 5),

  maxBuyCashPerTradeRate: numberEnv('MAX_BUY_CASH_PER_TRADE_RATE', 12),
  minBuyCash: numberEnv('MIN_BUY_CASH', 8000),

  takeProfitRate: numberEnv('TAKE_PROFIT_RATE', 5),
  stopLossRate: numberEnv('STOP_LOSS_RATE', -5),
  tradeCooldownMs: numberEnv('TRADE_COOLDOWN_MS', 30000),

  maxHoldMs: numberEnv('MAX_HOLD_MS', 420000),
  timeExitProfitRate: numberEnv('TIME_EXIT_PROFIT_RATE', 0.5),
  timeExitLossRate: numberEnv('TIME_EXIT_LOSS_RATE', -1.2),
  minShortMomentum: numberEnv('MIN_SHORT_MOMENTUM', 1.2),
};

module.exports = config;