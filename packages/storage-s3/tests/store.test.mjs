import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createS3ArtifactStore } from '../dist/index.js';

function stubClient(respond) {
  const calls = [];
  return {
    calls,
    send: async (command) => {
      calls.push(command);
      return respond(command);
    },
  };
}

test('S3 get/head preserve metadata and only map missing objects to null', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 255]));
      controller.close();
    },
  });
  const client = stubClient((command) => {
    if (command instanceof GetObjectCommand)
      return {
        Body: { transformToWebStream: () => body },
        ContentType: 'application/pdf',
        ContentLength: 2,
        ETag: '"opaque"',
      };
    if (command instanceof HeadObjectCommand)
      return { ContentType: 'application/pdf', ContentLength: 2, ETag: '"opaque"' };
    throw new Error('unexpected command');
  });
  const store = createS3ArtifactStore({ bucket: 'slides', client });
  const object = await store.get('deck/file.pdf');
  assert.deepEqual([...new Uint8Array(await new Response(object.body).arrayBuffer())], [0, 255]);
  assert.equal(object.contentType, 'application/pdf');
  assert.equal(object.etag, '"opaque"');
  assert.deepEqual(await store.head('deck/file.pdf'), {
    contentType: 'application/pdf',
    etag: '"opaque"',
    size: 2,
  });
  assert.ok(client.calls[0] instanceof GetObjectCommand);
  assert.deepEqual(client.calls[0].input, { Bucket: 'slides', Key: 'deck/file.pdf' });

  const missing = createS3ArtifactStore({
    bucket: 'slides',
    client: stubClient(() => {
      throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    }),
  });
  assert.equal(await missing.get('absent'), null);
  const denied = createS3ArtifactStore({
    bucket: 'slides',
    client: stubClient(() => {
      throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
    }),
  });
  await assert.rejects(denied.head('private'), /denied/u);
});

test('S3 conditional put returns false only for precondition failure and preserves bytes', async () => {
  const bodies = [];
  const client = stubClient((command) => {
    assert.ok(command instanceof PutObjectCommand);
    bodies.push(command.input.Body);
    return {};
  });
  const store = createS3ArtifactStore({ bucket: 'slides', client });
  assert.equal(
    await store.put('a', new Uint8Array([0, 255]), {
      contentType: 'application/octet-stream',
      ifAbsent: true,
    }),
    true,
  );
  assert.deepEqual([...bodies[0]], [0, 255]);
  assert.equal(client.calls[0].input.IfNoneMatch, '*');
  assert.equal(client.calls[0].input.ContentType, 'application/octet-stream');

  const exists = createS3ArtifactStore({
    bucket: 'slides',
    client: stubClient(() => {
      throw Object.assign(new Error('exists'), { $metadata: { httpStatusCode: 412 } });
    }),
  });
  assert.equal(await exists.put('a', 'ignored', { ifAbsent: true }), false);
  const conflict = createS3ArtifactStore({
    bucket: 'slides',
    client: stubClient(() => {
      throw Object.assign(new Error('retry'), {
        name: 'ConditionalRequestConflict',
        $metadata: { httpStatusCode: 409 },
      });
    }),
  });
  await assert.rejects(conflict.put('a', 'x', { ifAbsent: true }), /retry/u);
  const denied = createS3ArtifactStore({
    bucket: 'slides',
    client: stubClient(() => {
      throw Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
    }),
  });
  await assert.rejects(denied.put('a', 'x', { ifAbsent: true }), /denied/u);
});

test('S3 listing maps opaque continuation tokens and clamps provider page size', async () => {
  const client = stubClient((command) => {
    assert.ok(command instanceof ListObjectsV2Command);
    return {
      Contents: [{ Key: 'root/a' }, { Key: 'elsewhere/b' }, { Key: undefined }],
      IsTruncated: true,
      NextContinuationToken: 'opaque/token+',
    };
  });
  const store = createS3ArtifactStore({ bucket: 'slides', client });
  assert.deepEqual(await store.list({ prefix: 'root/', limit: 4000, cursor: 'prev' }), {
    keys: ['root/a'],
    cursor: 'opaque/token+',
  });
  assert.equal(client.calls[0].input.MaxKeys, 1000);
  assert.equal(client.calls[0].input.ContinuationToken, 'prev');
  assert.equal(client.calls[0].input.Prefix, 'root/');
  await assert.rejects(store.list({ prefix: '', limit: 0 }), RangeError);
  const incomplete = createS3ArtifactStore({
    bucket: 'slides',
    client: stubClient(() => ({ Contents: [{ Key: 'root/a' }], IsTruncated: true })),
  });
  await assert.rejects(
    incomplete.list({ prefix: 'root/', limit: 1 }),
    /truncated but has no continuation token/u,
  );
});
