import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { createS3ArtifactStore } from '../dist/index.js';

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startFixture() {
  const objects = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    const [, bucket, ...parts] = url.pathname.split('/');
    const key = parts.map(decodeURIComponent).join('/');
    if (bucket !== 'slides') {
      response
        .writeHead(404, { 'content-type': 'application/xml' })
        .end('<Error><Code>NoSuchBucket</Code><Message>bucket missing</Message></Error>');
      return;
    }
    if (request.method === 'GET' && url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((name) => name.startsWith(prefix));
      const contents = keys
        .map(
          (name) =>
            `<Contents><Key>${xmlEscape(name)}</Key><Size>${objects.get(name).body.length}</Size><ETag>"fixture-etag"</ETag></Contents>`,
        )
        .join('');
      response
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<ListBucketResult><Name>slides</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      return;
    }
    if (key === 'forbidden') {
      response
        .writeHead(403, { 'content-type': 'application/xml' })
        .end('<Error><Code>AccessDenied</Code><Message>fixture denied</Message></Error>');
      return;
    }
    if (request.method === 'PUT') {
      const body = await readRequest(request);
      assert.equal(Number(request.headers['content-length']), body.byteLength);
      assert.equal(request.headers['transfer-encoding'], undefined);
      if (request.headers['if-none-match'] === '*' && objects.has(key)) {
        response
          .writeHead(412, { 'content-type': 'application/xml' })
          .end('<Error><Code>PreconditionFailed</Code><Message>object exists</Message></Error>');
        return;
      }
      objects.set(key, {
        body,
        contentType: request.headers['content-type'] ?? 'application/octet-stream',
      });
      response.writeHead(200, { ETag: '"fixture-etag"' }).end();
      return;
    }
    const object = objects.get(key);
    if (object === undefined) {
      response
        .writeHead(404, { 'content-type': 'application/xml' })
        .end('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
      return;
    }
    const headers = {
      'content-type': object.contentType,
      'content-length': object.body.length,
      etag: '"fixture-etag"',
    };
    if (request.method === 'HEAD') {
      response.writeHead(200, headers).end();
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(200, headers).end(object.body);
      return;
    }
    response.writeHead(405).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    objects,
    endpoint: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

test('S3 SDK serializes string, byte, and Web-stream bodies through HTTP and reads responses', async (t) => {
  const fixture = await startFixture();
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: fixture.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' },
  });
  t.after(async () => {
    client.destroy();
    await fixture.close();
  });
  const store = createS3ArtifactStore({ bucket: 'slides', client });
  const binary = new Uint8Array([99, 0, 255, 65, 66]);
  const bodies = [
    ['string', 'utf8 π', new TextEncoder().encode('utf8 π')],
    ['bytes', binary.subarray(1, 4), binary.subarray(1, 4)],
    [
      'web-stream',
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 255, 65]));
          controller.enqueue(new Uint8Array([0, 66]));
          controller.close();
        },
      }),
      new Uint8Array([0, 255, 65, 0, 66]),
    ],
  ];

  for (const [key, body, expected] of bodies) {
    assert.equal(
      await store.put(`wire/${key}`, body, { contentType: 'application/octet-stream' }),
      true,
    );
    assert.deepEqual(fixture.objects.get(`wire/${key}`).body, Buffer.from(expected));
    const head = await store.head(`wire/${key}`);
    assert.deepEqual(head, {
      contentType: 'application/octet-stream',
      etag: '"fixture-etag"',
      size: expected.byteLength,
    });
    const object = await store.get(`wire/${key}`);
    assert.ok(object);
    assert.deepEqual(
      Buffer.from(await new Response(object.body).arrayBuffer()),
      Buffer.from(expected),
    );
  }

  assert.equal(await store.put('wire/string', 'overwrite', { ifAbsent: true }), false);
  assert.equal(await store.get('missing'), null);
  await assert.rejects(store.put('forbidden', 'x', { ifAbsent: true }), /fixture denied/u);
  const missingBucket = createS3ArtifactStore({ bucket: 'missing-bucket', client });
  await assert.rejects(missingBucket.get('key'), /bucket missing/u);
  assert.deepEqual(await store.list({ prefix: 'wire/', limit: 20 }), {
    keys: ['wire/string', 'wire/bytes', 'wire/web-stream'],
  });
});
