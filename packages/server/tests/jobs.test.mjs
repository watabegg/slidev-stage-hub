import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubServer, runPublicationJob, publishDeck } from '../dist/index.js';
import { ThumbnailError } from '../dist/thumbnail.js';
import { isJobSnapshot } from '@slidock/protocol/contracts';
import { jobOptions } from './jobs-support.mjs';
import { compileResult, pngHeader } from './support.mjs';
const token = 'A'.repeat(43);
const ids = Array.from(
  { length: 20 },
  (_, i) => `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`,
);
function body(index = 0, extra = {}) {
  return {
    jobId: ids[index],
    deckId: 'demo/overview',
    markdown: '# Hello',
    viewToken: token,
    ...extra,
  };
}
function request(path, method = 'GET', value, auth = true) {
  return new Request(`http://localhost:4180${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: 'Bearer publish-secret' } : {}),
      ...(value ? { 'content-type': 'application/json' } : {}),
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
}
async function submit(fixture, index = 0, extra = {}) {
  const server = createHubServer(fixture.options);
  const res = await server.fetch(request('/api/jobs', 'POST', body(index, extra)));
  assert.equal(res.status, 202);
  return res.json();
}
async function stored(f, index = 0) {
  return f.jobs.get({ deckId: 'demo/overview', jobId: ids[index] });
}
const worker = { compile: async (input) => compileResult(input), random: () => 0 };

test('admission validates/authenticates before generation and stores no raw view token', async () => {
  const f = jobOptions();
  const server = createHubServer(f.options);
  assert.equal((await server.fetch(request('/api/jobs', 'POST', body(), false))).status, 401);
  assert.equal(
    (await server.fetch(request('/api/jobs', 'POST', body(0, { unexpected: true })))).status,
    400,
  );
  assert.equal(
    (await server.fetch(request('/api/jobs', 'POST', body(0, { assets: { 'evil.png': 'x' } }))))
      .status,
    400,
  );
  assert.equal(f.generations.size, 0);
  const admission = await submit(f);
  assert.equal(admission.job.status, 'queued');
  assert.equal(admission.job.attempt, 0);
  assert.equal(isJobSnapshot(admission.job), true);
  assert.equal(f.current.size, 0);
  assert.equal(f.generations.get('demo/overview'), 1);
  const privateInput = await new Response(
    (await f.options.artifacts.get((await stored(f)).inputKey)).body,
  ).text();
  assert.equal(privateInput.includes(token), false);
  assert.equal(JSON.stringify(admission).includes('viewTokenHash'), false);
});
test('same request replay preserves generation across profile changes; conflicting body returns 409', async () => {
  const f = jobOptions();
  await submit(f);
  f.options.profile.digest = 'new-profile';
  const server = createHubServer(f.options);
  let r = await server.fetch(request('/api/jobs', 'POST', body()));
  assert.equal(r.status, 202);
  assert.equal((await r.json()).replayed, true);
  assert.equal(f.generations.get('demo/overview'), 1);
  r = await server.fetch(request('/api/jobs', 'POST', body(0, { markdown: '# Changed' })));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'IDEMPOTENCY_CONFLICT');
});
test('read capability is scoped, expires in seven days and never authorizes mutation/list', async () => {
  const f = jobOptions();
  await submit(f);
  const server = createHubServer(f.options);
  const path = `/api/jobs/${ids[0]}?deckId=demo%2Foverview`;
  const viewRequest = (value = token) =>
    new Request(`http://localhost:4180${path}`, { headers: { 'X-Hub-Job-View': value } });
  assert.equal((await server.fetch(viewRequest())).status, 200);
  assert.equal((await server.fetch(viewRequest('B'.repeat(43)))).status, 404);
  assert.equal((await server.fetch(request(path, 'GET', undefined, false))).status, 401);
  assert.equal(
    (
      await server.fetch(
        new Request('http://localhost:4180/api/decks/demo%2Foverview/jobs', {
          headers: { 'X-Hub-Job-View': token },
        }),
      )
    ).status,
    401,
  );
  const record = f.records.values().next().value;
  record.viewExpiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal((await server.fetch(viewRequest())).status, 404);
  assert.equal((await server.fetch(request(path))).status, 200);
});
test('worker publishes without begin at execution, marks image skipped and terminal replay returns 200', async () => {
  const f = jobOptions();
  await submit(f, 0, { thumbnail: 'none' });
  f.options.publications.begin = async () => {
    throw new Error('must not begin');
  };
  assert.equal(await runPublicationJob(f.options, worker), true);
  const record = await stored(f);
  assert.equal(record.snapshot.status, 'succeeded');
  assert.equal(record.snapshot.result.thumbnail, 'skipped');
  assert.equal(f.generations.get('demo/overview'), 1);
  assert.equal(f.current.get('demo/overview').revision, record.snapshot.result.revision);
  assert.equal(isJobSnapshot(record.snapshot), true);
  const res = await createHubServer(f.options).fetch(
    request('/api/jobs', 'POST', body(0, { thumbnail: 'none' })),
  );
  assert.equal(res.status, 200);
  assert.equal(await runPublicationJob(f.options, worker), false);
});
test('renderer absent is partial after commit, while configured renderer uses fixed configured origin/revision', async () => {
  const f = jobOptions();
  await submit(f);
  await runPublicationJob(f.options, worker);
  const record = await stored(f);
  assert.equal(record.snapshot.status, 'partial');
  assert.equal(record.snapshot.result.thumbnail, 'unavailable');
  assert.equal(record.snapshot.error.code, 'THUMBNAIL_UNAVAILABLE');
  assert.equal(f.current.size, 1);
  const g = jobOptions();
  g.options.publicOrigin = 'https://slides.example';
  let rendered;
  g.options.renderThumbnail = async (url) => {
    rendered = new URL(url);
    return { bytes: pngHeader(), usedMs: 10 };
  };
  await submit(g);
  await runPublicationJob(g.options, worker);
  const done = await stored(g);
  assert.equal(done.snapshot.status, 'succeeded');
  assert.equal(done.snapshot.result.thumbnail, 'ready');
  assert.equal(rendered.origin, 'https://slides.example');
  assert.equal(rendered.searchParams.get('revision'), done.snapshot.result.revision);
});
test('compiler diagnostics never leak raw source or error, and runtime change fails before compiler/current', async () => {
  const f = jobOptions();
  await submit(f);
  await runPublicationJob(f.options, {
    compile: async () => {
      throw new Error('SECRET speaker notes');
    },
  });
  const failure = await stored(f);
  assert.equal(failure.snapshot.status, 'failed');
  assert.equal(failure.snapshot.error.code, 'COMPILE_FAILED');
  assert.equal(JSON.stringify(failure.snapshot).includes('SECRET'), false);
  assert.equal(f.current.size, 0);
  const g = jobOptions();
  await submit(g);
  g.options.profile.digest = 'changed';
  let calls = 0;
  await runPublicationJob(g.options, {
    compile: async (input) => {
      calls++;
      return compileResult(input);
    },
  });
  assert.equal((await stored(g)).snapshot.error.code, 'RUNTIME_CHANGED');
  assert.equal(calls, 0);
  assert.equal(g.current.size, 0);
});
test('transient stages have three total attempts and persisted 5/30 second delays', async () => {
  const f = jobOptions();
  await submit(f);
  let time = Date.now();
  const put = f.options.artifacts.put;
  f.options.artifacts.put = async (key, ...rest) => {
    if (key.endsWith('/1.js')) throw new Error('storage secret');
    return put(key, ...rest);
  };
  const opts = { ...worker, now: () => time };
  await runPublicationJob(f.options, opts);
  let r = await stored(f);
  assert.equal(r.snapshot.status, 'retry_wait');
  assert.equal(r.snapshot.phase, 'store');
  assert.equal(Date.parse(r.snapshot.nextRunAt) - time, 5000);
  assert.equal(await runPublicationJob(f.options, opts), false);
  time += 5000;
  await runPublicationJob(f.options, opts);
  r = await stored(f);
  assert.equal(Date.parse(r.snapshot.nextRunAt) - time, 30000);
  time += 30000;
  await runPublicationJob(f.options, opts);
  r = await stored(f);
  assert.equal(r.snapshot.status, 'failed');
  assert.equal(r.snapshot.stages.find((s) => s.phase === 'store').attempt, 3);
  assert.equal(f.current.size, 0);
});
test('new admission supersedes only unpublished jobs; legacy begin shares fencing', async () => {
  const f = jobOptions();
  await submit(f);
  await submit(f, 1, { markdown: '# New' });
  assert.equal((await stored(f)).snapshot.status, 'superseded');
  await runPublicationJob(f.options, worker);
  assert.equal((await stored(f, 1)).snapshot.status, 'partial');
  await submit(f, 2, { markdown: '# Newer' });
  assert.equal((await stored(f, 1)).snapshot.status, 'partial');
  await publishDeck(f.options, 'demo/overview', { markdown: '# Legacy' }, async (input) =>
    compileResult(input),
  );
  assert.equal((await stored(f, 2)).snapshot.status, 'superseded');
});
test('checkpoint lease loss prevents commit despite completed immutable storage', async () => {
  const f = jobOptions();
  await submit(f, 0, { thumbnail: 'none' });
  const original = f.jobs.checkpoint;
  f.jobs.checkpoint = async (lease, update) =>
    update.preparedManifest ? false : original(lease, update);
  await runPublicationJob(f.options, worker);
  assert.equal(f.current.size, 0);
  assert.equal((await stored(f)).snapshot.result, undefined);
});
test('commit failure retries publish without exposing an unpublished result as partial', async () => {
  const f = jobOptions();
  await submit(f);
  f.jobs.commitPublication = async () => {
    throw new Error('db secret');
  };
  await runPublicationJob(f.options, worker);
  const r = await stored(f);
  assert.equal(r.snapshot.status, 'retry_wait');
  assert.equal(r.snapshot.phase, 'publish');
  assert.equal(r.snapshot.result, undefined);
  assert.equal(f.current.size, 0);
});
test('profile change after a prepared checkpoint preserves completed stages on recovery', async () => {
  const f = jobOptions();
  await submit(f, 0, { thumbnail: 'none' });
  let time = Date.now();
  const checkpoint = f.jobs.checkpoint;
  f.jobs.checkpoint = async (lease, update) => {
    const applied = await checkpoint(lease, update);
    return update.preparedManifest ? false : applied;
  };
  await runPublicationJob(f.options, { ...worker, now: () => time });
  const prepared = await stored(f);
  assert.ok(prepared.preparedManifest);
  assert.equal(prepared.snapshot.phase, 'store');
  assert.equal(prepared.snapshot.stages.find((s) => s.phase === 'store').status, 'succeeded');
  f.jobs.checkpoint = checkpoint;
  f.options.profile.digest = 'new-deployment';
  time += 120001;
  await runPublicationJob(f.options, { ...worker, now: () => time });
  const recovered = await stored(f);
  assert.equal(recovered.snapshot.status, 'failed');
  assert.equal(recovered.snapshot.error.code, 'RUNTIME_CHANGED');
  assert.equal(recovered.snapshot.phase, 'publish');
  assert.deepEqual(recovered.snapshot.stages.slice(0, 3), prepared.snapshot.stages.slice(0, 3));
  assert.equal(recovered.snapshot.stages.find((s) => s.phase === 'publish').status, 'failed');
  assert.equal(f.current.size, 0);
});
test('crash after atomic commit resumes thumbnail without compiling or changing generation', async () => {
  const f = jobOptions();
  await submit(f);
  let time = Date.now();
  const original = f.jobs.commitPublication;
  f.jobs.commitPublication = async (...args) => {
    const result = await original(...args);
    if (result === 'published') throw new Error('simulated crash');
    return result;
  };
  // Reject finish to model process loss after commit, keeping durable running lease/result.
  f.jobs.finish = async () => false;
  await runPublicationJob(f.options, { ...worker, now: () => time });
  const committed = await stored(f);
  assert.ok(committed.snapshot.result);
  assert.equal(committed.snapshot.status, 'running');
  f.jobs.commitPublication = original;
  time += 120001;
  f.jobs.finish = async (lease, update) => {
    const r = f.records.values().next().value;
    if (r.leaseToken !== lease.leaseToken) return false;
    Object.assign(r.snapshot, structuredClone(update));
    r.snapshot.finishedAt = lease.now;
    delete r.leaseToken;
    delete r.leaseUntil;
    return true;
  };
  f.options.renderThumbnail = async () => ({ bytes: pngHeader(), usedMs: 0 });
  await runPublicationJob(f.options, {
    ...worker,
    now: () => time,
    compile: async () => {
      throw new Error('must not compile');
    },
  });
  assert.equal((await stored(f)).snapshot.status, 'succeeded');
  assert.equal(f.generations.get('demo/overview'), 1);
});
test('thumbnail retry is new child fixed to old published revision and never moves current', async () => {
  const f = jobOptions();
  await submit(f);
  await runPublicationJob(f.options, worker);
  const old = (await stored(f)).snapshot.result;
  await submit(f, 1, { markdown: '# Newer', thumbnail: 'none' });
  await runPublicationJob(f.options, worker);
  const currentRevision = f.current.get('demo/overview').revision;
  let captured;
  f.options.renderThumbnail = async (url) => {
    captured = new URL(url).searchParams.get('revision');
    return { bytes: pngHeader(), usedMs: 0 };
  };
  const res = await createHubServer(f.options).fetch(
    request(`/api/jobs/${ids[0]}/retry?deckId=demo%2Foverview`, 'POST', {
      jobId: ids[2],
      stage: 'thumbnail',
      viewToken: token,
    }),
  );
  assert.equal(res.status, 202);
  await runPublicationJob(f.options, worker);
  assert.equal(captured, old.revision);
  assert.equal(f.current.get('demo/overview').revision, currentRevision);
  assert.equal(f.generations.get('demo/overview'), 2);
  assert.equal((await stored(f, 2)).snapshot.parentJobId, ids[0]);
  assert.equal((await stored(f)).snapshot.status, 'partial');
});
test('render auth wall is permanent partial; malformed PNG retries and never stores image', async () => {
  const f = jobOptions();
  f.options.renderThumbnail = async () => {
    throw new ThumbnailError('RENDER_AUTH_REQUIRED', 'private auth details');
  };
  await submit(f);
  await runPublicationJob(f.options, worker);
  let r = await stored(f);
  assert.equal(r.snapshot.status, 'partial');
  assert.equal(r.snapshot.error.code, 'RENDER_AUTH_REQUIRED');
  assert.equal(r.snapshot.error.retryable, false);
  const g = jobOptions();
  g.options.renderThumbnail = async () => ({ bytes: new Uint8Array(8), usedMs: 0 });
  await submit(g);
  await runPublicationJob(g.options, worker);
  r = await stored(g);
  assert.equal(r.snapshot.status, 'retry_wait');
  assert.equal(
    await g.options.artifacts.head(
      `releases/demo/overview/${r.snapshot.result.revision}/thumbnail.png`,
    ),
    null,
  );
});
test('disabled admission keeps capabilities truthful, allows status reads and worker drain', async () => {
  const f = jobOptions();
  await submit(f, 0, { thumbnail: 'none' });
  f.options.jobsEnabled = false;
  const server = createHubServer(f.options);
  const capabilities = await (await server.fetch(request('/api/capabilities'))).json();
  assert.equal(capabilities.publicationJobs.enabled, false);
  assert.equal((await server.fetch(request('/api/jobs', 'POST', body(1)))).status, 503);
  assert.equal(
    (await server.fetch(request(`/api/jobs/${ids[0]}?deckId=demo%2Foverview`))).status,
    200,
  );
  assert.equal(await runPublicationJob(f.options, worker), true);
  assert.equal((await stored(f)).snapshot.status, 'succeeded');
});
test('reserved job view entry precedes document/static routing with no-referrer', async () => {
  const f = jobOptions();
  let entry;
  f.options.staticAssets.fetch = async (request) => {
    entry = new URL(request.url).pathname;
    return new Response('<html>jobs</html>', { headers: { 'content-type': 'text/html' } });
  };
  const server = createHubServer(f.options);
  const res = await server.fetch(request('/_hub/jobs?deckId=x&jobId=y'));
  assert.equal(entry, '/jobs.html');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await server.fetch(request('/_hub/jobs/1'))).status, 404);
});

