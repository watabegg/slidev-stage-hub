import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-chromium';
import { createServer } from '@slidock/slidock/serve';
import { repositoryRoot } from './runtime-environment.mjs';

const site = join(repositoryRoot, 'packages/slidock/artifacts/official-themes/site');
const output = join(repositoryRoot, 'artifacts/home-refresh/browser');
await mkdir(output, { recursive: true });
const catalog = JSON.parse(await readFile(join(site, 'catalog.json'), 'utf8'));
const { samples } = JSON.parse(
  await readFile(join(repositoryRoot, 'examples/official-themes/sources.json'), 'utf8'),
);
assert.deepEqual(
  catalog.decks.map((deck) => deck.id).sort(),
  samples.map((sample) => sample.id).sort(),
);
const server = createServer(site);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [];
const externalFailures = new Set();
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => {
    if (!request.url().startsWith(origin)) externalFailures.add(request.url());
  });
  await page.goto(origin);
  await page.locator('.deck-card').first().waitFor();
  assert.equal(await page.locator('.deck-card').count(), 5);
  assert.equal(await page.locator('.deck-group').count(), 5);
  assert.equal(await page.locator('.brand span').textContent(), 'Slidock');
  assert.equal(await page.locator('.home-hero').count(), 0);
  assert.ok(
    !/資料ライブラリ|考えを、スライドから。|SLIDE LIBRARY/.test(
      await page.locator('body').textContent(),
    ),
  );
  await page
    .locator('.deck-card img')
    .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  assert.ok(
    await page.locator('.brand img').evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  assert.ok(
    (await page.locator('link[rel="icon"]').getAttribute('href')).startsWith('data:image/svg+xml;'),
  );
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  checks.push(
    'Five official samples appear under their own theme categories with real thumbnails and Slidock branding',
  );
  for (const sample of samples) {
    const category = sample.id.split('/')[0];
    await page.getByRole('button', { name: category, exact: true }).click();
    assert.equal(await page.locator('.deck-card').count(), 1);
    const deck = catalog.decks.find((deck) => deck.id === sample.id);
    assert.equal(await page.locator('.deck-card').getAttribute('href'), deck.entry);
    await page.locator('.deck-card').click();
    await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'visible' });
    assert.match(
      await page.evaluate(() => window.__slidevLab.theme),
      new RegExp(`^${sample.package}@`),
    );
    await page.screenshot({ path: join(output, `${sample.profile}.png`) });
    await page.goto(`${origin}/${encodeURIComponent(category)}/example/${deck.pages}`);
    await page
      .locator(`.slidev-page[data-slidev-no="${deck.pages}"]`)
      .waitFor({ state: 'visible' });
    await page.getByRole('link', { name: 'ホームへ戻る', exact: true }).click();
    await page.locator('.deck-card').first().waitFor();
    assert.equal(await page.locator('.deck-card').count(), 5);
    checks.push(
      `${category}: category filter, matching theme, first/last slide deep links and return home`,
    );
  }
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(output, `home-${width}.png`), fullPage: true });
  }
  checks.push('Mobile and tablet layouts fit the viewport');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.locator('.deck-card').first().waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').textContent(), 'スライド一覧へ');
  await page.keyboard.press('Enter');
  assert.equal(
    new URL(page.url()).hash,
    `#${await page.locator('.library-layout').getAttribute('id')}`,
  );
  checks.push('Keyboard skip link reaches the slide list');
  await page.route('**/catalog.json', (route) =>
    route.fulfill({ json: { schemaVersion: 1, categories: [], decks: [] } }),
  );
  await page.goto(origin);
  await page.locator('.empty-library').waitFor();
  assert.equal(await page.locator('.deck-card').count(), 0);
  checks.push('Empty catalog renders an empty state');
  assert.deepEqual(errors, []);
  checks.push('No uncaught browser exceptions');
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ checks, externalFailures: [...externalFailures] }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ checks, externalFailures: [...externalFailures] }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
