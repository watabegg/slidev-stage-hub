import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { createPublicationJobClient, PublicationJobClientError } from '../dist/client/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientEntry = resolve(packageRoot, 'dist/client/jobs.js');
const jobId = '0fc53dd9-2715-4b7a-96ae-f4a43be26a6c';
const childId = '16ed83bc-bf8d-4cf1-8560-79df7dbeff7b';
const viewToken = Buffer.alloc(32, 7).toString('base64url');
const timestamp = '2026-10-10T00:00:00.000Z';
const phases = ['runtime', 'compile', 'store', 'publish', 'thumbnail'];

function snapshot(overrides = {}) {
  return {
    id: jobId,
    deckId: 'course/topic',
    kind: 'publication',
    status: 'queued',
    phase: 'runtime',
    version: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    attempt: 0,
    stages: phases.map((phase) => ({ phase, status: 'pending', attempt: 0 })),
    ...overrides,
  };
}

function submitResponse(job = snapshot(), overrides = {}) {
  return {
    schemaVersion: 1,
    job,
    statusUrl: `/api/jobs/${job.id}?deckId=course%2Ftopic`,
    viewPath: `/_hub/jobs?deckId=course%2Ftopic&jobId=${job.id}`,
    replayed: false,
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('submit, get, list, and retry use the public HTTP contract and injected auth', async () => {
  const calls = [];
  const client = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    headers: { Authorization: 'Bearer publish-secret' },
    fetch: async (url, init) => {
      const parsedUrl = new URL(String(url));
      calls.push({ url: parsedUrl, init });
      if (parsedUrl.pathname === '/api/jobs' && init.method === 'POST')
        return jsonResponse(submitResponse());
      if (parsedUrl.pathname === `/api/jobs/${jobId}/retry`)
        return jsonResponse(
          submitResponse(snapshot({ id: childId, parentJobId: jobId, kind: 'thumbnail' })),
          202,
        );
      if (parsedUrl.pathname === `/api/jobs/${jobId}`)
        return jsonResponse({ schemaVersion: 1, job: snapshot() });
      return jsonResponse({ schemaVersion: 1, items: [snapshot()], nextCursor: 'next page' });
    },
  });

  const submitted = await client.submit({
    jobId,
    deckId: 'course/topic',
    markdown: '# Private source',
    assets: { 'image.svg': '<svg/>' },
    thumbnail: 'auto',
    viewToken,
  });
  assert.equal(submitted.job.id, jobId);
  assert.equal(calls[0].url.pathname, '/api/jobs');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    jobId,
    deckId: 'course/topic',
    markdown: '# Private source',
    assets: { 'image.svg': '<svg/>' },
    thumbnail: 'auto',
    viewToken,
  });
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer publish-secret');

  const status = await client.get({ jobId, deckId: 'course/topic', viewToken });
  assert.equal(status.job.status, 'queued');
  assert.equal(calls[1].url.pathname, `/api/jobs/${jobId}`);
  assert.equal(calls[1].url.searchParams.get('deckId'), 'course/topic');
  assert.equal(calls[1].init.headers.get('X-Hub-Job-View'), viewToken);

  const listed = await client.list({ deckId: 'course/topic', limit: 12, cursor: 'a/b ?' });
  assert.equal(calls[2].url.pathname, '/api/decks/course%2Ftopic/jobs');
  assert.equal(calls[2].url.searchParams.get('limit'), '12');
  assert.equal(calls[2].url.searchParams.get('cursor'), 'a/b ?');
  assert.equal(listed.items[0].id, jobId);
  assert.equal(listed.nextCursor, 'next page');

  const retried = await client.retry(
    { jobId, deckId: 'course/topic' },
    { jobId: childId, stage: 'thumbnail', viewToken },
  );
  assert.equal(calls[3].url.pathname, `/api/jobs/${jobId}/retry`);
  assert.equal(calls[3].url.searchParams.get('deckId'), 'course/topic');
  assert.equal(calls[3].init.headers.get('authorization'), 'Bearer publish-secret');
  assert.equal(retried.job.parentJobId, jobId);
});

