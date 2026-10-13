import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-chromium';
import { buildHub } from '@slidock/slidock';
import { createServer } from '@slidock/slidock/serve';
import { repositoryRoot as root } from './runtime-environment.mjs';

const output = join(root, 'artifacts/vue-api');
const sourceRoot = join(output, 'slides');
for (const category of ['talks', 'internal']) {
  await mkdir(join(sourceRoot, category), { recursive: true });
  await writeFile(
    join(sourceRoot, category, 'demo.md'),
    `---\ntitle: ${category}\nfonts:\n  webfonts: []\n  sans: Arial\n  mono: monospace\n---\n# ${category}\n`,
  );
}
const entry = join(output, 'entry.ts');
await writeFile(
  entry,
  `import ${JSON.stringify(join(root, 'examples/custom-frontend/vue.ts'))};
import * as frontend from '@slidock/slidock/frontend';
import { createApp, h, ref, shallowRef, nextTick } from 'vue';
window.vueApiTest = { ...frontend, createApp, h, ref, shallowRef, nextTick };
`,
);
const result = await buildHub({
  sourceRoot,
  frontendEntry: entry,
  outDir: join(output, 'site'),
  offline: false,
  chromiumExecutable: process.env.CHROMIUM_EXECUTABLE,
});
const server = createServer(result.output);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
});
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  await page.goto(origin);
  await page.locator('.my-slide-card').first().waitFor();
  assert.equal(await page.locator('.my-slide-card').count(), 2);
  assert.equal(await page.locator('.brand img').count(), 1);
  assert.equal(await page.locator('.home-hero').count(), 0);
  await page.getByRole('button', { name: 'talks', exact: true }).click();
  assert.equal(await page.locator('.my-slide-card').count(), 1);
  await page.locator('.my-slide-card').click();
  await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'visible' });
  await page.getByRole('link', { name: 'ホームへ戻る', exact: true }).click();
  await page.locator('.my-slide-card').first().waitFor();
  checks.push(
    'A consumer Vue SFC imports public components/composable, customizes a card slot and navigates to a slide and back',
  );
  await page.screenshot({ path: join(output, 'vue-home.png'), fullPage: true });

  await page.evaluate((catalog) => {
    const api = window.vueApiTest;
    const { createApp, h, ref, shallowRef, SlidockHome, SlideCard, CategoryNav } = api;
    const host = document.createElement('div');
    host.id = 'composition';
    document.body.append(host);
    api.composition = createApp({
      setup() {
        const category = ref('');
        const data = shallowRef(catalog);
        api.select = (value) => {
          category.value = value;
        };
        api.selection = () => category.value;
        api.empty = () => {
          data.value = { schemaVersion: 1, categories: [], decks: [] };
        };
        return () =>
          h(
            SlidockHome,
            {
              catalog: data.value,
              category: category.value,
              'onUpdate:category': (value) => {
                category.value = value;
              },
              title: 'Custom site',
              deckHref: (deck) => `/custom/${deck.id}`,
            },
            {
              brand: ({ title, href }) => h('a', { id: 'custom-brand', href }, title),
              nav: () =>
                h(
                  'button',
                  {
                    id: 'custom-action',
                    onClick: () => {
                      api.clicked = true;
                    },
                  },
                  'Action',
                ),
              header: () => h('p', { id: 'custom-header' }, 'Optional header'),
              sidebar: ({ categories, selected, select }) =>
                h(CategoryNav, { categories, modelValue: selected, 'onUpdate:modelValue': select }),
              'category-heading': ({ label, decks }) =>
                h('h2', { class: 'custom-heading' }, `${label}: ${decks.length}`),
              card: ({ deck, href }) =>
                h(
                  SlideCard,
                  { deck, href, class: 'custom-card' },
                  {
                    preview: () => h('span', { class: 'custom-preview' }, deck.id),
                    default: () => h('h3', deck.title),
                  },
                ),
              empty: () => h('p', { id: 'custom-empty' }, 'No slides'),
              footer: () => h('span', { id: 'custom-footer' }, 'Custom footer'),
            },
          );
      },
    }).mount(host);
  }, result.catalog);
  const composition = page.locator('#composition');
  assert.equal(await composition.locator('#custom-brand').textContent(), 'Custom site');
  assert.equal(await composition.locator('.custom-card').count(), 2);
  assert.equal(await composition.locator('.custom-preview').count(), 2);
  assert.equal(await composition.locator('#custom-header').count(), 1);
  assert.equal(await composition.locator('#custom-footer').count(), 1);
  await composition.locator('#custom-action').click();
  assert.equal(await page.evaluate(() => window.vueApiTest.clicked), true);
  await page.evaluate(() => window.vueApiTest.select('talks'));
  assert.equal(await composition.locator('.custom-card').count(), 1);
  assert.equal(
    await composition.locator('.custom-card').getAttribute('href'),
    '/custom/talks/demo',
  );
  await composition.getByRole('button', { name: 'internal', exact: true }).click();
  assert.equal(await page.evaluate(() => window.vueApiTest.selection()), 'internal');
  assert.equal(await composition.locator('.custom-heading').textContent(), 'internal: 1');
  checks.push(
    'All home/card slots render real Vue content, events work, and category v-model synchronizes in both directions',
  );
  await page.evaluate(() => window.vueApiTest.empty());
  await composition.locator('#custom-empty').waitFor();
  assert.equal(await composition.locator('.custom-card').count(), 0);
  checks.push('Reactive catalog updates replace cards with the caller-provided empty slot');

  const lifecycle = await page.evaluate(async (catalog) => {
    const { createApp, h, shallowRef, nextTick, useCatalog } = window.vueApiTest;
    const flush = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
    };
    const pending = [];
    const source = shallowRef({
      load: ({ signal }) =>
        new Promise((resolve) => {
          pending.push({ resolve, signal });
        }),
    });
    const host = document.createElement('div');
    document.body.append(host);
    let state;
    const app = createApp({
      setup() {
        state = useCatalog(source);
        return () =>
          h(
            'p',
            state.pending.value
              ? 'loading'
              : state.error.value
                ? 'error'
                : (state.catalog.value?.decks[0]?.title ?? 'empty'),
          );
      },
    });
    app.mount(host);
    await flush();
    const loading = state.pending.value && host.textContent === 'loading';
    const first = pending[0];
    const secondRun = state.reload();
    await flush();
    const second = pending[1];
    const latest = structuredClone(catalog);
    latest.decks[0].title = 'Latest';
    second.resolve(latest);
    await secondRun;
    first.resolve(catalog);
    await flush();
    const latestWins = host.textContent === 'Latest' && first.signal.aborted;
    source.value = {
      load: async () => {
        throw new Error('Unavailable');
      },
    };
    await flush();
    const failed =
      host.textContent === 'error' &&
      state.error.value?.code === 'NETWORK' &&
      state.catalog.value === null &&
      !state.pending.value;
    source.value = { load: async () => catalog };
    await flush();
    const recovered =
      state.error.value === null && state.catalog.value?.decks.length === catalog.decks.length;
    await state.reload();
    await flush();
    const retried = host.textContent === catalog.decks[0].title;
    let unmountSignal, resolveUnmount;
    source.value = {
      load: ({ signal }) =>
        new Promise((resolve) => {
          unmountSignal = signal;
          resolveUnmount = resolve;
        }),
    };
    await flush();
    app.unmount();
    resolveUnmount(catalog);
    await flush();
    const unmounted =
      unmountSignal.aborted && state.catalog.value === null && host.childElementCount === 0;
    host.remove();
    return { loading, latestWins, failed, recovered, retried, unmounted };
  }, result.catalog);
  for (const [name, pass] of Object.entries(lifecycle)) assert.equal(pass, true, name);
  checks.push(
    'useCatalog exposes loading/error/reload, watches source refs, rejects stale results, and aborts requests on unmount',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ checks, lifecycle, browserErrors: errors }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ checks, lifecycle }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
