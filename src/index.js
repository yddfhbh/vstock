let isLoopRunning = false;

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

  console.log(
    `\n[${nowText()}] 감시 ${stocks.length}개 / LIVE ${liveCount}개 / 잔고 ${portfolio.me.balance.toLocaleString()}원 / 총자산 ${portfolio.me.totalAsset.toLocaleString()}원`
  );

  if (!portfolio.holdings || portfolio.holdings.length === 0) {
    console.log('  보유 종목 없음');
    return;
  }

  for (const holding of portfolio.holdings) {
    console.log(
      `  보유: ${holding.stockName} ${holding.quantity}주 / 평단 ${holding.averagePrice.toLocaleString()} / 현재 ${holding.currentPrice.toLocaleString()} / 수익률 ${holding.profitRate}%`
    );
  }
}

async function executeBuySignal(signal) {
  const freshPortfolio = await getPortfolio();

  const holdings = freshPortfolio.holdings || [];

  if (holdings.length >= config.maxPositions) {
    console.log(
      `[BUY SKIP] 최대 보유 종목 수 도달: ${holdings.length}/${config.maxPositions}`
    );
    return;
  }

  const alreadyHolding = holdings.some(h => h.stockId === signal.stockId);

  if (alreadyHolding) {
    console.log(`[BUY SKIP] 이미 보유 중: ${signal.stockName}`);
    return;
  }

  const freshStock = await getStockDetail(signal.stockId);

  const balance = Number(freshPortfolio.me.balance || 0);
  const currentPrice = Number(freshStock.currentPrice || signal.price || 0);

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    console.log(`[BUY SKIP] 현재가 이상함: ${signal.stockName} / ${currentPrice}`);
    return;
  }

  const usableCash = Math.max(0, balance - config.buyCashReserve);

  if (usableCash <= 0) {
    console.log(
      `[BUY SKIP] 사용 가능 현금 없음: 잔고 ${balance.toLocaleString()}원 / 예비현금 ${config.buyCashReserve.toLocaleString()}원`
    );
    return;
  }

  const maxTradeCash = Math.floor(
    usableCash * (config.maxBuyCashPerTradeRate / 100)
  );

  if (maxTradeCash < config.minBuyCash) {
    console.log(
      `[BUY SKIP] 매수 가능 현금이 너무 적음: 사용가능 ${usableCash.toLocaleString()}원 / 거래한도 ${maxTradeCash.toLocaleString()}원 / 최소 ${config.minBuyCash.toLocaleString()}원`
    );
    return;
  }

  const bufferedPrice = Math.ceil(
    currentPrice * (1 + config.buyPriceBufferRate / 100)
  );

  const affordableQuantityByBalance = Math.floor(usableCash / bufferedPrice);
  const affordableQuantityByLimit = Math.floor(maxTradeCash / bufferedPrice);

  const finalQuantity = Math.min(
    signal.quantity,
    affordableQuantityByBalance,
    affordableQuantityByLimit
  );

  if (finalQuantity <= 0) {
    console.log(
      `[BUY SKIP] 거래한도 또는 잔액 부족: ` +
      `잔고 ${balance.toLocaleString()}원 / ` +
      `현재가 ${currentPrice.toLocaleString()}원 / ` +
      `버퍼가 ${bufferedPrice.toLocaleString()}원 / ` +
      `사용가능현금 ${usableCash.toLocaleString()}원 / ` +
      `거래한도 ${maxTradeCash.toLocaleString()}원`
    );
    return;
  }

  console.log(
    `[BUY FINAL] ${signal.stockName} ${finalQuantity}주 / ` +
    `현재가 ${currentPrice.toLocaleString()}원 / ` +
    `사용가능현금 ${usableCash.toLocaleString()}원 / ` +
    `거래한도 ${maxTradeCash.toLocaleString()}원`
  );

  await buyStock(signal.stockId, finalQuantity);
  markSignalTraded(signal);
}

async function executeSellSignal(signal) {
  const freshPortfolio = await getPortfolio();
  const holding = (freshPortfolio.holdings || [])
    .find(h => h.stockId === signal.stockId);

  if (!holding) {
    console.log(`[SELL SKIP] 보유 중 아님: ${signal.stockName}`);
    return;
  }

  const finalQuantity = Math.min(signal.quantity, holding.quantity);

  if (finalQuantity <= 0) {
    console.log(`[SELL SKIP] 매도 가능 수량 없음: ${signal.stockName}`);
    return;
  }

  console.log(
    `[SELL FINAL] ${signal.stockName} ${finalQuantity}주 / 현재 수익률 ${holding.profitRate}%`
  );

  await sellStock(signal.stockId, finalQuantity);
  markSignalTraded(signal);
}

async function executeSignal(signal) {
  console.log(
    `[SIGNAL] ${signal.type} ${signal.stockName} ${signal.quantity}주 / 이유: ${signal.reason}`
  );

  if (signal.type === 'BUY') {
    await executeBuySignal(signal);
    return;
  }

  if (signal.type === 'SELL') {
    await executeSellSignal(signal);
    return;
  }

  console.log(`[WARN] 알 수 없는 signal type: ${signal.type}`);
}

async function mainLoop() {
  if (isLoopRunning) {
    console.log('[SKIP] 이전 루프가 아직 실행 중이라 이번 루프는 건너뜀');
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
    console.error(`[ERROR] ${err.message}`);
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
  console.log(`MAX_POSITIONS=${config.maxPositions}`);
  console.log(`MAX_BUY_CASH_PER_TRADE_RATE=${config.maxBuyCashPerTradeRate}`);
  console.log(`MIN_BUY_CASH=${config.minBuyCash}`);

  await mainLoop();

  setInterval(mainLoop, config.pollMs);
}

start();