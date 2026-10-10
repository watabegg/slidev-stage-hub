import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import {
  CatalogClientError,
  createCatalogClient,
  createHttpCatalogSource,
  createWorkersCatalogSource,
  createPaginatedCatalogSource,
  getCatalog,
} from '../dist/client/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientEntry = resolve(packageRoot, 'dist/client/index.js');

const emptyCatalog = {
  schemaVersion: 1,
  categories: [],
  decks: [],
};

const catalog = {
  schemaVersion: 1,
  categories: [{ id: 'math', name: 'Math', path: ['math'], parentId: null }],
  decks: [
    {
      id: 'math/algebra',
      title: 'Algebra',
      entry: '/math/algebra/',
      pages: 5,
      revision: 'rev-1',
      categoryPath: ['math'],
      frontmatter: { author: 'A. Teacher', tags: ['math', 'intro'] },
      thumbnail: { src: '/thumb.png', width: 1200, height: 675 },
      runtimeVersion: '53.0.0',
      theme: 'default',
      profile: 'slidev53',
    },
  ],
};

function errorWithCode(code, extra = {}) {
  return (error) =>
    error instanceof CatalogClientError &&
    error.code === code &&
    Object.entries(extra).every(([key, value]) => error[key] === value);
}

test('static and Worker-shaped fixture sources share protocol catalog validation', async () => {
  const staticSource = { load: async () => catalog };
  const workerFixtureSource = {
    async load() {
      const response = new Response(JSON.stringify(catalog), {
        headers: { 'content-type': 'application/json' },
      });
      return response.json();
    },
  };

  assert.deepEqual(await getCatalog(staticSource), catalog);
  assert.deepEqual(await createCatalogClient(workerFixtureSource).getCatalog(), catalog);
  assert.deepEqual(await getCatalog({ load: async () => emptyCatalog }), emptyCatalog);
});

test('HTTP source uses the default catalog path and injected fetch', async () => {
  let requestedUrl;
  let requestInit;
  const source = createHttpCatalogSource({
    fetch: async (url, init) => {
      requestedUrl = url;
      requestInit = init;
      return new Response(JSON.stringify(catalog), { status: 200 });
    },
  });
  const controller = new AbortController();

  assert.deepEqual(await getCatalog(source, { signal: controller.signal }), catalog);
  assert.equal(requestedUrl, '/catalog.json');
  assert.equal(requestInit.signal, controller.signal);
});

test('Workers source follows every cursor page, merges by ID, and keeps the cursor on one endpoint', async () => {
  const nextCursor = 'https://outside.example/catalog?next=https://elsewhere.example';
  const updatedAlgebra = { ...catalog.decks[0], revision: 'rev-2' };
  const geometry = {
    ...catalog.decks[0],
    id: 'math/geometry',
    title: 'Geometry',
    entry: '/math/geometry/',
    revision: 'rev-3',
  };
  const secondPage = {
    schemaVersion: 1,
    categories: [{ ...catalog.categories[0], name: 'Mathematics' }],
    decks: [updatedAlgebra, geometry],
  };
  const calls = [];
  const source = createPaginatedCatalogSource({
    url: 'https://hub.example.test/api/catalog?tenant=math',
    fetch: async (url, init) => {
      calls.push({ url, init });
      const page = calls.length === 1 ? { ...catalog, cursor: nextCursor } : secondPage;
      return new Response(JSON.stringify(page), { status: 200 });
    },
  });
  const controller = new AbortController();
  const result = await getCatalog(source, { signal: controller.signal });

  assert.equal(calls.length, 2);
  const firstUrl = new URL(calls[0].url);
  const secondUrl = new URL(calls[1].url);
  assert.equal(firstUrl.origin, 'https://hub.example.test');
  assert.equal(secondUrl.origin, firstUrl.origin);
  assert.equal(secondUrl.pathname, firstUrl.pathname);
  assert.equal(secondUrl.searchParams.get('tenant'), 'math');
  assert.equal(secondUrl.searchParams.get('cursor'), nextCursor);
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(calls[1].init.signal, controller.signal);
  assert.equal(result.categories.length, 1);
  assert.equal(result.categories[0].name, 'Mathematics');
  assert.deepEqual(
    result.decks.map((deck) => deck.id),
    ['math/algebra', 'math/geometry'],
  );
  assert.equal(result.decks[0].revision, 'rev-2');
});