test('request validates responses, refuses redirects, and preserves HTTP status errors', async () => {
  const invalid = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    fetch: async () => jsonResponse({ schemaVersion: 1, job: { status: 'queued' } }),
  });
  await assert.rejects(
    invalid.get({ jobId, deckId: 'course/topic' }),
    (error) => error instanceof PublicationJobClientError && error.code === 'INVALID_RESPONSE',
  );

  const redirected = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    fetch: async () =>
      new Response(null, { status: 302, headers: { location: 'https://other.test' } }),
  });
  await assert.rejects(
    redirected.get({ jobId, deckId: 'course/topic' }),
    (error) =>
      error instanceof PublicationJobClientError && error.code === 'HTTP' && error.status === 302,
  );

  const unauthorized = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    fetch: async () => new Response(null, { status: 401 }),
  });
  await assert.rejects(
    unauthorized.list({ deckId: 'course/topic' }),
    (error) =>
      error instanceof PublicationJobClientError && error.code === 'HTTP' && error.status === 401,
  );

  const mismatched = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    fetch: async () => jsonResponse({ schemaVersion: 1, job: snapshot({ deckId: 'other/deck' }) }),
  });
  await assert.rejects(
    mismatched.get({ jobId, deckId: 'course/topic' }),
    (error) => error instanceof PublicationJobClientError && error.code === 'INVALID_RESPONSE',
  );

  const mismatchedList = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    fetch: async () =>
      jsonResponse({ schemaVersion: 1, items: [snapshot({ deckId: 'other/deck' })] }),
  });
  await assert.rejects(
    mismatchedList.list({ deckId: 'course/topic' }),
    (error) => error instanceof PublicationJobClientError && error.code === 'INVALID_RESPONSE',
  );
});

test('watch emits changed snapshots, reports connection recovery, and stops at terminal status', async () => {
  const states = [
    snapshot(),
    snapshot(),
    snapshot({ status: 'running', phase: 'compile', version: 1, attempt: 1 }),
    snapshot({
      status: 'succeeded',
      phase: 'thumbnail',
      version: 2,
      attempt: 1,
      finishedAt: timestamp,
      result: {
        revision: 'a'.repeat(64),
        entry: `/course/topic/1?revision=${'a'.repeat(64)}`,
        pages: 1,
        cached: false,
        thumbnail: 'ready',
      },
    }),
  ];
  const delays = [];
  const connectionStates = [];
  const client = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    fetch: async () => jsonResponse({ schemaVersion: 1, job: states.shift() }),
    sleep: async (milliseconds) => delays.push(milliseconds),
  });
  const snapshots = [];
  for await (const value of client.watch(
    { jobId, deckId: 'course/topic' },
    {
      pollIntervalMs: 25,
      hiddenIntervalMs: 100,
      isHidden: () => delays.length === 0,
      onConnectionChange: (state) => connectionStates.push(state),
    },
  )) {
    snapshots.push(value);
  }

  assert.deepEqual(
    snapshots.map((value) => value.status),
    ['queued', 'running', 'succeeded'],
  );
  assert.deepEqual(delays, [100, 25, 25]);
  assert.deepEqual(connectionStates, ['connected']);
});

test('watch backs off after temporary network errors and surfaces aborts', async () => {
  let requests = 0;
  const delays = [];
  const connectionStates = [];
  const client = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    fetch: async () => {
      requests += 1;
      if (requests < 3) throw new Error('temporary transport detail');
      return jsonResponse({
        schemaVersion: 1,
        job: snapshot({ status: 'failed', version: 1, finishedAt: timestamp }),
      });
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });
  const snapshots = [];
  for await (const value of client.watch(
    { jobId, deckId: 'course/topic' },
    {
      pollIntervalMs: 2000,
      maxBackoffMs: 15_000,
      onConnectionChange: (state) => connectionStates.push(state),
    },
  )) {
    snapshots.push(value);
  }
  assert.equal(snapshots.length, 1);
  assert.deepEqual(delays, [2000, 4000]);
  assert.deepEqual(connectionStates, ['reconnecting', 'connected']);

  let wake;
  const controller = new AbortController();
  const abortable = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    fetch: async () => jsonResponse({ schemaVersion: 1, job: snapshot() }),
    sleep: (_milliseconds, signal) =>
      new Promise((resolve, reject) => {
        wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new PublicationJobClientError('ABORTED', 'aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
  });
  const iterator = abortable.watch(
    { jobId, deckId: 'course/topic' },
    { signal: controller.signal },
  );
  assert.equal((await iterator.next()).value.status, 'queued');
  const waiting = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    waiting,
    (error) => error instanceof PublicationJobClientError && error.code === 'ABORTED',
  );
  wake?.();
});

test('watch honors a bounded Retry-After value for HTTP 429', async () => {
  let requests = 0;
  const delays = [];
  const client = createPublicationJobClient({
    baseUrl: 'https://hub.example.test',
    fetch: async () => {
      requests += 1;
      if (requests === 1)
        return new Response(null, { status: 429, headers: { 'retry-after': '9' } });
      return jsonResponse({
        schemaVersion: 1,
        job: snapshot({ status: 'succeeded', version: 1, finishedAt: timestamp }),
      });
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });
  for await (const value of client.watch(
    { jobId, deckId: 'course/topic' },
    { maxBackoffMs: 15_000 },
  )) {
    assert.equal(value.status, 'succeeded');
  }
  assert.deepEqual(delays, [9000]);
});

test('importing the headless client does not require browser globals or start a request', () => {
  const source = readFileSync(clientEntry, 'utf8');
  assert.doesNotMatch(source, /\b(?:window|document)\b/u);
  assert.equal(typeof createPublicationJobClient, 'function');
});
