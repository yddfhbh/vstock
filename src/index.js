let isLoopRunning = false;
let loopIntervalId = null;

const config = require('./config');

const {
  getPortfolio,
  getStocksPage,
  getStockDetail,
  getStockPrices,
  buyStock,
  sellStock,
} = require('./api');

const {
  getBuySignals,
  getSellSignals,
  markSignalTraded,
} = require('./strategy');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowText() {
  return new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
  });
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function shutdown(reason, code = 0) {
  console.log(`[SHUTDOWN] ${reason}`);

  if (loopIntervalId) {
    clearInterval(loopIntervalId);
    loopIntervalId = null;
  }

  process.exit(code);
}

process.once('SIGINT', () => {
  shutdown('SIGINT received', 0);
});

process.once('SIGTERM', () => {
  shutdown('SIGTERM received', 0);
});

process.on('uncaughtException', err => {
  console.error(`[FATAL] uncaughtException: ${err.stack || err.message}`);
  shutdown('uncaught exception', 1);
});

process.on('unhandledRejection', err => {
  console.error(`[FATAL] unhandledRejection: ${err?.stack || err}`);
  shutdown('unhandled rejection', 1);
});

process.on('beforeExit', code => {
  console.log(`[SHUTDOWN] event loop became empty / code=${code}`);
});

async function getScannedStocks() {
  const all = [];
  const batchSize = 5;

  for (let start = 0; start < config.scanPages; start += batchSize) {
    const pages = [];

    for (
      let page = start;
      page < Math.min(start + batchSize, config.scanPages);
      page++
    ) {
      pages.push(page);
    }

    const results = await Promise.all(
      pages.map(page => getStocksPage(page, config.pageSize))
    );

    for (const data of results) {
      if (data?.items) {
        all.push(...data.items);
      }
    }

    const last = results[results.length - 1];
    if (!last?.hasNext) break;

    await sleep(300);
  }

  const unique = new Map();

  for (const stock of all) {
    unique.set(stock.id, stock);
  }

  return [...unique.values()];
}

function printStatus(portfolio, stocks) {
  const liveCount = stocks.filter(stock => stock.isLive).length;
  const balance = toNumber(portfolio.me?.balance);
  const totalAsset = toNumber(portfolio.me?.totalAsset);

  console.log(
    `\n[${nowText()}] scanned ${stocks.length} / LIVE ${liveCount} / ` +
    `balance ${balance.toLocaleString()} / total ${totalAsset.toLocaleString()}`
  );

  if (!portfolio.holdings || portfolio.holdings.length === 0) {
    console.log('  holdings: none');
    return;
  }

  for (const holding of portfolio.holdings) {
    console.log(
      `  holding: ${holding.stockName} ${holding.quantity} shares / ` +
      `avg ${toNumber(holding.averagePrice).toLocaleString()} / ` +
      `now ${toNumber(holding.currentPrice).toLocaleString()} / ` +
      `profit ${holding.profitRate}%`
    );
  }
}

async function executeBuySignal(signal) {
  const freshPortfolio = await getPortfolio();
  const holdings = freshPortfolio.holdings || [];
  const alreadyHolding = holdings.some(h => h.stockId === signal.stockId);
  const maxPositions = toNumber(signal.maxPositions, config.maxPositions);

  if (alreadyHolding) {
    console.log(`[BUY SKIP] already holding ${signal.stockName}`);
    return;
  }

  if (holdings.length >= maxPositions) {
    console.log(
      `[BUY SKIP] max positions reached: ${holdings.length}/${maxPositions}`
    );
    return;
  }

  const freshStock = await getStockDetail(signal.stockId);
  const balance = toNumber(freshPortfolio.me?.balance);
  const currentPrice = toNumber(freshStock.currentPrice || signal.price);

  if (currentPrice <= 0) {
    console.log(`[BUY SKIP] invalid current price: ${signal.stockName} / ${currentPrice}`);
    return;
  }

  const buyCashReserve = toNumber(signal.buyCashReserve, config.buyCashReserve);
  const minBuyCash = toNumber(signal.minBuyCash, config.minBuyCash);
  const maxTradeCashRate = toNumber(
    signal.maxTradeCashRate,
    config.maxBuyCashPerTradeRate
  );
  const buyPriceBufferRate = toNumber(
    signal.buyPriceBufferRate,
    config.buyPriceBufferRate
  );
  const usableCash = Math.max(0, balance - buyCashReserve);

  if (usableCash <= 0) {
    console.log(
      `[BUY SKIP] no usable cash: balance ${balance.toLocaleString()} / ` +
      `reserve ${buyCashReserve.toLocaleString()}`
    );
    return;
  }

  const maxTradeCash = Math.floor(
    usableCash * (maxTradeCashRate / 100)
  );

  if (maxTradeCash < minBuyCash) {
    console.log(
      `[BUY SKIP] trade cash too small: usable ${usableCash.toLocaleString()} / ` +
      `limit ${maxTradeCash.toLocaleString()} / min ${minBuyCash.toLocaleString()}`
    );
    return;
  }

  const bufferedPrice = Math.ceil(
    currentPrice * (1 + buyPriceBufferRate / 100)
  );
  const affordableQuantityByBalance = Math.floor(usableCash / bufferedPrice);
  const affordableQuantityByLimit = Math.floor(maxTradeCash / bufferedPrice);

  const targetCash = toNumber(signal.targetCash);
  const targetQuantity = targetCash > 0
    ? Math.max(toNumber(signal.quantity), Math.round(targetCash / currentPrice))
    : toNumber(signal.quantity);

  const finalQuantity = Math.min(
    targetQuantity,
    affordableQuantityByBalance,
    affordableQuantityByLimit
  );

  if (finalQuantity <= 0) {
    console.log(
      `[BUY SKIP] insufficient cash: balance ${balance.toLocaleString()} / ` +
      `price ${currentPrice.toLocaleString()} / buffered ${bufferedPrice.toLocaleString()} / ` +
      `usable ${usableCash.toLocaleString()} / limit ${maxTradeCash.toLocaleString()}`
    );
    return;
  }

  console.log(
    `[BUY FINAL] ${signal.stockName} ${finalQuantity} shares / ` +
    `price ${currentPrice.toLocaleString()} / usable ${usableCash.toLocaleString()} / ` +
    `limit ${maxTradeCash.toLocaleString()} / cashRate ${maxTradeCashRate.toFixed(0)}%` +
    `${targetCash > 0 ? ` / target ${targetCash.toLocaleString()}` : ''}`
  );

  await buyStock(signal.stockId, finalQuantity);
  markSignalTraded({
    ...signal,
    executedPrice: currentPrice,
    executedQuantity: finalQuantity,
  });
}

