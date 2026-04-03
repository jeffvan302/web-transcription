# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: playback.spec.mjs >> maya checkout then playback smoke
- Location: playback.spec.mjs:3:1

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3011/
Call log:
  - navigating to "http://localhost:3011/", waiting until "load"

```

# Test source

```ts
  1  | import { test } from '@playwright/test';
  2  | 
  3  | test('maya checkout then playback smoke', async ({ page }) => {
  4  |   page.on('console', (msg) => console.log(`console:${msg.type()}:${msg.text()}`));
  5  |   page.on('pageerror', (error) => console.log(`pageerror:${error.message}`));
  6  |   page.on('requestfailed', (request) => console.log(`requestfailed:${request.url()} ${request.failure()?.errorText || ''}`));
  7  |   page.on('response', async (response) => {
  8  |     const url = response.url();
  9  |     if (url.includes('/api/titles/') || url.includes('/api/auth') || url.includes('/api/state')) {
  10 |       console.log(`response:${response.status()} ${url}`);
  11 |     }
  12 |   });
> 13 |   await page.goto('http://localhost:3011');
     |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3011/
  14 |   await page.getByLabel('Login identity or email').fill('maya');
  15 |   await page.locator('input[type="password"]').first().fill('maya1234');
  16 |   await page.getByRole('button', { name: 'Sign In' }).click();
  17 |   await page.waitForLoadState('networkidle');
  18 |   await page.getByRole('button', { name: 'Library' }).click();
  19 |   await page.getByRole('button', { name: /Smoke Test Audio.*Checked In.*2 phrases/s }).click();
  20 |   await page.getByRole('button', { name: 'Check Out' }).click();
  21 |   await page.waitForLoadState('networkidle');
  22 |   console.log('BODY_START');
  23 |   console.log((await page.textContent('body')).slice(0, 4000));
  24 |   console.log('BODY_END');
  25 |   await page.getByRole('button', { name: 'Play' }).click();
  26 |   await page.waitForTimeout(3000);
  27 |   const status = await page.locator('.status-inline').textContent();
  28 |   const banners = await page.locator('[class*=status]').allTextContents();
  29 |   console.log(`playback_status:${status}`);
  30 |   console.log(`statuses:${JSON.stringify(banners)}`);
  31 | });
  32 | 
```