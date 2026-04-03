import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const repo = 'C:/Users/TheunisvanNiekerk/Code/Web_Transcription';
const port = 3012;
const baseUrl = `http://localhost:${port}`;
const env = { ...process.env, APP_DATA_DIR: `${repo}/data-playback-debug`, PORT: String(port) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Server did not become healthy in time.');
}
const server = spawn(process.execPath, ['server/index.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (chunk) => process.stdout.write(`server:${chunk}`));
server.stderr.on('data', (chunk) => process.stdout.write(`servererr:${chunk}`));
try {
  await waitForHealth();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log(`console:${msg.type()}:${msg.text()}`));
  page.on('pageerror', (error) => console.log(`pageerror:${error.message}`));
  page.on('requestfailed', (request) => console.log(`requestfailed:${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/titles/') || url.includes('/api/auth') || url.includes('/api/state') || url.includes('/checkout')) {
      console.log(`response:${response.status()} ${url}`);
    }
  });
  await page.goto(baseUrl);
  await page.getByLabel('Login identity or email').fill('maya');
  await page.locator('input[type="password"]').first().fill('maya1234');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForTimeout(500);
  await page.getByText('smoke-test-audio-mn1fdpky').click();
  await page.waitForTimeout(500);
  console.log('after_select:' + (await page.textContent('body')).slice(0, 2000));
  await page.getByRole('button', { name: 'Check Out' }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Editor' }).click();
  await page.waitForLoadState('networkidle');
  console.log('EDITOR_BODY_START');
  console.log((await page.textContent('body')).slice(0, 4000));
  console.log('EDITOR_BODY_END');
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(3000);
  const status = await page.locator('.status-inline').textContent();
  const banners = await page.locator('[class*=status]').allTextContents();
  console.log(`playback_status:${status}`);
  console.log(`statuses:${JSON.stringify(banners)}`);
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
