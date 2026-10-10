import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditRuntimeRetention,
  compileDeck,
  createHubServer,
  publishDeck,
  runtimeSnapshotFromManifest,
} from '../dist/index.js';
import { compileResult, memoryOptions } from './support.mjs';

async function hash(body) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
async function runtime(id = 'a'.repeat(64), label = 'A') {
  const bodies = new Map([
    [
      'index.html',
      `<!doctype html><html><head><base href="/runtimes/${id}/"><title>${label}</title></head><body></body></html>`,
    ],
    ['_runtime/vue.js', `export const runtime = '${label}'`],
    ['_runtime/bridge.js', 'export const slideSetup = () => ({})'],
    ['assets/app.css', `/* ${label} */`],
    ['assets/font.woff2', 'font bytes'],
  ]);
  const files = await Promise.all(
    [...bodies].map(async ([path, body]) => ({
      path,
      sha256: await hash(body),
      size: new TextEncoder().encode(body).length,
      contentType: path.endsWith('.html')
        ? 'text/html'
        : path.endsWith('.css')
          ? 'text/css'
          : path.endsWith('.woff2')
            ? 'font/woff2'
            : 'text/javascript',
    })),
  );
  return {
    snapshot: { schemaVersion: 1, id, files: files.sort((a, b) => a.path.localeCompare(b.path)) },
    bodies,
  };
}
function source(options, fixture) {
  const requests = [];
  options.loadRuntime = async () => fixture.snapshot;
  options.staticAssets.fetch = async (request) => {
    requests.push(new URL(request.url).pathname);
    const path = new URL(request.url).pathname.replace(`/runtimes/${fixture.snapshot.id}/`, '');
    return fixture.bodies.has(path)
      ? new Response(fixture.bodies.get(path))
      : new Response('', { status: 404 });
  };
  return requests;
}
async function publish(options, text = '# Same', compiler = compileResult) {
  return publishDeck(options, 'group/deck', { markdown: text }, compiler);
}

test('descriptor validation keeps old builds and rejects malformed or unsafe snapshots', async () => {
  const { snapshot } = await runtime();
  assert.equal(runtimeSnapshotFromManifest({ profileDigest: 'old' }), undefined);
  assert.deepEqual(runtimeSnapshotFromManifest({ runtime: snapshot }), snapshot);
  for (const raw of [
    null,
    [],
    { runtime: undefined },
    { runtime: null },
    { runtime: { ...snapshot, id: 'bad' } },
    { runtime: { ...snapshot, schemaVersion: 2 } },
    { runtime: { ...snapshot, files: snapshot.files.slice(1) } },
    { runtime: { ...snapshot, files: [...snapshot.files, snapshot.files[0]] } },
    { runtime: { ...snapshot, files: Array(4097).fill(snapshot.files[0]) } },
  ])
    assert.throws(() => runtimeSnapshotFromManifest(raw));
  for (const path of [
    'assets/../x.js',
    'assets/./x.js',
    'assets//x.js',
    '/assets/x.js',
    'assets/x%20.js',
    'assets/x.js?q',
    'assets/x.js#q',
    'assets/x\\y.js',
    'assets/x\u0000.js',
    'assets/private/x.js',
    'assets/source/x.js',
    'assets/x.js.map',
    'assets/x.vue',
    'private/x.js',
    'runtime-manifest.json',
  ]) {
    assert.throws(
      () =>
        runtimeSnapshotFromManifest({
          runtime: { ...snapshot, files: [...snapshot.files, { ...snapshot.files[0], path }] },
        }),
      path,
    );
  }
  for (const patch of [
    { size: -1 },
    { size: 0.5 },
    { size: 128 * 1024 * 1024 + 1 },
    { sha256: 'not a hash' },
    { contentType: 'text/javascript\r\ninjected: true' },
  ]) {
    assert.throws(() =>
      runtimeSnapshotFromManifest({
        runtime: {
          ...snapshot,
          files: snapshot.files.map((file, i) => (i === 0 ? { ...file, ...patch } : file)),
        },
      }),
    );
  }
});

