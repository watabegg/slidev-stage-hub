import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createDurableObjectPublicationJobStore } from '@slidev-stage-hub/adapter-cloudflare';
import { artifactRoot, experiment, startHarness } from './harness.mjs';

const workerName = 'slidev-workers-poc';
const deckId = 'jobs/restart';
const autoThumbnailDeckId = 'jobs/auto-thumbnail-no-browser';
const autoThumbnailSuccessDeckId = 'jobs/auto-thumbnail-synthetic-browser';
const migrationDeckId = 'jobs/migration';
const jobPhases = ['runtime', 'compile', 'store', 'publish', 'thumbnail'];
const checks = [];
const check = (label, condition) => {
  assert.ok(condition, label);
  checks.push(label);
};

const site = resolve(artifactRoot, 'site');
const runtime = JSON.parse(await readFile(resolve(site, 'runtime-manifest.json'), 'utf8')).runtime;
if (!runtime?.id) throw new Error('Build the Workers runtime before running verify-jobs-do.mjs');

const scratch = await mkdtemp(resolve(tmpdir(), 'slidev-hub-jobs-do-'));
const statePath = resolve(scratch, 'persistent-state');
const workerPath = resolve(scratch, 'current-worker.mjs');
const browserEntryPath = resolve(scratch, 'browser-worker-entry.ts');
const evidencePath = resolve(artifactRoot, 'jobs-do-verification.json');
await mkdir(artifactRoot, { recursive: true });

const v1Path = resolve(scratch, 'v1-worker.mjs');
await writeFile(
  v1Path,
  `import { DurableObject } from 'cloudflare:workers';
export class DeckVersions extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, current TEXT)');
      ctx.storage.sql.exec('INSERT OR IGNORE INTO state VALUES (1, 0, NULL)');
    });
  }
  async begin() {
    const generation = this.ctx.storage.sql.exec('SELECT generation FROM state WHERE id = 1').one().generation + 1;
    this.ctx.storage.sql.exec('UPDATE state SET generation = ? WHERE id = 1', generation);
    return generation;
  }
  async current() {
    const value = this.ctx.storage.sql.exec('SELECT current FROM state WHERE id = 1').one().current;
    return value === null ? null : JSON.parse(value);
  }
  async commit(generation, manifest) {
    if (this.ctx.storage.sql.exec('SELECT generation FROM state WHERE id = 1').one().generation !== generation) return false;
    this.ctx.storage.sql.exec('UPDATE state SET current = ? WHERE id = 1', JSON.stringify(manifest));
    return true;
  }
}
export default { fetch() { return new Response('v1'); } };
`,
);
const fixturePngBase64 = fixturePng().toString('base64');
await writeFile(
  browserEntryPath,
  `import hubWorker, { DeckVersions as OriginalDeckVersions } from ${JSON.stringify(resolve(experiment, 'src/worker.ts'))};
const png = Uint8Array.from(atob('${fixturePngBase64}'), (value) => value.charCodeAt(0));
const browser = {
  async quickAction() {
    return {
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'image/png', 'x-browser-ms-used': '1' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(png);
          controller.close();
        },
      }),
    };
  },
};
export class DeckVersions extends OriginalDeckVersions {
  constructor(ctx, env) {
    super(ctx, { ...env, BROWSER: browser });
  }
}
export default {
  fetch(request, env, ctx) {
    return hubWorker.fetch(request, { ...env, BROWSER: browser }, ctx);
  },
};
`,
);

function miniflareOptions(scriptPath) {
  const options = convertV4MiniflareOptions({
    name: workerName,
    modules: true,
    modulesRoot: dirname(scriptPath),
    scriptPath,
    host: '127.0.0.1',
    port: 0,
    compatibilityDate: '2026-10-09',
    bindings: {},
    durableObjects: { VERSIONS: { className: 'DeckVersions', useSQLite: true } },
    cf: false,
  });
  options.resourcePersistencePath = statePath;
  options.telemetry = { enabled: false };
  return options;
}

async function namespaceFor(mf) {
  return mf.getDurableObjectNamespace('VERSIONS');
}

async function objectFor(mf, name) {
  const namespace = await namespaceFor(mf);
  return namespace.get(namespace.idFromName(name));
}