test('same-profile runtime redeployment fails before archival or compile', async () => {
  const f = jobOptions();
  f.options.loadRuntime = async () => ({ schemaVersion: 1, id: 'a'.repeat(64), files: [] });
  await submit(f);
  assert.equal((await stored(f)).runtimeId, 'a'.repeat(64));
  f.options.loadRuntime = async () => ({ schemaVersion: 1, id: 'b'.repeat(64), files: [] });
  let compiled = false;
  await runPublicationJob(f.options, {
    compile: async (input) => {
      compiled = true;
      return compileResult(input);
    },
  });
  const job = await stored(f);
  assert.equal(job.snapshot.status, 'failed');
  assert.equal(job.snapshot.error.code, 'RUNTIME_CHANGED');
  assert.equal(compiled, false);
  assert.equal(f.current.size, 0);
  assert.equal(
    [...f.values.keys()].some((k) => k.startsWith('runtimes/')),
    false,
  );
});
test('configuration permits trusted internal HTTP and origin absence yields partial only for auto', async () => {
  const f = jobOptions();
  delete f.options.publicOrigin;
  await submit(f, 0, { thumbnail: 'none' });
  await runPublicationJob(f.options, worker);
  assert.equal((await stored(f)).snapshot.status, 'succeeded');
  await submit(f, 1);
  await runPublicationJob(f.options, worker);
  assert.equal((await stored(f, 1)).snapshot.error.code, 'THUMBNAIL_UNAVAILABLE');
  const g = jobOptions();
  g.options.publicOrigin = 'http://hub:8080';
  await submit(g, 0, { thumbnail: 'none' });
  assert.equal((await stored(g)).snapshot.status, 'queued');
});
test('thumbnail rate-limit Retry-After is bounded at 300 seconds', async () => {
  const f = jobOptions();
  f.options.renderThumbnail = async () => {
    throw new ThumbnailError('BROWSER_LIMIT', 'private', 900000);
  };
  await submit(f);
  const time = Date.now();
  await runPublicationJob(f.options, { ...worker, now: () => time });
  const job = await stored(f);
  assert.equal(job.snapshot.status, 'retry_wait');
  assert.equal(Date.parse(job.snapshot.nextRunAt) - time, 300000);
});
test('expired third lease attempt terminates before doing more runtime I/O', async () => {
  const f = jobOptions();
  await submit(f);
  const r = f.records.values().next().value;
  r.snapshot.status = 'running';
  r.snapshot.attempt = 3;
  r.snapshot.stages[0].attempt = 3;
  r.snapshot.stages[0].status = 'running';
  r.leaseToken = crypto.randomUUID();
  r.leaseUntil = '2000-01-01T00:00:00.000Z';
  f.options.artifacts.get = async () => {
    throw new Error('No more I/O expected');
  };
  await runPublicationJob(f.options, worker);
  assert.equal((await stored(f)).snapshot.status, 'failed');
  assert.equal((await stored(f)).snapshot.stages[0].attempt, 3);
});
test('concurrent conflicting private input returns idempotency conflict rather than storage failure', async () => {
  const f = jobOptions();
  const server = createHubServer(f.options);
  const results = await Promise.all([
    server.fetch(request('/api/jobs', 'POST', body())),
    server.fetch(request('/api/jobs', 'POST', body(0, { markdown: '# Conflicting source' }))),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
  assert.equal(f.generations.get('demo/overview'), 1);
});
test('bad pagination cursor is a sanitized request error', async () => {
  const f = jobOptions();
  await submit(f);
  f.jobs.list = async () => {
    throw new TypeError('private bad cursor');
  };
  const res = await createHubServer(f.options).fetch(
    request('/api/decks/demo%2Foverview/jobs?cursor=bogus'),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_CURSOR');
});

test('structured telemetry has only safe identifiers and counters, and callback failures do not fail jobs', async () => {
  const f = jobOptions();
  const events = [];
  f.options.onJobEvent = (event) => {
    events.push(event);
    throw new Error('telemetry unavailable');
  };
  await submit(f, 0, { markdown: '# PRIVATE SOURCE', thumbnail: 'none' });
  await runPublicationJob(f.options, worker);
  assert.equal((await stored(f)).snapshot.status, 'succeeded');
  assert.equal(events[0].event, 'claimed');
  assert.ok(events.some((e) => e.event === 'published'));
  assert.equal(events.at(-1).event, 'finished');
  assert.equal(JSON.stringify(events).includes('PRIVATE SOURCE'), false);
  assert.equal(JSON.stringify(events).includes(token), false);
  const fields = [
    'event',
    'jobId',
    'deckId',
    'phase',
    'attempt',
    'durationMs',
    'queueAgeMs',
    'code',
    'status',
  ];
  assert.ok(events.every((event) => Object.keys(event).every((key) => fields.includes(key))));
  const g = jobOptions();
  g.options.onJobEvent = async () => {
    throw new Error('async telemetry unavailable');
  };
  await submit(g, 0, { thumbnail: 'none' });
  await runPublicationJob(g.options, worker);
  assert.equal((await stored(g)).snapshot.status, 'succeeded');
});
test('full retry captures new profile, is idempotent and rejects another active child or stale parent', async () => {
  const f = jobOptions();
  await submit(f, 0, { thumbnail: 'none' });
  await runPublicationJob(f.options, {
    compile: async () => {
      throw new Error('invalid compilation');
    },
  });
  f.options.profile.digest = 'new-profile';
  const server = createHubServer(f.options);
  const retry = (jobId) =>
    request(`/api/jobs/${ids[0]}/retry?deckId=demo%2Foverview`, 'POST', {
      jobId,
      stage: 'all',
      viewToken: token,
    });
  const first = await server.fetch(retry(ids[1]));
  assert.equal(first.status, 202);
  assert.equal((await stored(f, 1)).profileDigest, 'new-profile');
  assert.equal(f.generations.get('demo/overview'), 2);
  const replay = await server.fetch(retry(ids[1]));
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(f.generations.get('demo/overview'), 2);
  const active = await server.fetch(retry(ids[2]));
  assert.equal(active.status, 409);
  assert.equal((await active.json()).code, 'ACTIVE_RETRY');
  await runPublicationJob(f.options, worker);
  assert.equal((await stored(f, 1)).snapshot.status, 'succeeded');
  assert.equal((await stored(f)).snapshot.status, 'failed');
  const stale = await server.fetch(retry(ids[2]));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'SUPERSEDED');
});
test('noncanonical UUID and null assets fail admission before any generation', async () => {
  const f = jobOptions();
  const server = createHubServer(f.options);
  assert.equal(
    (await server.fetch(request('/api/jobs', 'POST', body(0, { jobId: ids[0].toUpperCase() }))))
      .status,
    400,
  );
  assert.equal(
    (await server.fetch(request('/api/jobs', 'POST', body(0, { assets: null })))).status,
    400,
  );
  assert.equal(f.generations.size, 0);
});
test('heartbeat extends a stalled compiler lease so a second worker cannot reclaim at 120 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const f = jobOptions();
  await submit(f, 0, { thumbnail: 'none' });
  let resolveCompiled, enteredCompile;
  const entered = new Promise((resolve) => {
    enteredCompile = resolve;
  });
  const blocked = new Promise((resolve) => {
    resolveCompiled = resolve;
  });
  const execution = runPublicationJob(f.options, {
    compile: async (input) => {
      enteredCompile();
      await blocked;
      return compileResult(input);
    },
  });
  await entered;
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(30000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(
    await f.jobs.claim({
      now: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + 120000).toISOString(),
      leaseToken: crypto.randomUUID(),
    }),
    null,
  );
  resolveCompiled();
  await execution;
  assert.equal((await stored(f)).snapshot.status, 'succeeded');
});

test('private source hash corruption fails permanently and cannot publish', async () => {
  const f = jobOptions();
  await submit(f);
  const key = (await stored(f)).inputKey;
  f.values.get(key).bytes = new TextEncoder().encode('{"markdown":"# SECRET TAMPER"}');
  await runPublicationJob(f.options, worker);
  const record = await stored(f);
  assert.equal(record.snapshot.status, 'failed');
  assert.equal(record.snapshot.error.code, 'INPUT_INVALID');
  assert.equal(record.snapshot.error.retryable, false);
  assert.equal(f.current.size, 0);
  assert.equal(JSON.stringify(record.snapshot).includes('SECRET TAMPER'), false);
});
test('slide-count admission rejects 101 slides before reserving generation', async () => {
  const f = jobOptions();
  const markdown = Array.from({ length: 101 }, (_, i) => `# Slide ${i}`).join('\n\n---\n\n');
  const result = await createHubServer(f.options).fetch(
    request('/api/jobs', 'POST', body(0, { markdown })),
  );
  assert.equal(result.status, 400);
  assert.equal(f.generations.size, 0);
});
