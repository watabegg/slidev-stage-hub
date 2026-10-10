import assert from 'node:assert/strict';
import test from 'node:test';
import { createHubServer, publishDeck } from '../dist/index.js';
import { memoryOptions, compileResult, pngHeader } from './support.mjs';

for (const [label, failPut] of [
  ['artifact', (key) => key.endsWith('/1.js')],
  ['manifest', (key) => key.endsWith('/manifest.json')],
  ['index', (key) => key.startsWith('index/')],
]) {
  test(`${label} failure preserves the previous current manifest and never commits`, async () => {
    const { options, current, calls } = memoryOptions({ failPut });
    const previous = { title: 'Previous' };
    current.set('deck', previous);
    await assert.rejects(
      publishDeck(options, 'deck', { markdown: '# New' }, async (input) => compileResult(input)),
      (error) => error.phase === 'storage' && error.status === 500,
    );
    assert.equal(current.get('deck'), previous);
    assert.equal(
      calls.some((call) => call.kind === 'commit'),
      false,
    );
  });
}

test('commit failure preserves current and sanitizes provider details', async () => {
  const { options, current } = memoryOptions({ failCommit: () => true });
  current.set('deck', { title: 'Previous' });
  await assert.rejects(
    publishDeck(options, 'deck', { markdown: '# New' }, async (input) => compileResult(input)),
    (error) => error.phase === 'commit' && !error.message.includes('private'),
  );
  assert.equal(current.get('deck').title, 'Previous');
});

test('a newer failed publish invalidates the earlier opaque token while preserving current', async () => {
  const { options, current, calls } = memoryOptions();
  const initial = await publishDeck(options, 'deck', { markdown: '# Initial' }, async (input) =>
    compileResult(input),
  );
  let entered, resume;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const older = publishDeck(options, 'deck', { markdown: '# Older' }, async (input) => {
    entered();
    await gate;
    return compileResult(input);
  });
  await started;
  await assert.rejects(
    publishDeck(options, 'deck', { markdown: '# Failed latest' }, async () => {
      throw new Error('private compiler detail');
    }),
    (error) => error.phase === 'compiler',
  );
  resume();
  assert.equal((await older).published, false);
  assert.equal(current.get('deck').revision, initial.manifest.revision);
  assert.equal(calls.at(-1).token, 'lease:2');
});

test('a failed begin does not invalidate a successfully reserved older publication', async () => {
  let rejectBegin = false;
  const { options, current } = memoryOptions({ failBegin: () => rejectBegin });
  let entered, resume;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const older = publishDeck(options, 'deck', { markdown: '# Older' }, async (input) => {
    entered();
    await gate;
    return compileResult(input);
  });
  await started;
  rejectBegin = true;
  await assert.rejects(
    publishDeck(options, 'deck', { markdown: '# Failed begin' }, compileResult),
    (error) => error.phase === 'commit',
  );
  resume();
  assert.equal((await older).published, true);
  assert.equal(current.get('deck').title, 'Older');
});

