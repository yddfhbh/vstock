require('dotenv').config();

const { chromium } = require('playwright');
const config = require('./config');

async function main() {
  console.log('Chrome CDP 연결 중:', config.chromeCdpUrl);

  const browser = await chromium.connectOverCDP(config.chromeCdpUrl);
  const context = browser.contexts()[0];

  if (!context) {
    throw new Error('Chrome context 없음. 원격 디버깅 Chrome을 먼저 켜야 함.');
  }

  const pages = context.pages();
  console.log('열려있는 페이지:');
  for (const p of pages) {
    console.log('-', p.url());
  }

  console.log('\n이제 원격 디버깅 Chrome에서 virtual-stock.xyz/profile 또는 /portfolio를 직접 새로고침해.');
  console.log('30초 동안 /api 요청을 감시함. 헤더 값은 출력 안 하고 키 이름만 출력함.\n');

  const onRequest = request => {
    const url = request.url();

    if (!url.includes('virtual-stock.xyz/api/')) return;

    const u = new URL(url);
    const headers = request.headers();

    console.log('[API REQUEST]', u.pathname + u.search);
    console.log('method:', request.method());
    console.log('header keys:', Object.keys(headers).join(', '));
    console.log('has authorization:', Boolean(headers.authorization));
    console.log('has cookie:', Boolean(headers.cookie));
    console.log('');
  };

  context.on('request', onRequest);

  await new Promise(resolve => setTimeout(resolve, 30000));

  context.off('request', onRequest);
  console.log('감시 종료');

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});