let oldWorker;
let firstWorker;
let resumedWorker;
let thumbnailWorker;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function fixturePng() {
  const width = 1200;
  const height = 675;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  const image = deflateSync(scanlines);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', image),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

try {
  oldWorker = new Miniflare(miniflareOptions(v1Path));
  await oldWorker.ready;
  const oldCoordinator = await objectFor(oldWorker, migrationDeckId);
  const oldGeneration = await oldCoordinator.begin();
  check('v1 fixture seeds its original SQLite generation', oldGeneration === 1);
  check(
    'v1 fixture commits the pre-existing current manifest',
    await oldCoordinator.commit(oldGeneration, { revision: 'preserved-before-upgrade' }),
  );
  await oldWorker.dispose();
  oldWorker = undefined;

  firstWorker = await startHarness({
    site,
    persist: true,
    statePath,
    workerPath,
    bindings: { HUB_JOBS_ENABLED: 'true' },
  });
  const profileDigest = firstWorker.profileDigest;
  const namespace = await namespaceFor(firstWorker.mf);
  const store = createDurableObjectPublicationJobStore({
    getByName: (name) => namespace.get(namespace.idFromName(name)),
  });
  const oldCurrent = await store.publications.current(migrationDeckId);
  check(
    'schema v2 opens the original DeckVersions class and preserves its current manifest',
    oldCurrent?.revision === 'preserved-before-upgrade',
  );
  const nextGeneration = await store.publications.begin(migrationDeckId);
  check('legacy generation continues after the internal schema upgrade', nextGeneration === '2');

  const markdown = '# Alarm resumed after restart\n\nSQLite job recovery works.\n';
  const privateInput = JSON.stringify({ markdown, assets: {} });
  const inputKey = `private/jobs/${deckId}/pending.json`;
  const inputHash = createHash('sha256').update(privateInput).digest('hex');
  const bucket = await firstWorker.mf.getR2Bucket('FILES');
  await bucket.put(inputKey, privateInput, {
    httpMetadata: { contentType: 'application/json' },
  });
  const autoMarkdown = '# Browser unavailable fallback\n\nPublication remains usable.\n';
  const autoInput = JSON.stringify({ markdown: autoMarkdown, assets: {} });
  const autoInputKey = `private/jobs/${autoThumbnailDeckId}/pending.json`;
  await bucket.put(autoInputKey, autoInput, {
    httpMetadata: { contentType: 'application/json' },
  });
  const jobId = randomUUID();
  const dueAtMs = Date.now() + 8_000;
  const dueAt = new Date(dueAtMs).toISOString();
  const job = {
    snapshot: {
      id: jobId,
      deckId,
      kind: 'publication',
      status: 'queued',
      phase: 'runtime',
      version: 1,
      createdAt: dueAt,
      updatedAt: dueAt,
      attempt: 0,
      stages: jobPhases.map((phase) => ({ phase, status: 'pending', attempt: 0 })),
    },
    requestHash: 'restart-fixture-request-hash',
    inputKey,
    inputHash,
    profileDigest: firstWorker.profileDigest,
    runtimeId: runtime.id,
    compilerContractVersion: 'native-click-metadata-v1',
    thumbnail: 'none',
    viewTokenHash: 'restart-fixture-view-token-hash',
    viewExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const accepted = await store.submit(job);
  assert.equal(accepted.outcome, 'accepted');
  const admitted = accepted.job;
  const replay = await store.submit(job);
  check(
    'same idempotency key replays without allocating a new generation',
    replay.outcome === 'replayed' && replay.job.generation === admitted.generation,
  );
  const conflict = await store.submit({ ...job, requestHash: 'different-request-hash' });
  check('same job id with a different request hash conflicts', conflict.outcome === 'conflict');

  const notDue = await store.claim({
    deckId,
    now: new Date(dueAtMs - 1_000).toISOString(),
    leaseUntil: new Date(dueAtMs + 119_000).toISOString(),
    leaseToken: randomUUID(),
  });
  check('future queued jobs remain unclaimed before their persisted alarm time', notDue === null);

  const leaseDeckId = 'jobs/lease-fencing';
  const leaseJobId = randomUUID();
  const simulatedDueMs = Date.now() + 10 * 60_000;
  const simulatedDueAt = new Date(simulatedDueMs).toISOString();
  const leaseAdmission = await store.submit({
    snapshot: {
      id: leaseJobId,
      deckId: leaseDeckId,
      kind: 'publication',
      status: 'queued',
      phase: 'runtime',
      version: 1,
      createdAt: simulatedDueAt,
      updatedAt: simulatedDueAt,
      attempt: 0,
      stages: jobPhases.map((phase) => ({ phase, status: 'pending', attempt: 0 })),
    },
    requestHash: 'lease-fencing-request-hash',
    profileDigest,
    runtimeId: runtime.id,
    compilerContractVersion: 'native-click-metadata-v1',
    thumbnail: 'none',
    viewTokenHash: 'lease-fencing-view-token-hash',
    viewExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(leaseAdmission.outcome, 'accepted');
  const firstLeaseToken = randomUUID();
  const firstLeaseExpiry = new Date(simulatedDueMs + 120_000).toISOString();
  const claimed = await store.claim({
    deckId: leaseDeckId,
    now: simulatedDueAt,
    leaseUntil: firstLeaseExpiry,
    leaseToken: firstLeaseToken,
  });
  check(
    'claim leaves stage attempts for the runner to increment',
    claimed?.snapshot.status === 'running' &&
      claimed.snapshot.stages.every((stage) => stage.attempt === 0),
  );
  const secondLeaseToken = randomUUID();
  const reclaimed = await store.claim({
    deckId: leaseDeckId,
    now: firstLeaseExpiry,
    leaseUntil: new Date(Date.parse(firstLeaseExpiry) + 120_000).toISOString(),
    leaseToken: secondLeaseToken,
  });
  check(
    'expired running jobs are reclaimed without incrementing stage attempts',
    reclaimed?.leaseToken === secondLeaseToken &&
      reclaimed.snapshot.stages.every((stage) => stage.attempt === 0),
  );
  const staleLease = {
    deckId: leaseDeckId,
    jobId: leaseJobId,
    leaseToken: firstLeaseToken,
    now: new Date(Date.parse(firstLeaseExpiry) + 1).toISOString(),
  };
  check(
    'a reclaimed lease fences stale checkpoints and finishes',
    !(await store.checkpoint(staleLease, { phase: 'runtime' })) &&
      !(await store.finish(staleLease, { status: 'failed', stages: claimed.snapshot.stages })),
  );
  const activeLease = {
    deckId: leaseDeckId,
    jobId: leaseJobId,
    leaseToken: secondLeaseToken,
    now: new Date(Date.parse(firstLeaseExpiry) + 2).toISOString(),
  };
  check(
    'the fresh lease can checkpoint and finish the reclaimed job',
    (await store.checkpoint(activeLease, { phase: 'runtime' })) &&
      (await store.finish(activeLease, { status: 'failed', stages: reclaimed.snapshot.stages })),
  );

  await firstWorker.mf.dispose();
  firstWorker = undefined;
  const remaining = dueAtMs - Date.now() - 250;
  if (remaining > 0) await new Promise((resolveWait) => setTimeout(resolveWait, remaining));

  resumedWorker = await startHarness({
    site,
    persist: true,
    statePath,
    workerPath,
    bindings: { HUB_JOBS_ENABLED: 'true' },
  });
  check(
    'worker restart preserves the configured publication profile',
    resumedWorker.profileDigest === profileDigest,
  );
  const resumedNamespace = await namespaceFor(resumedWorker.mf);
  const durableStore = createDurableObjectPublicationJobStore({
    getByName: (name) => resumedNamespace.get(resumedNamespace.idFromName(name)),
  });

  const deadline = Date.now() + 120_000;
  let completed = null;
  while (Date.now() < deadline) {
    completed = await durableStore.get({ deckId, jobId });
    if (
      completed &&
      ['succeeded', 'partial', 'failed', 'superseded'].includes(completed.snapshot.status)
    )
      break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  check(
    'persisted alarm runs the queued publication after worker restart',
    completed?.snapshot.status === 'succeeded' &&
      completed.snapshot.result?.thumbnail === 'skipped',
  );
  const current = await durableStore.publications.current(deckId);
  check(
    'alarm publication and job result commit the same revision atomically',
    current?.revision === completed.snapshot.result.revision,
  );

  const autoJobId = randomUUID();
  const autoHash = createHash('sha256').update(autoInput).digest('hex');
  const autoJob = await durableStore.submit({
    snapshot: {
      id: autoJobId,
      deckId: autoThumbnailDeckId,
      kind: 'publication',
      status: 'queued',
      phase: 'runtime',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 0,
      stages: jobPhases.map((phase) => ({ phase, status: 'pending', attempt: 0 })),
    },
    requestHash: 'auto-thumbnail-no-browser-request-hash',
    inputKey: autoInputKey,
    inputHash: autoHash,
    profileDigest: resumedWorker.profileDigest,
    runtimeId: runtime.id,
    compilerContractVersion: 'native-click-metadata-v1',
    thumbnail: 'auto',
    viewTokenHash: 'auto-thumbnail-no-browser-view-token-hash',
    viewExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(autoJob.outcome, 'accepted');
  const autoDeadline = Date.now() + 120_000;
  let autoCompleted = null;
  while (Date.now() < autoDeadline) {
    autoCompleted = await durableStore.get({ deckId: autoThumbnailDeckId, jobId: autoJobId });
    if (
      autoCompleted &&
      ['succeeded', 'partial', 'failed', 'superseded'].includes(autoCompleted.snapshot.status)
    )
      break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  check(
    'auto thumbnail without a Browser Run binding finishes partial after publishing',
    autoCompleted?.snapshot.status === 'partial' &&
      autoCompleted.snapshot.result?.thumbnail === 'unavailable' &&
      autoCompleted.snapshot.error?.code === 'THUMBNAIL_UNAVAILABLE',
  );

  await resumedWorker.mf.dispose();
  resumedWorker = undefined;
  thumbnailWorker = await startHarness({
    site,
    persist: true,
    statePath,
    workerPath,
    entryPoint: browserEntryPath,
    bindings: {
      HUB_JOBS_ENABLED: 'true',
      PUBLIC_ORIGIN: 'https://synthetic-browser.invalid',
    },
  });
  const thumbnailNamespace = await namespaceFor(thumbnailWorker.mf);
  const thumbnailStore = createDurableObjectPublicationJobStore({
    getByName: (name) => thumbnailNamespace.get(thumbnailNamespace.idFromName(name)),
  });
  const screenshotBucket = await thumbnailWorker.mf.getR2Bucket('FILES');
  const screenshotInput = JSON.stringify({
    markdown: '# Synthetic Browser Run success\n\nThumbnail capture is wired.\n',
    assets: {},
  });
  const screenshotInputKey = `private/jobs/${autoThumbnailSuccessDeckId}/pending.json`;
  await screenshotBucket.put(screenshotInputKey, screenshotInput, {
    httpMetadata: { contentType: 'application/json' },
  });
  const screenshotJobId = randomUUID();
  const screenshotJob = await thumbnailStore.submit({
    snapshot: {
      id: screenshotJobId,
      deckId: autoThumbnailSuccessDeckId,
      kind: 'publication',
      status: 'queued',
      phase: 'runtime',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 0,
      stages: jobPhases.map((phase) => ({ phase, status: 'pending', attempt: 0 })),
    },
    requestHash: 'synthetic-browser-success-request-hash',
    inputKey: screenshotInputKey,
    inputHash: createHash('sha256').update(screenshotInput).digest('hex'),
    profileDigest: thumbnailWorker.profileDigest,
    runtimeId: runtime.id,
    compilerContractVersion: 'native-click-metadata-v1',
    thumbnail: 'auto',
    viewTokenHash: 'synthetic-browser-success-view-token-hash',
    viewExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(screenshotJob.outcome, 'accepted');
  const screenshotDeadline = Date.now() + 120_000;
  let screenshotCompleted = null;
  while (Date.now() < screenshotDeadline) {
    screenshotCompleted = await thumbnailStore.get({
      deckId: autoThumbnailSuccessDeckId,
      jobId: screenshotJobId,
    });
    if (
      screenshotCompleted &&
      ['succeeded', 'partial', 'failed', 'superseded'].includes(screenshotCompleted.snapshot.status)
    )
      break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const screenshotObject = screenshotCompleted?.snapshot.result
    ? await screenshotBucket.get(
        `releases/${autoThumbnailSuccessDeckId}/${screenshotCompleted.snapshot.result.revision}/thumbnail.png`,
      )
    : null;
  const screenshotBytes = screenshotObject
    ? new Uint8Array(await new Response(screenshotObject.body).arrayBuffer())
    : null;
  check(
    'synthetic Browser Run quickAction completes the alarm-driven thumbnail stage',
    screenshotCompleted?.snapshot.status === 'succeeded' &&
      screenshotCompleted.snapshot.result?.thumbnail === 'ready' &&
      screenshotObject?.httpMetadata?.contentType === 'image/png' &&
      screenshotBytes?.byteLength > 33 &&
      new DataView(screenshotBytes.buffer).getUint32(16, false) === 1200 &&
      new DataView(screenshotBytes.buffer).getUint32(20, false) === 675,
  );

  const evidence = {
    schemaVersion: 1,
    runner: 'Miniflare workerd with SQLite persistence',
    thumbnailFixture: 'synthetic Browser Run quickAction with generated valid PNG',
    passCount: checks.length,
    checks,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify({
      ok: true,
      passCount: checks.length,
      evidence: relative(artifactRoot, evidencePath),
      checks,
    }),
  );
} finally {
  await Promise.allSettled([
    oldWorker?.dispose(),
    firstWorker?.mf.dispose(),
    resumedWorker?.mf.dispose(),
    thumbnailWorker?.mf.dispose(),
  ]);
  await rm(scratch, { recursive: true, force: true });
}