test('Workers source rejects invalid and repeated cursors, page limits, and invalid later pages', async () => {
  const cases = [
    {
      name: 'empty cursor',
      pages: [{ ...catalog, cursor: '' }],
      expectedCalls: 1,
    },
    {
      name: 'repeated cursor',
      pages: [
        { ...catalog, cursor: 'repeat' },
        { ...catalog, cursor: 'repeat' },
      ],
      expectedCalls: 2,
    },
    {
      name: 'page limit',
      pages: [{ ...catalog, cursor: 'next' }],
      maxPages: 1,
      expectedCalls: 1,
    },
    {
      name: 'invalid later page',
      pages: [
        { ...catalog, cursor: 'next' },
        { schemaVersion: 2, categories: [], decks: [] },
      ],
      expectedCalls: 2,
    },
  ];

  for (const scenario of cases) {
    let calls = 0;
    const source = createPaginatedCatalogSource({
      maxPages: scenario.maxPages,
      fetch: async () => {
        const page = scenario.pages[Math.min(calls, scenario.pages.length - 1)];
        calls += 1;
        return new Response(JSON.stringify(page), { status: 200 });
      },
    });
    await assert.rejects(getCatalog(source), (error) => {
      assert.equal(error.code, 'INVALID_CATALOG', scenario.name);
      return true;
    });
    assert.equal(calls, scenario.expectedCalls, scenario.name);
  }
});

test('Workers source preserves abort errors between catalog pages', async () => {
  const controller = new AbortController();
  let calls = 0;
  const source = createPaginatedCatalogSource({
    fetch: async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      calls += 1;
      controller.abort('stop after first page');
      return new Response(JSON.stringify({ ...catalog, cursor: 'next' }), { status: 200 });
    },
  });

  await assert.rejects(getCatalog(source, { signal: controller.signal }), errorWithCode('ABORTED'));
  assert.equal(calls, 1);
});

test('HTTP errors carry status without attempting to parse a response body', async () => {
  const source = createHttpCatalogSource({
    fetch: async () => new Response('unavailable', { status: 503 }),
  });

  await assert.rejects(getCatalog(source), errorWithCode('HTTP', { status: 503 }));
});

test('invalid JSON and invalid catalogs have distinct typed errors and preserve causes', async () => {
  const invalidJsonResponse = new SyntaxError('unexpected token');
  const invalidJsonSource = createHttpCatalogSource({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw invalidJsonResponse;
      },
    }),
  });
  await assert.rejects(getCatalog(invalidJsonSource), (error) => {
    assert.equal(error.code, 'INVALID_JSON');
    assert.equal(error.cause, invalidJsonResponse);
    return true;
  });

  const invalidCatalogSource = { load: async () => ({ schemaVersion: 2 }) };
  await assert.rejects(getCatalog(invalidCatalogSource), (error) => {
    assert.equal(error.code, 'INVALID_CATALOG');
    assert.match(error.cause.message, /schemaVersion/);
    return true;
  });
});

test('network and custom-source failures preserve causes and typed client errors', async () => {
  const networkCause = new TypeError('connection refused');
  await assert.rejects(
    getCatalog(createHttpCatalogSource({ fetch: async () => Promise.reject(networkCause) })),
    (error) => {
      assert.equal(error.code, 'NETWORK');
      assert.equal(error.cause, networkCause);
      return true;
    },
  );

  await assert.rejects(getCatalog({ load: async () => Promise.reject(networkCause) }), (error) => {
    assert.equal(error.code, 'NETWORK');
    assert.equal(error.cause, networkCause);
    return true;
  });

  const typedError = new CatalogClientError('HTTP', 'fixture HTTP failure', { status: 418 });
  await assert.rejects(getCatalog({ load: async () => Promise.reject(typedError) }), (error) => {
    assert.equal(error, typedError);
    return true;
  });
});

test('pre-aborted signals skip loading and in-flight aborts reject promptly', async () => {
  let calls = 0;
  const source = { load: async () => (calls++, catalog) };
  const preAborted = new AbortController();
  preAborted.abort('already stopped');

  await assert.rejects(getCatalog(source, { signal: preAborted.signal }), errorWithCode('ABORTED'));
  assert.equal(calls, 0);

  let finishLoad;
  const ignoringSource = {
    load: () => new Promise((resolvePromise) => (finishLoad = resolvePromise)),
  };
  const controller = new AbortController();
  const pending = getCatalog(ignoringSource, { signal: controller.signal });
  controller.abort('stop now');
  await assert.rejects(pending, errorWithCode('ABORTED'));
  finishLoad(catalog);
});

test('import has no browser-global or fetch requirement and starts no request', () => {
  const clientUrl = pathToFileURL(clientEntry).href;
  const source = `
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      get() { throw new Error('fetch accessed during import'); }
    });
    delete globalThis.document;
    delete globalThis.window;
    const client = await import(${JSON.stringify(`${clientUrl}?headless-check`)});
    if (typeof client.getCatalog !== 'function') process.exitCode = 1;
  `;

  execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
});

test('the old Workers catalog factory remains a compatible alias', () => {
  assert.equal(createWorkersCatalogSource, createPaginatedCatalogSource);
});
