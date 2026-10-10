import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  createFileArtifactStore,
  createMemoryPublicationStore,
  createStaticAssets,
  startHubServer,
} from '../dist/index.js';

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'hub-node-adapter-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function bodyOf(object) {
  return Buffer.from(await new Response(object.body).arrayBuffer());
}

test('file artifacts preserve bytes and metadata across store instances', async () => {
  const root = await temporaryDirectory();
  const first = createFileArtifactStore({ root });
  const bytes = Uint8Array.from([0, 255, 17, 128]);
  assert.equal(await first.get('deck/assets/image.bin'), null);
  assert.equal(await first.head('deck/assets/image.bin'), null);
  assert.equal(
    await first.put('deck/assets/image.bin', bytes, { contentType: 'application/octet-stream' }),
    true,
  );

  const second = createFileArtifactStore({ root });
  const found = await second.get('deck/assets/image.bin');
  assert.ok(found);
  assert.deepEqual(await bodyOf(found), Buffer.from(bytes));
  assert.equal(found.contentType, 'application/octet-stream');
  assert.equal(found.size, bytes.byteLength);
  assert.match(found.etag, /^"[a-f0-9]{64}"$/);
  assert.deepEqual(await second.head('deck/assets/image.bin'), {
    contentType: 'application/octet-stream',
    etag: found.etag,
    size: bytes.byteLength,
  });
});

test('file artifact ifAbsent is atomic across store instances and pagination is ordered', async () => {
  const root = await temporaryDirectory();
  const a = createFileArtifactStore({ root });
  const b = createFileArtifactStore({ root });
  const outcomes = await Promise.all([
    a.put('deck/a', 'first', { ifAbsent: true }),
    b.put('deck/a', 'second', { ifAbsent: true }),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  await a.put('deck/b', 'b');
  await a.put('other/c', 'c');
  const firstPage = await a.list({ prefix: 'deck/', limit: 1 });
  assert.deepEqual(firstPage.keys, ['deck/a']);
  assert.ok(firstPage.cursor);
  assert.deepEqual(await b.list({ prefix: 'deck/', limit: 1, cursor: firstPage.cursor }), {
    keys: ['deck/b'],
  });
  assert.deepEqual(await b.list({ prefix: 'other/', limit: 4 }), { keys: ['other/c'] });
  await assert.rejects(b.list({ prefix: 'deck/', limit: 1, cursor: 'wrong' }), /cursor/i);
});

test('file artifacts reject traversal, absolute paths, backslashes and symlink escape', async () => {
  const root = await temporaryDirectory();
  const outside = await temporaryDirectory();
  const store = createFileArtifactStore({ root });
  for (const key of ['../secret', '/absolute', 'C:/secret', 'deck\\secret', 'deck/\0secret']) {
    await assert.rejects(store.get(key), /invalid artifact key/i);
  }
  await symlink(outside, join(root, 'escape'));
  await assert.rejects(store.put('escape/secret', 'nope'));
  await writeFile(join(outside, 'secret.obj'), 'outside');
  assert.equal(await readFile(join(outside, 'secret.obj'), 'utf8'), 'outside');
});

test('memory publication store keeps previous current while latest begin wins and clones JSON', async () => {
  const store = createMemoryPublicationStore();
  const firstToken = await store.begin('deck');
  const initial = { title: 'first', nested: { value: 1 } };
  assert.equal(await store.commit('deck', firstToken, initial), true);
  initial.nested.value = 9;
  const secondToken = await store.begin('deck');
  assert.deepEqual(await store.current('deck'), { title: 'first', nested: { value: 1 } });
  assert.equal(await store.commit('deck', firstToken, { stale: true }), false);
  const next = { title: 'second' };
  assert.equal(await store.commit('deck', secondToken, next), true);
  next.title = 'changed';
  assert.deepEqual(await store.current('deck'), { title: 'second' });
  const current = await store.current('deck');
  current.title = 'mutated';
  assert.deepEqual(await store.current('deck'), { title: 'second' });
});

test('static assets serve files, SPA documents, and reject API or missing module fallbacks', async () => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<main>runtime</main>');
  await writeFile(join(root, 'assets', 'app.js'), 'export default 1;');
  await mkdir(join(root, 'private'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'slides'));
  await writeFile(join(root, 'private', 'secret.js'), 'private');
  await writeFile(join(root, 'src', 'source.ts'), 'source');
  await writeFile(join(root, 'slides', 'original.md'), 'original source');
  await symlink(join(root, 'src', 'source.ts'), join(root, 'visible.js'));
  const outside = await temporaryDirectory();
  await writeFile(join(outside, 'secret.js'), 'outside');
  await symlink(outside, join(root, 'leak'));
  const assets = createStaticAssets({ root });
  const index = await assets.fetch(new Request('http://local/'));
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal(await index.text(), '<main>runtime</main>');
  const module = await assets.fetch(new Request('http://local/assets/app.js'));
  assert.match(module.headers.get('content-type'), /javascript/);
  assert.equal(await module.text(), 'export default 1;');
  assert.equal(
    (
      await assets.fetch(
        new Request('http://local/slides/one', { headers: { accept: 'text/html' } }),
      )
    ).status,
    200,
  );
  for (const url of [
    '/api/missing',
    '/releases/deck',
    '/assets/missing.js',
    '/assets/missing.css',
    '/assets/missing.json',
    '/private/secret.js',
    '/%70rivate/secret.js',
    '/src/source.ts',
    '/slides/original.md',
    '/visible.js',
    '/leak/secret.js',
  ]) {
    assert.equal(
      (await assets.fetch(new Request(`http://local${url}`, { headers: { accept: 'text/html' } })))
        .status,
      404,
    );
  }
  assert.equal((await assets.fetch(new Request('http://local/', { method: 'POST' }))).status, 405);
  assert.equal((await assets.fetch(new Request('http://local/', { method: 'HEAD' }))).status, 200);
});

test('HTTP server streams Fetch request and response bodies on an ephemeral port and closes', async () => {
  const running = await startHubServer({
    server: {
      async fetch(request) {
        const body = await request.text();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`got:${body}`));
              controller.close();
            },
          }),
        );
      },
    },
    port: 0,
  });
  try {
    assert.match(running.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(running.origin, { method: 'POST', body: 'streamed request' });
    assert.equal(await response.text(), 'got:streamed request');
  } finally {
    await running.close();
  }
  await assert.rejects(fetch(running.origin), /fetch failed/i);
});