async function executeSellSignal(signal) {
  const freshPortfolio = await getPortfolio();
  const holding = (freshPortfolio.holdings || [])
    .find(h => h.stockId === signal.stockId);

  if (!holding) {
    console.log(`[SELL SKIP] not holding: ${signal.stockName}`);
    return;
  }

  const finalQuantity = Math.min(
    toNumber(signal.quantity),
    toNumber(holding.quantity)
  );

  if (finalQuantity <= 0) {
    console.log(`[SELL SKIP] no quantity to sell: ${signal.stockName}`);
    return;
  }

  const executedProfitRate = toNumber(holding.profitRate, toNumber(signal.profitRate));

  console.log(
    `[SELL FINAL] ${signal.stockName} ${finalQuantity} shares / ` +
    `profit ${executedProfitRate}%`
  );

  await sellStock(signal.stockId, finalQuantity);
  markSignalTraded({
    ...signal,
    executedProfitRate,
    executedQuantity: finalQuantity,
  });
}

async function executeSignal(signal) {
  console.log(
    `[SIGNAL] ${signal.type} ${signal.stockName} ${signal.quantity} shares / ` +
    `reason: ${signal.reason}`
  );

  if (signal.type === 'BUY') {
    await executeBuySignal(signal);
    return;
  }

  if (signal.type === 'SELL') {
    await executeSellSignal(signal);
    return;
  }

  console.log(`[WARN] unknown signal type: ${signal.type}`);
}

async function mainLoop() {
  if (isLoopRunning) {
    console.log('[SKIP] previous loop is still running');
    return;
  }

  isLoopRunning = true;

  try {
    const portfolio = await getPortfolio();
    const stocks = await getScannedStocks();

    printStatus(portfolio, stocks);

    const sellSignals = getSellSignals(portfolio);
    for (const signal of sellSignals) {
      await executeSignal(signal);
      await sleep(500);
    }

    const latestPortfolio = await getPortfolio();
    const buySignals = await getBuySignals(stocks, latestPortfolio, getStockPrices);
    for (const signal of buySignals) {
      await executeSignal(signal);
      await sleep(500);
    }
  } catch (err) {
    console.error(`[ERROR] ${err.stack || err.message}`);
  } finally {
    isLoopRunning = false;
  }
}

async function start() {
  console.log('V-STOCK bot started');
  console.log(`DRY_RUN=${config.dryRun}`);
  console.log(`ENABLE_TRADING=${config.enableTrading}`);
  console.log(`POLL_MS=${config.pollMs}`);
  console.log(`SCAN_PAGES=${config.scanPages}`);
  console.log(`PAGE_SIZE=${config.pageSize}`);
  console.log('STRATEGY_LIMITS=auto');
  console.log(`MIN_BUY_CASH=${config.minBuyCash}`);
  console.log(`DIVIDEND_SYSTEM_AVAILABLE=${config.dividendSystemAvailable}`);

  await mainLoop();

  loopIntervalId = setInterval(mainLoop, config.pollMs);
}

start();
