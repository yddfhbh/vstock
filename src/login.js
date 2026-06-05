require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const config = require('./config');

function waitEnter(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const authPath = path.resolve(config.authStateFile);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('브라우저가 열리면 V-STOCK에 직접 로그인해.');
  await page.goto(`${config.baseUrl}/profile`, {
    waitUntil: 'domcontentloaded',
  });

  await waitEnter('\n로그인이 끝나고 사이트에서 내 프로필/잔고가 보이면 Enter를 눌러줘... ');

  const userResponsePromise = page.waitForResponse(
    response => response.url().includes('/api/users/me'),
    { timeout: 15000 }
  ).catch(() => null);

  await page.reload({
    waitUntil: 'domcontentloaded',
  });

  const userResponse = await userResponsePromise;
  const text = userResponse ? await userResponse.text() : '';

  let me = {
    status: userResponse?.status() || 0,
    text,
  };

  try {
    me = {
      status: me.status,
      json: JSON.parse(text),
    };
  } catch {
    // Keep text result for diagnostics.
  }

  console.log('로그인 확인 결과:', me);

  if (me.status !== 200 || !me.json?.success) {
    console.log('로그인 확인이 실패했어. 그래도 세션은 저장할게.');
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