test('shared HTTP preserves publishing, public catalog, native playback and legacy response bytes', async () => {
  const { options, values } = memoryOptions();
  const server = createHubServer(options);
  const published = await server.fetch(
    new Request('http://localhost/api/decks/group/deck', {
      method: 'POST',
      body: JSON.stringify({
        markdown: '---\ntitle: Public\nnotes: Secret\n---\n# Public\n<!-- Secret -->',
      }),
    }),
  );
  assert.equal(published.status, 200);
  assert.equal(published.headers.get('cache-control'), 'no-store');
  const result = await published.json();
  assert.equal(result.published, true);
  assert.equal(result.cached, false);
  const current = await server.fetch(new Request('http://localhost/api/decks/group/deck'));
  const manifest = await current.json();
  assert.equal(JSON.stringify(manifest).includes('Secret'), false);
  assert.ok([...values.keys()].some((key) => key.startsWith('private/')));
  const legacy = await server.fetch(new Request('http://localhost/api/catalog'));
  assert.equal(await legacy.text(), JSON.stringify({ decks: [manifest], truncated: false }));
  const catalog = await (await server.fetch(new Request('http://localhost/catalog.json'))).json();
  assert.equal(catalog.decks[0].entry, manifest.entry);
  assert.deepEqual(catalog.categories, [
    { id: 'group', name: 'group', path: ['group'], parentId: null },
  ]);
  const native = await server.fetch(new Request('http://localhost/native-player.json'));
  assert.equal(
    await native.text(),
    JSON.stringify({
      schemaVersion: 2,
      protocolVersion: 1,
      decks: [
        {
          id: manifest.id,
          revision: manifest.revision,
          entry: '/group/deck/1',
          playback: { kind: 'revision-query', parameter: 'revision' },
          clickTotals: [0],
        },
      ],
      unsupportedDecks: [],
    }),
  );
  const retry = await server.fetch(
    new Request('http://localhost/api/decks/group/deck', {
      method: 'POST',
      body: JSON.stringify({
        markdown: '---\ntitle: Public\nnotes: Secret\n---\n# Public\n<!-- Secret -->',
      }),
    }),
  );
  assert.equal((await retry.json()).cached, true);
});

