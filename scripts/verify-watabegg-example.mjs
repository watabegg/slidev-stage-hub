import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-chromium';
import { createServer } from '@slidock/slidock/serve';
import { repositoryRoot } from './runtime-environment.mjs';

const site = join(repositoryRoot, 'packages/slidock/artifacts/example-watabegg-offline/site');
const out = join(repositoryRoot, 'artifacts/example-watabegg');
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile(join(site, 'manifest.json'), 'utf8'));
assert.equal(manifest.decks.length, 1);
assert.equal(manifest.decks[0].theme, 'slidev-theme-watabegg@1.2.1');
const player = JSON.parse(await readFile(join(site, 'native-player.json'), 'utf8'));
assert.deepEqual(player.decks[0].clickTotals, [0, 2, 0]);
assert.equal(player.unsupportedDecks.length, 0);
const server = createServer(site);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
const checks = [
  'published theme version is 1.2.1',
  'three pages and two clicks advertised to Stage',
];
const check = (name, passed) => {
  assert.ok(passed, name);
  checks.push(name);
};
try {
  browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) =>
    errors.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  // The example must work without fetching a theme, fonts or images at runtime.
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', (route) =>
    route
      .request()
      .url()
      .startsWith(origin + '/')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  await page.locator('.deck-card').click();
  await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'visible' });
  await page
    .locator('.slidev-page[data-slidev-no="1"]')
    .getByRole('heading', { name: 'watabegg 1.2.1 example', exact: true })
    .waitFor();
  check(
    'theme cover renders the title',
    (await page.locator('.slidev-page[data-slidev-no="1"]').innerText()).includes(
      'watabegg 1.2.1 example',
    ),
  );
  await page.keyboard.press('ArrowRight');
  const second = page.locator('.slidev-page[data-slidev-no="2"]');
  await second.waitFor({ state: 'visible' });
  await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'hidden' });
  await second.getByText('Published theme', { exact: true }).waitFor();
  check('QuestionList renders', (await second.innerText()).includes('Published theme'));
  check(
    'FigureGrid image decodes',
    await second.locator('.figure-grid img').evaluate(async (image) => {
      await image.decode();
      return image.naturalWidth > 0;
    }),
  );
  const click = second.getByText('First click step', { exact: true });
  check(
    'click initially hidden',
    await click.evaluate(
      (el) => getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).opacity === '0',
    ),
  );
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.searchParams.get('clicks') === '1');
  await click.waitFor({ state: 'visible' });
  check('theme Enter advances one click', new URL(page.url()).pathname === '/demo/2');
  await page.screenshot({ path: join(out, 'components.png'), animations: 'disabled' });
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.searchParams.get('clicks') === '2');
  await page.keyboard.press('Enter');
  const section = page.locator('.slidev-page[data-slidev-no="3"]');
  await section.waitFor({ state: 'visible' });
  await section.getByRole('heading', { name: 'Ready to present', exact: true }).waitFor();
  check('section layout renders', (await section.innerText()).includes('Ready to present'));
  await page.locator('.slide-library-home').click();
  await page.locator('.deck-card').waitFor();
  check('returns to Hub', new URL(page.url()).pathname === '/');
  check('no browser errors or external requests', errors.length === 0);
  const result = { status: 'passed', theme: manifest.decks[0].theme, checks, errors };
  await writeFile(join(out, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
