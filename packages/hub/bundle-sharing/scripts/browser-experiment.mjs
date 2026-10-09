import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Local experiment, not a claim of Windows/WebKit/physical-display coverage.
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-chromium')); }
catch { ({ chromium } = createRequire(resolve(process.env.SLIDEV_THEME_PATH || '/home/watabegg/slidev-watabegg', 'package.json'))('playwright-chromium')); }
const origin = process.argv[2] || 'http://127.0.0.1:4173';
const out = resolve(process.argv[3] || 'artifacts/browser');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const deniedExternal = [];
if (process.env.BLOCK_EXTERNAL === '1') await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(`${origin}/`)) return route.continue();
  deniedExternal.push(url);
  return route.abort('internetdisconnected');
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
const requests = [];
page.on('response', response => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  requests.push(response.url());
});
const result = { origin, engine: await browser.version(), decks: [], errors, deniedExternal, externalBlocked: process.env.BLOCK_EXTERNAL === '1', note: 'transferSize uses Resource Timing; decoded/encoded sizes and HTTP cache are distinct from disk size. BLOCK_EXTERNAL uses request interception, disables cache, and models external-network denial while keeping the local server available.' };
const expectedColors = { 'aaa/aaa1': 'rgb(37, 99, 235)', 'aaa/aaa2': 'rgb(21, 128, 61)', 'bbb/bbb1': 'rgb(220, 38, 38)', 'bbb/bbb2': 'rgb(126, 34, 206)' };
async function state() {
  return page.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: document.body.innerText,
    clicks: [...document.querySelectorAll('.slidev-vclick-target')].map(el => ({ text: el.textContent.trim(), hidden: el.classList.contains('slidev-vclick-hidden') })),
    images: [...document.images].filter(el => el.getAttribute('alt') === 'Conflict fixture image').map(el => ({ src: el.src, width: el.naturalWidth, complete: el.complete })),
    colors: [...document.querySelectorAll('.fixture-conflict')].map(el => getComputedStyle(el).backgroundColor),
    resources: performance.getEntriesByType('resource').map(e => ({ url: e.name, transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize })),
  }));
}
try {
  for (const id of ['aaa/aaa1', 'aaa/aaa2', 'bbb/bbb1', 'bbb/bbb2']) {
    const start = requests.length;
    await page.goto(`${origin}/${id}/2`, { waitUntil: 'networkidle' });
    await page.locator('.fixture-conflict').first().waitFor();
    await page.waitForTimeout(300);
    const before = await state();
    assert(before.text.includes(id.split('/')[1]), `wrong deck ${id}`);
    assert(!before.text.includes('PRIVATE_NOTE_'), 'private notes rendered');
    assert(before.images.length && before.images.every(i => i.complete && i.width > 0), 'fixture images unavailable');
    assert(before.colors.length && before.colors.every(c => c === expectedColors[id]), `wrong scoped CSS for ${id}: ${before.colors}`);
    await page.screenshot({ path: resolve(out, `${id.replace('/', '-')}-before.png`) });
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    const after = await state();
    assert(after.url.includes('/2'), 'one click unexpectedly advanced page');
    assert(after.clicks.filter(c => c.hidden).length < before.clicks.filter(c => c.hidden).length, 'click reveal did not advance');
    await page.screenshot({ path: resolve(out, `${id.replace('/', '-')}-click.png`) });
    await page.reload({ waitUntil: 'networkidle' });
    const reloaded = await state();
    assert.equal(reloaded.url, after.url, 'reload changed route');
    await page.goto(`${origin}/${id}/3`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: resolve(out, `${id.replace('/', '-')}-math-code.png`) });
    result.decks.push({ id, before, after, reloaded, requested: requests.slice(start), page3: await state() });
  }
  // A second tab must retain its own deck and reveal state.
  const second = await context.newPage();
  await second.goto(`${origin}/aaa/aaa1/2`, { waitUntil: 'networkidle' });
  await page.goto(`${origin}/bbb/bbb2/2`, { waitUntil: 'networkidle' });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  result.secondTab = { url: second.url(), text: await second.locator('body').innerText() };
  assert(result.secondTab.url.endsWith('/aaa/aaa1/2'), 'other deck navigation mixed across tabs');
  await second.close();
  if (process.env.SKIP_CATALOG !== '1') {
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('a[href$="/1"]').count(), 4, 'catalog missing decks');
  await page.locator('a[href="/aaa/aaa1/1"]').click();
  await page.waitForURL(`${origin}/aaa/aaa1/1`);
  await page.goBack({ waitUntil: 'networkidle' });
  assert.equal(new URL(page.url()).pathname, '/', 'back did not restore catalog');
  await page.goForward({ waitUntil: 'networkidle' });
  assert.equal(new URL(page.url()).pathname, '/aaa/aaa1/1', 'forward did not restore deck');
  result.catalogHistory = 'PASS';
  } else result.catalogHistory = 'not applicable: independent baseline has no catalog';
  const manifestResponse = await fetch(`${origin}/manifest.json`);
  if (manifestResponse.ok) {
    const manifest = await manifestResponse.json();
    result.network = result.decks.map(deck => {
      const resources = deck.before.resources.filter(r => r.url.startsWith(`${origin}/`));
      const paths = new Set(resources.map(r => new URL(r.url).pathname.slice(1)));
      const foreign = (manifest.decks || []).filter(other => other.id !== deck.id)
        .flatMap(other => (other.assets || []).filter(asset => paths.has(asset)).map(asset => ({ id: other.id, asset })));
      assert.equal(foreign.length, 0, `other deck assets downloaded by ${deck.id}`);
      return { id: deck.id, sameOriginTransfer: resources.reduce((n, r) => n + r.transfer, 0), resources: resources.length, cached: resources.filter(r => r.transfer === 0).length, foreign };
    });
  }
  result.status = errors.length ? 'FAIL' : 'PASS';
  assert.equal(errors.length, 0, `browser errors: ${errors.join('\n')}`);
  if (process.env.BLOCK_EXTERNAL === '1') assert.equal(deniedExternal.length, 0, 'offline site attempted external resources');
} catch (error) {
  result.status = 'FAIL';
  result.failure = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  await browser.close();
  console.log(JSON.stringify({ status: result.status, decks: result.decks.length, errors, failure: result.failure, output: resolve(out, 'result.json') }, null, 2));
}
