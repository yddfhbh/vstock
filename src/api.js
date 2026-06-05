const { chromium } = require('playwright');
const config = require('./config');

let browser;
let context;
let page;
let capturedHeaders = null;
let capturedAt = 0;

const AUTH_HEADER_TTL_MS = 20 * 60 * 1000;

async function ensurePage() {
  if (page) return page;

  browser = await chromium.connectOverCDP(config.chromeCdpUrl);
  context = browser.contexts()[0];

  if (!context) {
    throw new Error('Chrome context를 찾지 못했어. 원격 디버깅 Chrome을 먼저 켜줘.');
  }

  page =
    context.pages().find(p => p.url().includes('virtual-stock.xyz')) ||
    context.pages()[0] ||
    await context.newPage();

  if (!page.url().includes('virtual-stock.xyz')) {
    await page.goto(`${config.baseUrl}/profile`, {
      waitUntil: 'domcontentloaded',
    });
  }

  return page;
}

function cleanRequestHeaders(headers) {
  const cleaned = {};

  const blocked = new Set([
    'host',
    'connection',
    'content-length',
    'accept-encoding',
  ]);

  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();

    if (!value) continue;
    if (blocked.has(key)) continue;

    cleaned[key] = value;
  }

  return cleaned;
}

async function captureRealApiHeaders() {
  const p = await ensurePage();

  console.log('[AUTH] 로그인된 Chrome에서 실제 API 요청 헤더 캡처 중...');

  const capturedPromise = new Promise(resolve => {
    const timer = setTimeout(() => {
      p.off('request', onRequest);
      resolve(null);
    }, 15000);

    function onRequest(request) {
      const url = request.url();

      if (!url.startsWith(`${config.baseUrl}/api/`)) return;
      if (url.includes('/heartbeat')) return;
      if (url.includes('/unread-count')) return;
      if (url.includes('/latest')) return;

      const isGoodTarget =
        url.includes('/api/summary/portfolio') ||
        url.includes('/api/stocks') ||
        url.includes('/api/users');

      if (!isGoodTarget) return;

      const headers = cleanRequestHeaders(request.headers());

      if (!headers.authorization) return;

      clearTimeout(timer);
      p.off('request', onRequest);

      resolve({
        url,
        headers,
      });
    }

    p.on('request', onRequest);
  });

  await p.goto(`${config.baseUrl}/portfolio`, {
    waitUntil: 'domcontentloaded',
  });

  const captured = await capturedPromise;

  if (!captured) {
    throw new Error(
      '실제 API 헤더 캡처 실패. 원격 디버깅 Chrome에서 virtual-stock.xyz에 로그인된 상태인지 확인해줘.'
    );
  }

  capturedHeaders = captured.headers;
  capturedAt = Date.now();

  console.log('[AUTH] 캡처한 실제 요청:', captured.url.replace(config.baseUrl, ''));
  console.log('[AUTH] 캡처된 헤더 키:', Object.keys(capturedHeaders).join(', '));
}

async function ensureAuthHeaders() {
  const expired = Date.now() - capturedAt > AUTH_HEADER_TTL_MS;

  if (!capturedHeaders || expired) {
    await captureRealApiHeaders();
  }
}

function buildHeaders(method, extra = {}) {
  const headers = {
    ...capturedHeaders,
    accept: capturedHeaders?.accept || 'application/json, text/plain, */*',
    origin: config.baseUrl,
    referer: `${config.baseUrl}/`,
    ...extra,
  };

  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
  } else {
    delete headers['content-type'];
  }

  return headers;
}

async function rawApiFetch(pathValue, options = {}) {
  const method = options.method || 'GET';

  const res = await fetch(`${config.baseUrl}${pathValue}`, {
    method,
    headers: buildHeaders(method, options.headers),
    body: options.body,
  });

  const text = await res.text();

  if (method !== 'GET' || res.status >= 400) {
    console.log(`[API] ${method} ${pathValue} -> HTTP ${res.status}`);
  }

  return {
    status: res.status,
    ok: res.ok,
    text,
  };
}

async function apiFetch(pathValue, options = {}) {
  await ensureAuthHeaders();

  let result = await rawApiFetch(pathValue, options);

  if (result.status === 401 || result.status === 403 || result.status === 500) {
    console.log('[AUTH] 인증/서버 오류 감지. 실제 API 헤더 다시 캡처 후 재시도...');
    capturedHeaders = null;
    await ensureAuthHeaders();
    result = await rawApiFetch(pathValue, options);
  }

  const method = options.method || 'GET';

  if (!result.text) {
    throw new Error(`빈 응답: HTTP ${result.status} / ${method} ${pathValue}`);
  }

  let json;
  try {
    json = JSON.parse(result.text);
  } catch {
    throw new Error(
      `JSON 파싱 실패: HTTP ${result.status} / ${method} ${pathValue} / body=${result.text.slice(0, 300)}`
    );
  }

  if (!result.ok || json.success === false) {
    throw new Error(
      `API 실패: HTTP ${result.status} / ${method} ${pathValue} / ${JSON.stringify(json).slice(0, 500)}`
    );
  }

  return json.data;
}

async function getMe() {
  return apiFetch('/api/users/me');
}

async function getPortfolio() {
  return apiFetch('/api/summary/portfolio');
}

async function getStocksPage(page = 0, size = config.pageSize) {
  return apiFetch(
    `/api/stocks?sort=change_rate&direction=desc&page=${page}&size=${size}`
  );
}

async function getStockDetail(stockId) {
  return apiFetch(`/api/stocks/${stockId}`);
}

async function getStockPrices(stockId, range = '1h') {
  return apiFetch(`/api/stocks/${stockId}/prices?range=${encodeURIComponent(range)}`);
}

async function buyStock(stockId, quantity) {
  const payload = { stockId, quantity };

  if (config.dryRun || !config.enableTrading) {
    console.log('[DRY-RUN BUY]', payload);
    return {
      dryRun: true,
      type: 'BUY',
      ...payload,
    };
  }

  return apiFetch('/api/trades/buy', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function sellStock(stockId, quantity) {
  const payload = { stockId, quantity };

  if (config.dryRun || !config.enableTrading) {
    console.log('[DRY-RUN SELL]', payload);
    return {
      dryRun: true,
      type: 'SELL',
      ...payload,
    };
  }

  return apiFetch('/api/trades/sell', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

module.exports = {
  getMe,
  getPortfolio,
  getStocksPage,
  getStockDetail,
  getStockPrices,
  buyStock,
  sellStock,
};
