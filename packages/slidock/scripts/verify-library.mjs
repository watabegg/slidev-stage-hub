import { chromium } from 'playwright-chromium';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from './serve.mjs';
const site = resolve(process.argv[2] || 'artifacts/module-graph/site');
const out = resolve('artifacts/browser-library');
await mkdir(out, { recursive: true });
const server = createServer(site);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  channel: 'chromium',
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true,
});
const checks = [];
const check = (name, actual) => {
  assert.ok(actual, name);
  checks.push(name);
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.locator('.deck-card').first().waitFor();
  const catalog = JSON.parse(await readFile(resolve(site, 'catalog.json')));
  check(
    'All decks are displayed',
    (await page.locator('.deck-card').count()) === catalog.decks.length,
  );
  await page
    .locator('.deck-card img')
    .evaluateAll(async (images) => Promise.all(images.map((image) => image.decode())));
  check(
    'Real thumbnails loaded',
    await page
      .locator('.deck-card img')
      .evaluateAll((images) =>
        images.every((i) => i.naturalWidth === 1200 && i.naturalHeight === 675),
      ),
  );
  const requests = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((r) => r.name),
  );
  check(
    'Homepage avoids Slidev runtime',
    !requests.some((url) => /(?:main-|slides-|configs-|mermaid)/.test(url)),
  );
  await page.screenshot({ path: resolve(out, 'home-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'aaa', exact: true }).click();
  check('Category filter aaa', (await page.locator('.deck-card').count()) === 2);
  check(
    'Category contains only aaa',
    (
      await page
        .locator('.deck-card')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
    ).every((href) => href.startsWith('/aaa/')),
  );
  await page.getByRole('button', { name: 'bbb', exact: true }).click();
  check('Category filter bbb', (await page.locator('.deck-card').count()) === 2);
  await page.getByRole('button', { name: /すべて/ }).click();
  await page.locator('.deck-card').first().click();
  await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'visible' });
  await page.locator('.slide-library-home').waitFor({ state: 'visible' });
  await page.mouse.move(1400, 10);
  await page.waitForTimeout(2500);
  check(
    'Home link persists while controls hide',
    await page.locator('.slide-library-home').isVisible(),
  );
  check(
    'Home link has an accessible label',
    (await page.getByRole('link', { name: 'ホームへ戻る' }).count()) === 1,
  );
  await page.screenshot({ path: resolve(out, 'slide-home-link.png') });
  await page.locator('.slide-library-home').click();
  await page.locator('.deck-card').first().waitFor();
  check('Home link returns to library', new URL(page.url()).pathname === '/');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(out, 'home-mobile.png'), fullPage: true });
  check(
    'Mobile does not overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await page.goto(`${origin}/aaa/aaa1/2`);
  await page.locator('.slidev-page[data-slidev-no="2"]').waitFor({ state: 'visible' });
  check('Deep route home link visible', await page.locator('.slide-library-home').isVisible());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.mouse.move(400, 978);
  await page.locator('.slide-library-home').click();
  await page.locator('.deck-card').first().waitFor();
  check('Deep route link returns to library', new URL(page.url()).pathname === '/');
  await page.goto(`${origin}/aaa/aaa1/1?embedded=true&labThumbnail=true`);
  await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'visible' });
  check('Embedded has no overlay', (await page.locator('.slide-library-home').count()) === 0);
  check('No browser errors', errors.length === 0);
  await writeFile(
    resolve(out, 'result.json'),
    JSON.stringify({ status: 'pass', checks, errors, homeResources: requests }, null, 2),
  );
  console.log(JSON.stringify({ status: 'pass', checks }, null, 2));
} finally {
  await browser.close();
  await new Promise((r) => {
    server.close(r);
    server.closeAllConnections();
  });
}