test('archive is ready before release, immutable, reusable and separates identical inputs across runtimes', async () => {
  const { options, values, calls } = memoryOptions();
  const fixtureA = await runtime();
  const requestsA = source(options, fixtureA);
  let compilerInput;
  const a = await publish(options, '# Same', (input) => {
    compilerInput = input;
    return compileResult(input);
  });
  assert.equal(a.manifest.runtimeId, fixtureA.snapshot.id);
  assert.equal(compilerInput.runtimeBase, `/runtimes/${fixtureA.snapshot.id}/_runtime/`);
  const readyWrite = calls.findIndex((call) => call.key?.startsWith('runtime-index/'));
  const firstRelease = calls.findIndex((call) => call.key?.startsWith('private/'));
  assert.ok(readyWrite > 0 && readyWrite < firstRelease);
  assert.equal(requestsA.length, fixtureA.snapshot.files.length);
  const before = new Map([...values].map(([key, value]) => [key, [...value.bytes]]));
  const retried = await publish(options);
  assert.equal(retried.cached, true);
  assert.equal(requestsA.length, fixtureA.snapshot.files.length);
  const fixtureB = await runtime('b'.repeat(64), 'B');
  source(options, fixtureB);
  const b = await publish(options);
  assert.notEqual(b.manifest.revision, a.manifest.revision);
  for (const [key, bytes] of before) assert.deepEqual([...values.get(key).bytes], bytes);
});

test('incomplete runtime writes preserve current and successful retry completes the ready marker last', async () => {
  let fail = true;
  const { options, current, values } = memoryOptions({
    failPut: (key) => fail && key.endsWith('/assets/app.css'),
  });
  current.set('group/deck', { title: 'Previous' });
  const fixture = await runtime();
  source(options, fixture);
  await assert.rejects(publish(options), (error) => error.phase === 'storage');
  assert.equal(current.get('group/deck').title, 'Previous');
  assert.equal(values.has(`runtime-index/${fixture.snapshot.id}.json`), false);
  assert.equal(
    [...values.keys()].some((key) => key.startsWith('releases/')),
    false,
  );
  fail = false;
  assert.equal((await publish(options)).published, true);
  assert.equal(values.has(`runtime-index/${fixture.snapshot.id}.json`), true);
});

test('source failure, incorrect bytes, existing object collisions and descriptor collisions fail closed', async () => {
  for (const mode of [
    'unavailable',
    'size',
    'hash',
    'existing',
    'descriptor',
    'loader',
    'marker',
  ]) {
    const { options, current, values } = memoryOptions({
      failPut: (key) => mode === 'marker' && key.startsWith('runtime-index/'),
    });
    current.set('group/deck', { title: 'Previous' });
    const fixture = await runtime();
    source(options, fixture);
    const file = fixture.snapshot.files[0];
    if (mode === 'unavailable') fixture.bodies.delete(file.path);
    if (mode === 'size') fixture.bodies.set(file.path, 'too many bytes '.repeat(50));
    if (mode === 'hash') fixture.bodies.set(file.path, 'x'.repeat(file.size));
    if (mode === 'existing')
      await options.artifacts.put(`runtimes/${fixture.snapshot.id}/${file.path}`, 'conflicting');
    if (mode === 'descriptor')
      await options.artifacts.put(
        `runtime-index/${fixture.snapshot.id}.json`,
        JSON.stringify({
          ...fixture.snapshot,
          files: fixture.snapshot.files.map((entry, i) =>
            i === 0 ? { ...entry, sha256: 'c'.repeat(64) } : entry,
          ),
        }),
      );
    if (mode === 'loader')
      options.loadRuntime = async () => {
        throw new Error('secret');
      };
    await assert.rejects(
      publish(options),
      (error) => error.phase === 'storage' && !error.message.includes('secret'),
      mode,
    );
    assert.equal(current.get('group/deck').title, 'Previous', mode);
    assert.equal(
      [...values.keys()].some((key) => key.startsWith('releases/')),
      false,
      mode,
    );
  }
});

