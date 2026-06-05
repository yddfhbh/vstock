require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');

async function main() {
  const authPath = path.resolve(config.authStateFile);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });

  console.log('Chrome 원격 디버깅 포트에 연결 중...');
  const browser = await chromium.connectOverCDP(config.chromeCdpUrl);

  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('virtual-stock.xyz'));

  if (!page) {
    page = await context.newPage();
    await page.goto(`${config.baseUrl}/profile`, {
      waitUntil: 'domcontentloaded',
    });
  }

  console.log('현재 페이지:', page.url());

  const userResponsePromise = page.waitForResponse(
    response => response.url().includes('/api/users/me'),
    { timeout: 15000 }
  ).catch(() => null);

  await page.reload({
    waitUntil: 'domcontentloaded',
  });

  const userResponse = await userResponsePromise;
  const text = userResponse ? await userResponse.text() : '';

  let result = {
    status: userResponse?.status() || 0,
    text,
  };

  try {
    result = {
      status: result.status,
      json: JSON.parse(text),
    };
  } catch {
    // Keep text result for diagnostics.
  }

  console.log('로그인 확인 결과:', result);

  if (result.status !== 200 || !result.json?.success) {
    console.log('로그인 확인 실패. Chrome에서 virtual-stock.xyz/profile 로그인 상태인지 확인해줘.');
    await browser.close();
    process.exit(1);
  }

  await context.storageState({
    path: authPath,
    indexedDB: true,
  });

  console.log(`로그인 세션 저장 완료: ${authPath}`);

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
