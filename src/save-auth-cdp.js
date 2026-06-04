require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');

async function main() {
  const authPath = path.resolve(config.authStateFile);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });

  console.log('Chrome 원격 디버깅 포트에 연결 중...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

  const context = browser.contexts()[0];
  let page = context.pages().find(p => p.url().includes('virtual-stock.xyz'));

  if (!page) {
    page = await context.newPage();
    await page.goto(`${config.baseUrl}/profile`, {
      waitUntil: 'domcontentloaded',
    });
  }

  console.log('현재 페이지:', page.url());

  const result = await page.evaluate(async () => {
    const res = await fetch('/api/me', {
      credentials: 'include',
    });

    const text = await res.text();

    try {
      return {
        status: res.status,
        json: JSON.parse(text),
      };
    } catch {
      return {
        status: res.status,
        text,
      };
    }
  });

  console.log('로그인 확인 결과:', result);

  if (result.status !== 200 || !result.json?.success) {
    console.log('로그인 확인 실패. Chrome에서 virtual-stock.xyz/profile 로그인 상태인지 확인해줘.');
    await browser.close();
    process.exit(1);
  }

  await context.storageState({
    path: authPath,
  });

  console.log(`로그인 세션 저장 완료: ${authPath}`);

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
