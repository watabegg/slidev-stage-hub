import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { createGcsArtifactStore } from '../dist/index.js';

function fakeClient({
  read = Buffer.from([0, 255]),
  metadata = { contentType: 'image/png', etag: 'opaque=', size: '2', generation: '41' },
  files = [],
} = {}) {
  const calls = [];
  const fileOptions = [];
  const bucket = {
    file(name, options) {
      fileOptions.push({ name, options });
      return {
        name,
        options,
        metadata,
        getMetadata: async () => {
          calls.push(['metadata', name]);
          return [metadata];
        },
        createReadStream: () => {
          calls.push(['read', name]);
          return Readable.from([read]);
        },
        createWriteStream: (options) => {
          calls.push(['write', name, options]);
          return new Writable({
            write(chunk, encoding, callback) {
              calls.push(['chunk', Buffer.from(chunk)]);
              callback();
            },
          });
        },
      };
    },
    getFiles: async (query) => {
      calls.push(['list', query]);
      return [
        files.map((name) => ({ name })),
        query.pageToken ? null : { pageToken: 'next/page+' },
      ];
    },
  };
  return { calls, fileOptions, bucket: () => bucket };
}

test('GCS get/head expose metadata and preserve streamed bytes', async () => {
  const client = fakeClient();
  const store = createGcsArtifactStore({ bucket: 'slides', client });
  const object = await store.get('deck/a.png');
  assert.deepEqual([...new Uint8Array(await new Response(object.body).arrayBuffer())], [0, 255]);
  assert.deepEqual(await store.head('deck/a.png'), {
    contentType: 'image/png',
    etag: '"opaque="',
    size: 2,
  });
  assert.deepEqual(
    client.calls.slice(0, 3).map((call) => call[0]),
    ['metadata', 'read', 'metadata'],
  );
  assert.deepEqual(client.fileOptions[1], { name: 'deck/a.png', options: { generation: '41' } });
});

test('GCS only treats numeric 404 as missing', async () => {
  const absent = {
    bucket: () => ({
      file: () => ({
        getMetadata: async () => {
          throw Object.assign(new Error('missing'), { code: 404 });
        },
      }),
    }),
  };
  assert.equal(await createGcsArtifactStore({ bucket: 'b', client: absent }).head('x'), null);
  const denied = {
    bucket: () => ({
      file: () => ({
        getMetadata: async () => {
          throw Object.assign(new Error('denied'), { code: 403 });
        },
      }),
    }),
  };
  await assert.rejects(createGcsArtifactStore({ bucket: 'b', client: denied }).get('x'), /denied/u);
});

test('GCS writes use create-only generation condition, content type, and keep body bytes', async () => {
  const client = fakeClient();
  const store = createGcsArtifactStore({ bucket: 'slides', client });
  assert.equal(
    await store.put('deck/a.png', new Uint8Array([0, 255]), {
      contentType: 'image/png',
      ifAbsent: true,
    }),
    true,
  );
  assert.deepEqual(client.calls.find((call) => call[0] === 'write')[2], {
    resumable: false,
    metadata: { contentType: 'image/png' },
    preconditionOpts: { ifGenerationMatch: 0 },
  });
  assert.deepEqual([...client.calls.find((call) => call[0] === 'chunk')[1]], [0, 255]);
  const exists = {
    bucket: () => ({
      file: () => ({
        createWriteStream: () =>
          new Writable({
            write(_chunk, _encoding, callback) {
              callback(Object.assign(new Error('exists'), { code: 412 }));
            },
          }),
      }),
    }),
  };
  assert.equal(
    await createGcsArtifactStore({ bucket: 'b', client: exists }).put('x', 'x', { ifAbsent: true }),
    false,
  );
  const denied = {
    bucket: () => ({
      file: () => ({
        createWriteStream: () =>
          new Writable({
            write(_chunk, _encoding, callback) {
              callback(Object.assign(new Error('denied'), { code: 403 }));
            },
          }),
      }),
    }),
  };
  await assert.rejects(
    createGcsArtifactStore({ bucket: 'b', client: denied }).put('x', 'x', { ifAbsent: true }),
    /denied/u,
  );
});

test('GCS listing forwards page tokens, prefix, and bounded page size', async () => {
  const client = fakeClient({ files: ['root/a', 'outside/b'] });
  const store = createGcsArtifactStore({ bucket: 'slides', client });
  assert.deepEqual(await store.list({ prefix: 'root/', limit: 2000 }), {
    keys: ['root/a'],
    cursor: 'next/page+',
  });
  assert.deepEqual(client.calls[0][1], { prefix: 'root/', maxResults: 1000, autoPaginate: false });
  await store.list({ prefix: 'root/', limit: 50, cursor: 'opaque+' });
  assert.equal(client.calls[1][1].pageToken, 'opaque+');
  await assert.rejects(store.list({ prefix: '', limit: -1 }), RangeError);
});

test('GCS accepts strings and Web streams as write bodies', async () => {
  const client = fakeClient();
  const store = createGcsArtifactStore({ bucket: 'slides', client });
  assert.equal(await store.put('deck/text', 'hello'), true);
  const webBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([65, 0, 66]));
      controller.close();
    },
  });
  assert.equal(await store.put('deck/binary', webBody), true);
  assert.deepEqual(
    client.calls.filter((call) => call[0] === 'chunk').map((call) => [...call[1]]),
    [
      [104, 101, 108, 108, 111],
      [65, 0, 66],
    ],
  );
});
