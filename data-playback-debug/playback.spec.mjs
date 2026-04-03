import { test } from '@playwright/test';

test('maya checkout then playback smoke', async ({ page }) => {
  page.on('console', (msg) => console.log(`console:${msg.type()}:${msg.text()}`));
  page.on('pageerror', (error) => console.log(`pageerror:${error.message}`));
  page.on('requestfailed', (request) => console.log(`requestfailed:${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/titles/') || url.includes('/api/auth') || url.includes('/api/state')) {
      console.log(`response:${response.status()} ${url}`);
    }
  });
  await page.goto('http://localhost:3011');
  await page.getByLabel('Login identity or email').fill('maya');
  await page.locator('input[type="password"]').first().fill('maya1234');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('button', { name: /Smoke Test Audio.*Checked In.*2 phrases/s }).click();
  await page.getByRole('button', { name: 'Check Out' }).click();
  await page.waitForLoadState('networkidle');
  console.log('BODY_START');
  console.log((await page.textContent('body')).slice(0, 4000));
  console.log('BODY_END');
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(3000);
  const status = await page.locator('.status-inline').textContent();
  const banners = await page.locator('[class*=status]').allTextContents();
  console.log(`playback_status:${status}`);
  console.log(`statuses:${JSON.stringify(banners)}`);
});
