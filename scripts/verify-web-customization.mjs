import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-chromium';
import { buildHub } from '@slidev-stage-hub/hub/node';
import { createServer } from '@slidev-stage-hub/hub/serve';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'artifacts/step6');
const sourceRoot = join(output, 'slides');
await mkdir(join(sourceRoot, 'category'), { recursive: true });
await writeFile(
  join(sourceRoot, 'category/example.md'),
  `---
title: Web customization fixture
fonts:
  webfonts: []
  sans: Arial
  mono: monospace
---
# Web customization fixture

---
# Second page
`,
);
const common = { sourceRoot, offline: false, chromiumExecutable: process.env.CHROMIUM_EXECUTABLE };
const checks = [];
const check = (name, value = true) => {
  assert.ok(value, name);
  checks.push(name);
};
console.log('Building default, framework-free and themed entries');
const standard = await buildHub({ ...common, outDir: join(output, 'default') });
const custom = await buildHub({
  ...common,
  outDir: join(output, 'custom'),
  frontendEntry: join(root, 'examples/custom-frontend/entry.ts'),
  navigation: { homeLabel: 'コレクションへ戻る', homeHref: '/?collection=1' },
});
const probe = join(sourceRoot, 'FrontendProbe.vue');
await writeFile(
  probe,
  '<script setup>const label = "Custom Vue dependency";</script><template><aside id="frontend-probe">{{ label }}</aside></template>',
);
const harness = join(output, 'harness.ts');
await writeFile(
  harness,
  `import ${JSON.stringify(join(root, 'examples/custom-frontend/themed.ts'))};
import { mountHub } from '@slidev-stage-hub/hub/frontend';
import { createHttpCatalogSource } from '@slidev-stage-hub/hub/client';
import { createApp } from 'vue';
import Probe from ${JSON.stringify(probe)};
const probeRoot = document.createElement('div'); document.body.append(probeRoot);
createApp(Probe).mount(probeRoot);
window.webTest = { mountHub, createHttpCatalogSource };
`,
);
const themed = await buildHub({
  ...common,
  outDir: join(output, 'themed'),
  frontendEntry: harness,
  navigation: { enabled: false },
});
assert.deepEqual(custom.catalog, standard.catalog);
assert.deepEqual(themed.catalog, standard.catalog);
check('Entries preserve catalog and deck metadata');
const servers = [];
async function serve(site) {
  const server = createServer(site);
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
let browser;
try {
  const [defaultUrl, customUrl, themedUrl] = await Promise.all([
    serve(standard.output),
    serve(custom.output),
    serve(themed.output),
  ]);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // Headless Chromium cannot acquire a screen wake lock; this gate tests Web composition.
  await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(defaultUrl);
  await page.locator('.deck-card').waitFor();
  assert.equal(await page.locator('.deck-card h2').textContent(), 'Web customization fixture');
  const styles = await page.evaluate(() => ({
    background: getComputedStyle(document.documentElement).backgroundColor,
    color: getComputedStyle(document.documentElement).color,
    width: getComputedStyle(document.querySelector('.library')).maxWidth,
    padding: getComputedStyle(document.querySelector('.library')).paddingLeft,
  }));
  assert.deepEqual(styles, {
    background: 'rgb(248, 250, 252)',
    color: 'rgb(29, 48, 68)',
    width: '1480px',
    padding: '56px',
  });
  await page.locator('.deck-card img').evaluate((img) => img.decode());
  await page.screenshot({ path: join(output, 'default-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'category', exact: true }).click();
  assert.equal(await page.locator('.deck-card').count(), 1);
  await page.locator('.deck-card').click();
  await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'visible' });
  await page.getByRole('link', { name: '資料ライブラリのホームへ戻る' }).click();
  await page.locator('.deck-card').waitFor();
  check('Default list, category filter, thumbnail, slide and return navigation work');
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    'Default mobile layout has no horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await page.screenshot({ path: join(output, 'default-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.route('**/catalog.json', (route) => route.fulfill({ json: { schemaVersion: 99 } }));
  await page.goto(defaultUrl);
  await page.getByText(/資料一覧を読み込めませんでした/).waitFor();
  check('Broken catalog produces the default localized error');
  await page.screenshot({ path: join(output, 'invalid-catalog.png') });
  await page.unroute('**/catalog.json');
  await page.route('**/catalog.json', (route) =>
    route.fulfill({ json: { schemaVersion: 1, categories: [], decks: [] } }),
  );
  await page.goto(defaultUrl);
  await page.locator('.empty-library').waitFor();
  assert.equal(await page.locator('.deck-card').count(), 0);
  check('Empty catalog renders empty state');
  await page.screenshot({ path: join(output, 'empty-catalog.png') });
  await page.unroute('**/catalog.json');

  await page.goto(customUrl);
  await page.getByRole('heading', { name: 'My slide collection' }).waitFor();
  assert.equal(await page.locator('.library').count(), 0);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    'rgb(255, 248, 238)',
  );
  check('Framework-free custom entry and replacement stylesheet render');
  await page.screenshot({ path: join(output, 'custom-entry.png') });
  await page.getByRole('link', { name: 'Web customization fixture (2 pages)' }).click();
  await page.getByRole('link', { name: 'コレクションへ戻る', exact: true }).waitFor();
  assert.equal(await page.locator('.slide-library-home').getAttribute('href'), '/?collection=1');
  check('Custom deck navigation label and destination work');

  await page.goto(themedUrl);
  await page.locator('.deck-card').waitFor();
  assert.match(await page.locator('.brand').textContent(), /MY SLIDES/);
  await page.getByText('Custom Vue dependency', { exact: true }).waitFor();
  check('Custom Vue dependencies outside the entry directory avoid Slidev context injection');
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    'rgb(255, 248, 238)',
  );
  check('Reusable mount accepts branding and CSS variable overrides');
  await page.screenshot({ path: join(output, 'custom-theme.png') });
  await page.route('**/missing-catalog', (route) =>
    route.fulfill({ status: 404, body: 'Missing' }),
  );
  const fixture = structuredClone(standard.catalog);
  fixture.decks[0].title = '<img src=x onerror="window.injected=true">';
  fixture.decks[0].frontmatter.description = '<script>window.injected=true</script>';
  const mountResults = await page.evaluate(async (catalog) => {
    const { mountHub, createHttpCatalogSource } = window.webTest;
    const root = document.createElement('div');
    root.id = 'qa';
    document.body.append(root);
    const mounted = await mountHub(root, {
      source: { load: async () => catalog },
      navigation: { deckHref: () => '/custom-deck' },
    });
    const safe =
      root.querySelector('h2').textContent === catalog.decks[0].title &&
      !root.querySelector('.deck-info img, script') &&
      !window.injected;
    const href = root.querySelector('.deck-card').getAttribute('href');
    mounted.unmount();
    mounted.unmount();
    const unmounted = root.childElementCount === 0;
    const codes = [];
    for (const task of [
      () => mountHub('#missing'),
      () => mountHub(root, { source: { load: async () => ({ schemaVersion: 99 }) } }),
      () => mountHub(root, { source: createHttpCatalogSource({ url: '/missing-catalog' }) }),
    ]) {
      try {
        await task();
      } catch (error) {
        codes.push(error.code);
      }
    }
    const controller = new AbortController();
    let resolveSource;
    const pending = mountHub(root, {
      signal: controller.signal,
      source: {
        load: () =>
          new Promise((accept) => {
            resolveSource = accept;
          }),
      },
    });
    controller.abort();
    try {
      await pending;
    } catch (error) {
      codes.push(error.code);
    }
    resolveSource(catalog);
    await new Promise((accept) => setTimeout(accept, 30));
    const cancelled = root.childElementCount === 0;
    root.textContent = `Abort: ${codes.at(-1)}`;
    return { safe, href, unmounted, codes, cancelled };
  }, fixture);
  assert.equal(mountResults.safe, true);
  assert.equal(mountResults.href, '/custom-deck');
  assert.equal(mountResults.unmounted, true);
  assert.deepEqual(mountResults.codes, ['MOUNT', 'INVALID_CATALOG', 'HTTP', 'ABORTED']);
  assert.equal(mountResults.cancelled, true);
  check('Custom source, safe text, deck link override, unmount and typed mount/client errors work');
  check('Abort prevents late source completion from mounting');
  await page.screenshot({ path: join(output, 'abort.png') });
  await page.goto(`${themedUrl}/category/example/1`);
  await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.slide-library-home').count(), 0);
  check('Deck navigation can be disabled');
  assert.deepEqual(errors, []);
  check('No unhandled browser exceptions');
  await writeFile(
    join(output, 'gate.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        wakeLock: 'disabled in browser fixture',
        checks,
        styles,
        mountResults,
        evidence: [
          'default-desktop.png',
          'default-mobile.png',
          'invalid-catalog.png',
          'empty-catalog.png',
          'custom-entry.png',
          'custom-theme.png',
          'abort.png',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ checks: checks.length, evidence: join(output, 'gate.json') }));
} finally {
  await browser?.close();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((accept) => {
          server.close(accept);
          server.closeAllConnections();
        }),
    ),
  );
}
// The gate exercises built outputs; keep the reproducible evidence under ignored artifacts.
assert.ok((await readFile(join(output, 'gate.json'), 'utf8')).length > 0);