test('HTTP pins old revisions and release bytes retain metadata and immutable cache headers', async () => {
  const { options } = memoryOptions();
  const server = createHubServer(options);
  const older = await publishDeck(options, 'deck', { markdown: '# Older' }, async (input) =>
    compileResult(input),
  );
  await publishDeck(options, 'deck', { markdown: '# Latest' }, async (input) =>
    compileResult(input),
  );
  const pinned = await server.fetch(
    new Request(`http://localhost/api/decks/deck?revision=${older.manifest.revision}`),
  );
  assert.equal((await pinned.json()).title, 'Older');
  const module = await server.fetch(
    new Request(`http://localhost${older.manifest.slides[0].module}`),
  );
  assert.equal(await module.text(), 'export default {}');
  assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(module.headers.get('etag'), '"opaque-etag"');
  assert.equal(module.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('HTTP auth and validation reject mutations before storage and avoid static fallback for private/API paths', async () => {
  const { options, calls } = memoryOptions();
  const server = createHubServer({ ...options, allowLocalMutations: false, publishToken: 'token' });
  const unauthorized = await server.fetch(
    new Request('https://hub.test/api/decks/deck', { method: 'POST', body: '{}' }),
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(await unauthorized.text(), '{"error":"Authentication required","phase":"auth"}');
  assert.equal(calls.length, 0);
  for (const path of [
    '/api/missing',
    '/private/deck/source.json',
    '/index/deck.json',
    '/releases/missing/1.js',
    '/_runtime/missing.js',
    '/missing.css',
  ]) {
    const response = await server.fetch(new Request(`https://hub.test${path}`));
    assert.equal(response.status, 404);
    assert.notEqual(response.headers.get('content-type'), 'text/html');
  }
  const method = await server.fetch(
    new Request('https://hub.test/catalog.json', { method: 'POST' }),
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET');
  const invalid = await server.fetch(
    new Request('https://hub.test/api/decks/deck', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: 'invalid',
    }),
  );
  assert.equal(invalid.status, 400);
});

test('thumbnail upload preserves first image and optional rendering retains the revision query', async () => {
  const { options } = memoryOptions();
  const release = await publishDeck(options, 'deck', { markdown: '# Deck' }, async (input) =>
    compileResult(input),
  );
  let target;
  const server = createHubServer({
    ...options,
    renderThumbnail: async (url) => {
      target = new URL(url);
      return { bytes: pngHeader(), usedMs: 7 };
    },
  });
  const created = await server.fetch(
    new Request('http://localhost/api/thumbnail/deck', { method: 'POST' }),
  );
  assert.equal((await created.json()).usedMs, 7);
  assert.equal(target.searchParams.get('revision'), release.manifest.revision);
  assert.equal(target.searchParams.get('labThumbnail'), 'true');
  const cached = await server.fetch(
    new Request('http://localhost/api/thumbnail/deck', { method: 'PUT', body: new Uint8Array() }),
  );
  assert.equal((await cached.json()).status, 'cached');
});

test('HTTP reports a superseded publication as 409 without replacing current', async () => {
  const { options, current } = memoryOptions();
  options.publications.commit = async () => false;
  const response = await createHubServer(options).fetch(
    new Request('http://localhost/api/decks/deck', {
      method: 'POST',
      body: JSON.stringify({ markdown: '# Superseded' }),
    }),
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).published, false);
  assert.equal(current.has('deck'), false);
});

test('HTTP keeps upload PNG validation, unavailable rendering, and publish body limits', async () => {
  const { options } = memoryOptions();
  await publishDeck(options, 'deck', { markdown: '# Deck' }, async (input) => compileResult(input));
  const server = createHubServer(options);
  const unavailable = await server.fetch(
    new Request('http://localhost/api/thumbnail/deck', { method: 'POST' }),
  );
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).status, 'unavailable');
  const invalid = await server.fetch(
    new Request('http://localhost/api/thumbnail/deck', { method: 'PUT', body: 'invalid PNG' }),
  );
  assert.equal(invalid.status, 400);
  const uploaded = await server.fetch(
    new Request('http://localhost/api/thumbnail/deck', { method: 'PUT', body: pngHeader() }),
  );
  assert.equal((await uploaded.json()).status, 'uploaded');
  const tooLarge = await server.fetch(
    new Request('http://localhost/api/decks/deck', {
      method: 'POST',
      body: 'x'.repeat(512 * 1024 + 1),
    }),
  );
  assert.equal(tooLarge.status, 400);
  assert.equal(await tooLarge.text(), '{"error":"Request body is too large","phase":"request"}');
});

test('published documents work with reserved category names while private files and missing modules stay hidden', async () => {
  const { options } = memoryOptions();
  const staticRequests = [];
  options.staticAssets.fetch = async (request) => {
    staticRequests.push(new URL(request.url));
    return new URL(request.url).pathname === '/index.html'
      ? new Response('<!doctype html><title>Player</title>', {
          headers: { 'content-type': 'text/html' },
        })
      : new Response('Not found', { status: 404 });
  };
  const server = createHubServer(options);
  for (const id of [
    'private/deck',
    'index/deck',
    'source/deck',
    'src/deck',
    'sources/deck',
    'releases/deck',
    'api/group',
    'runtimes/group',
  ]) {
    const published = await server.fetch(
      new Request(`http://localhost/api/decks/${id}`, {
        method: 'POST',
        body: JSON.stringify({ markdown: '# Public document\n<!-- Private source -->' }),
      }),
    );
    assert.equal(published.status, 200, id);
    const manifest = await published.json();
    const entry = new URL(manifest.entry, 'http://localhost');
    const documentRequest = new Request(entry);
    assert.equal(documentRequest.headers.get('accept'), null);
    const document = await server.fetch(documentRequest);
    assert.equal(document.status, 200, id);
    assert.equal(await document.text(), '<!doctype html><title>Player</title>');
    assert.equal(document.headers.get('location'), null);
    const wildcardAccept = await server.fetch(new Request(entry, { headers: { accept: '*/*' } }));
    assert.equal(wildcardAccept.status, 200);
    assert.equal(staticRequests.at(-1).pathname, '/index.html');
    assert.equal(staticRequests.at(-1).searchParams.get('revision'), manifest.revision);
    const head = await server.fetch(new Request(entry, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const badPage = new URL(entry);
    badPage.pathname = `/${id}/2`;
    assert.equal((await server.fetch(new Request(badPage))).status, 404);
    const badRevision = new URL(entry);
    badRevision.searchParams.set('revision', 'a'.repeat(64));
    assert.equal((await server.fetch(new Request(badRevision))).status, 404);
    assert.equal(
      (await server.fetch(new Request(`http://localhost/private/${id}/${manifest.revision}.json`)))
        .status,
      404,
    );
  }
  assert.equal(
    (await server.fetch(new Request('http://localhost/_runtime/missing.js'))).status,
    404,
  );
});