test('conditional runtime races verify winning object and readiness descriptor', async () => {
  for (const collision of [false, true]) {
    const { options } = memoryOptions();
    const fixture = await runtime();
    source(options, fixture);
    const put = options.artifacts.put;
    let raced = false;
    options.artifacts.put = async (key, body, metadata) => {
      if (!raced && key.startsWith('runtimes/')) {
        raced = true;
        await put(key, collision ? 'collision' : body, metadata);
        return false;
      }
      if (key.startsWith('runtime-index/')) {
        await put(key, body, metadata);
        return false;
      }
      return put(key, body, metadata);
    };
    if (collision) await assert.rejects(publish(options), /Could not preserve/);
    else assert.equal((await publish(options)).published, true);
  }
});

test('pinned documents and all archived assets survive STATIC replacement, include revision meta, and never fallback', async () => {
  const { options, current, values } = memoryOptions();
  const fixtureA = await runtime();
  source(options, fixtureA);
  const a = await publish(options, '# A');
  const fixtureB = await runtime('b'.repeat(64), 'B');
  source(options, fixtureB);
  const b = await publish(options, '# B');
  let staticCalls = 0;
  options.staticAssets.fetch = async () => {
    staticCalls++;
    throw new Error('A removed');
  };
  const server = createHubServer(options);
  for (const [manifest, title] of [
    [a.manifest, 'A'],
    [b.manifest, 'B'],
  ]) {
    const response = await server.fetch(new Request(`http://localhost${manifest.entry}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('location'), null);
    const html = await response.text();
    assert.match(html, new RegExp(`<title>${title}</title>`));
    assert.ok(html.includes(`<meta name="hub-revision" content="${manifest.revision}">`));
    const head = await server.fetch(
      new Request(`http://localhost${manifest.entry}`, { method: 'HEAD' }),
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  const originalCurrent = options.publications.current;
  options.publications.current = async (id) => {
    const selected = await originalCurrent(id);
    current.set(id, a.manifest);
    return selected;
  };
  const selected = await server.fetch(new Request('http://localhost/group/deck/1'));
  assert.ok((await selected.text()).includes(`content="${b.manifest.revision}"`));
  for (const file of fixtureA.snapshot.files) {
    const url = `http://localhost/runtimes/${fixtureA.snapshot.id}/${file.path}`;
    const response = await server.fetch(new Request(url));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), fixtureA.bodies.get(file.path));
    assert.equal(response.headers.get('content-type'), file.contentType);
    assert.equal(response.headers.get('etag'), '"opaque-etag"');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const head = await server.fetch(new Request(url, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  for (const path of [
    `/runtimes/${fixtureA.snapshot.id}/private/source.json`,
    `/runtimes/${fixtureA.snapshot.id}/assets/missing.js`,
    '/runtimes/bad/index.html',
  ])
    assert.equal((await server.fetch(new Request(`http://localhost${path}`))).status, 404);
  values.delete(`runtime-index/${fixtureA.snapshot.id}.json`);
  assert.equal(
    (await server.fetch(new Request(`http://localhost${a.manifest.entry}`))).status,
    503,
  );
  assert.equal(staticCalls, 0);
});

test('malformed runtime descriptor and missing pinned HTML return 503', async () => {
  for (const corrupt of ['index', 'html']) {
    const { options, values } = memoryOptions();
    const fixture = await runtime();
    source(options, fixture);
    const release = await publish(options);
    if (corrupt === 'index')
      await options.artifacts.put(`runtime-index/${fixture.snapshot.id}.json`, '{}');
    else values.delete(`runtimes/${fixture.snapshot.id}/index.html`);
    assert.equal(
      (
        await createHubServer(options).fetch(
          new Request(`http://localhost${release.manifest.entry}`),
        )
      ).status,
      503,
    );
  }
});

test('legacy loader absence or undefined preserves hash, compiler imports and static response bytes', async () => {
  const a = memoryOptions();
  const first = await publish(a.options);
  const b = memoryOptions();
  b.options.loadRuntime = async () => undefined;
  const second = await publish(b.options);
  assert.equal(second.manifest.revision, first.manifest.revision);
  assert.equal(first.manifest.runtimeId, undefined);
  assert.equal(
    await hash(JSON.stringify(['profile-digest', 'native-click-metadata-v1', '# Same', {}])),
    first.manifest.revision,
  );
  const response = await createHubServer(a.options).fetch(
    new Request(`http://localhost${first.manifest.entry}`),
  );
  assert.equal(await response.text(), 'SPA document');
  const legacy = await compileDeck({ markdown: '# Example', deckId: 'deck' });
  assert.match(legacy.slides[0].code, /"\/_runtime\/vue.js"/);
  const pinned = await compileDeck({
    markdown: '# Example',
    deckId: 'deck',
    runtimeBase: `/runtimes/${'a'.repeat(64)}/_runtime/`,
  });
  assert.ok(pinned.slides[0].code.includes(`/runtimes/${'a'.repeat(64)}/_runtime/vue.js`));
  assert.ok(pinned.slides[0].code.includes(`/runtimes/${'a'.repeat(64)}/_runtime/bridge.js`));
  for (const base of ['https://evil/', '/_runtime/../', '/runtimes/bad/_runtime/', '/other/'])
    await assert.rejects(
      compileDeck({ markdown: '# Example', deckId: 'deck', runtimeBase: base }),
      /Invalid runtime/,
    );
});

test('retention audit scans historical and orphan releases, reports legacy and missing archives deterministically', async () => {
  const { options, current } = memoryOptions();
  const a = await runtime();
  source(options, a);
  const first = await publish(options, '# First');
  await publish(options, '# Second');
  current.clear(); // Historical and orphan manifests still protect the snapshot.
  options.loadRuntime = undefined;
  const legacy = await publish(options, '# Legacy');
  const b = await runtime('b'.repeat(64), 'B');
  await options.artifacts.put(`runtime-index/${b.snapshot.id}.json`, JSON.stringify(b.snapshot));
  const missing = 'c'.repeat(64);
  const orphan = { ...first.manifest, revision: 'd'.repeat(64), runtimeId: missing };
  const orphanKey = `releases/group/deck/${orphan.revision}/manifest.json`;
  await options.artifacts.put(orphanKey, JSON.stringify(orphan));
  const result = await auditRuntimeRetention(options);
  assert.deepEqual(result.missingRuntimes, [missing]);
  assert.deepEqual(result.legacyReleases, [
    `releases/group/deck/${legacy.manifest.revision}/manifest.json`,
  ]);
  assert.deepEqual(
    result.runtimes.map(({ id, status }) => ({ id, status })),
    [
      { id: a.snapshot.id, status: 'referenced' },
      { id: b.snapshot.id, status: 'unreferenced' },
    ],
  );
  assert.equal(result.runtimes[0].releaseReferences.length, 2);
  assert.deepEqual(
    result.runtimes[0].releaseReferences,
    [...result.runtimes[0].releaseReferences].sort(),
  );
});

test('retention audit never suggests candidates after corrupt metadata or cyclic/invalid storage pagination', async () => {
  for (const corruption of [
    'manifest',
    'runtimeId',
    'index',
    'mismatchedIndex',
    'cycle',
    'outside',
  ]) {
    const { options } = memoryOptions();
    const fixture = await runtime();
    source(options, fixture);
    const release = await publish(options);
    if (corruption === 'manifest' || corruption === 'runtimeId')
      await options.artifacts.put(
        `releases/group/deck/${release.manifest.revision}/manifest.json`,
        JSON.stringify(corruption === 'manifest' ? {} : { ...release.manifest, runtimeId: 'bad' }),
      );
    if (corruption === 'index' || corruption === 'mismatchedIndex')
      await options.artifacts.put(
        `runtime-index/${fixture.snapshot.id}.json`,
        JSON.stringify(corruption === 'index' ? {} : { ...fixture.snapshot, id: 'b'.repeat(64) }),
      );
    if (corruption === 'cycle')
      options.artifacts.list = async () => ({ keys: [], cursor: 'repeat' });
    if (corruption === 'outside')
      options.artifacts.list = async () => ({ keys: ['private/source.json'] });
    await assert.rejects(auditRuntimeRetention(options), undefined, corruption);
  }
});

test('legacy HTML fixes relative assets at nested routes, selects revision metadata and preserves an existing base', async () => {
  const { options } = memoryOptions();
  const release = await publish(options);
  for (const existingBase of ['', '<base href="/already/">']) {
    const html = `<!doctype html><html><head>${existingBase}<script src="./assets/app.js"></script></head><body></body></html>`;
    options.staticAssets.fetch = async () =>
      new Response(html, {
        headers: {
          'content-type': 'text/html',
          etag: '"old-html"',
          'content-length': String(html.length),
        },
      });
    const server = createHubServer(options);
    const entry = await server.fetch(new Request('http://localhost/group/deck/1'));
    const body = await entry.text();
    assert.equal((body.match(/<base /g) ?? []).length, 1);
    assert.ok(body.includes(existingBase || '<base href="/">'));
    assert.ok(body.includes(`<meta name="hub-revision" content="${release.manifest.revision}">`));
    assert.equal(
      new URL('./assets/app.js', new URL(existingBase ? '/already/' : '/', 'http://localhost'))
        .pathname,
      existingBase ? '/already/assets/app.js' : '/assets/app.js',
    );
    assert.equal(entry.headers.get('cache-control'), 'no-store');
    assert.equal(entry.headers.get('etag'), null);
    assert.equal(entry.headers.get('content-length'), null);
    const head = await server.fetch(
      new Request('http://localhost/group/deck/1', { method: 'HEAD' }),
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const root = await server.fetch(new Request('http://localhost/'));
    assert.equal(await root.text(), html, 'root catalog remains unchanged');
  }
});

test('a ready marker cannot hide missing or conflicting archive bytes before republishing', async () => {
  for (const corrupt of ['missing', 'bytes']) {
    const { options, current, values } = memoryOptions();
    const fixture = await runtime();
    source(options, fixture);
    const first = await publish(options, '# First');
    const key = `runtimes/${fixture.snapshot.id}/assets/app.css`;
    if (corrupt === 'missing') values.delete(key);
    else await options.artifacts.put(key, 'corrupt');
    await assert.rejects(publish(options, '# Second'), /Could not preserve/);
    assert.equal(current.get('group/deck').revision, first.manifest.revision);
  }
});

test('archive marker race rejects a conflicting descriptor and paginated audit sees every historical release', async () => {
  const { options } = memoryOptions();
  const fixture = await runtime();
  source(options, fixture);
  const put = options.artifacts.put;
  options.artifacts.put = async (key, body, metadata) => {
    if (key.startsWith('runtime-index/')) {
      const changed = {
        ...fixture.snapshot,
        files: fixture.snapshot.files.map((file, i) =>
          i === 0 ? { ...file, size: file.size + 1 } : file,
        ),
      };
      await put(key, JSON.stringify(changed), metadata);
      return false;
    }
    return put(key, body, metadata);
  };
  await assert.rejects(publish(options), /Could not preserve/);
  const other = memoryOptions();
  source(other.options, fixture);
  await publish(other.options, '# First');
  await publish(other.options, '# Second');
  const list = other.options.artifacts.list;
  other.options.artifacts.list = (input) => list({ ...input, limit: 1 });
  const result = await auditRuntimeRetention(other.options);
  assert.equal(result.runtimes[0].releaseReferences.length, 2);
});
