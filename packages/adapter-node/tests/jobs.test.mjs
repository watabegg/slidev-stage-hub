import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createMemoryPublicationJobStore } from '../dist/index.js';

const now = '2026-10-10T01:00:00.000Z';
const later = (minutes) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const revision = 'a'.repeat(64);
const runtimeId = 'b'.repeat(64);
const phases = ['runtime', 'compile', 'store', 'publish', 'thumbnail'];

function makeJob(deckId, options = {}) {
  const id = options.id ?? randomUUID();
  const kind = options.kind ?? 'publication';
  const timestamp = options.createdAt ?? now;
  return {
    snapshot: {
      id,
      deckId,
      ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
      kind,
      status: 'queued',
      phase: kind === 'thumbnail' ? 'thumbnail' : 'runtime',
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      attempt: 0,
      stages: phases.map((phase) => ({
        phase,
        status: kind === 'thumbnail' && phase !== 'thumbnail' ? 'skipped' : 'pending',
        attempt: 0,
      })),
      ...(options.result ? { result: structuredClone(options.result) } : {}),
    },
    requestHash: options.requestHash ?? `hash-${id}`,
    ...(options.inputKey ? { inputKey: options.inputKey } : {}),
    ...(options.inputHash ? { inputHash: options.inputHash } : {}),
    ...(options.targetRevision ? { targetRevision: options.targetRevision } : {}),
    ...(options.runtimeId === null ? {} : { runtimeId: options.runtimeId ?? runtimeId }),
    profileDigest: 'c'.repeat(64),
    compilerContractVersion: 'native-click-metadata-v1',
    thumbnail: options.thumbnail ?? 'auto',
    viewTokenHash: 'd'.repeat(64),
    viewExpiresAt: later(7 * 24 * 60),
  };
}

function lease(deckId, jobId, token, at = now) {
  return { deckId, jobId, leaseToken: token, now: at };
}

function result(revisionValue = revision, thumbnail = 'pending') {
  return { revision: revisionValue, entry: '/index.html', pages: 3, cached: false, thumbnail };
}

test('paired admission replays, conflicts, and legacy begin supersedes only unpublished jobs', async () => {
  const store = createMemoryPublicationJobStore();
  const deckId = 'deck-order';
  const first = makeJob(deckId, { requestHash: 'same' });
  const accepted = await store.submit(first);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.job.generation, '1');
  assert.equal((await store.submit(first)).outcome, 'replayed');
  assert.equal((await store.submit({ ...first, requestHash: 'different' })).outcome, 'conflict');
  assert.equal(await store.publications.commit(deckId, '1', { revision: 'old-current' }), true);

  const firstLease = { deckId, jobId: first.snapshot.id, leaseToken: randomUUID(), now };
  const claimedFirst = await store.claim({
    now,
    leaseUntil: later(2),
    leaseToken: firstLease.leaseToken,
    deckId,
  });
  assert.equal(claimedFirst.snapshot.attempt, 0, 'claim leaves attempt accounting to the runner');
  assert.equal(claimedFirst.snapshot.stages[0].attempt, 0);
  assert.equal(
    await store.commitPublication(firstLease, { revision }, result(), first.snapshot.stages),
    'published',
  );

  const second = makeJob(deckId);
  const secondAdmission = await store.submit(second);
  assert.equal(secondAdmission.outcome, 'accepted');
  assert.equal(secondAdmission.job.generation, '2');
  const preserved = await store.get({ deckId, jobId: first.snapshot.id });
  assert.equal(preserved.snapshot.status, 'running');
  assert.equal(preserved.snapshot.result.revision, revision);
  assert.equal(preserved.leaseToken, firstLease.leaseToken);

  const secondLeaseToken = randomUUID();
  const runningSecond = await store.claim({
    now,
    leaseUntil: later(2),
    leaseToken: secondLeaseToken,
    deckId,
  });
  const runningStages = runningSecond.snapshot.stages.map((stage, index) =>
    index === 0 ? { ...stage, status: 'running' } : stage,
  );
  await store.checkpoint(lease(deckId, second.snapshot.id, secondLeaseToken), {
    progress: { completed: 1, total: 5, unit: 'slides' },
    stages: runningStages,
  });
  assert.equal(await store.publications.begin(deckId), '3');
  const superseded = await store.get({ deckId, jobId: second.snapshot.id });
  assert.equal(superseded.snapshot.status, 'superseded');
  assert.equal(superseded.leaseToken, undefined);
  assert.equal(superseded.snapshot.progress, undefined);
  assert.equal(superseded.snapshot.error, undefined);
  assert.ok(superseded.snapshot.stages.every((stage) => stage.status === 'skipped'));
  assert.ok(
    superseded.snapshot.stages.every(
      (stage) => stage.finishedAt === superseded.snapshot.finishedAt,
    ),
  );
  assert.deepEqual(await store.publications.current(deckId), { revision });
  assert.equal(
    await store.finish(lease(deckId, second.snapshot.id, secondLeaseToken), {
      status: 'failed',
      stages: second.snapshot.stages,
    }),
    false,
  );
  assert.equal(
    await store.finish(firstLease, {
      status: 'succeeded',
      stages: first.snapshot.stages,
    }),
    true,
    'a published job may finish its thumbnail phase after a newer begin',
  );
  assert.equal(
    (await store.get({ deckId, jobId: first.snapshot.id })).snapshot.result.revision,
    revision,
  );
});

test('superseding retry-wait jobs clears retry state and closes unfinished stages', async () => {
  const store = createMemoryPublicationJobStore();
  const deckId = 'deck-retry-wait-supersede';
  const job = makeJob(deckId);
  await store.submit(job);
  const token = randomUUID();
  const claimed = await store.claim({ now, leaseUntil: later(2), leaseToken: token, deckId });
  const stages = claimed.snapshot.stages.map((stage, index) =>
    index === 1 ? { ...stage, status: 'running' } : stage,
  );
  await store.checkpoint(lease(deckId, job.snapshot.id, token), {
    progress: { completed: 1, total: 5, unit: 'slides' },
    stages,
  });
  await store.finish(lease(deckId, job.snapshot.id, token), {
    status: 'retry_wait',
    nextRunAt: later(5),
    stages,
    error: { code: 'STORE_FAILED', message: 'Private failure', retryable: true },
  });
  await store.publications.begin(deckId);
  const superseded = await store.get({ deckId, jobId: job.snapshot.id });
  assert.equal(superseded.snapshot.status, 'superseded');
  assert.equal(superseded.snapshot.nextRunAt, undefined);
  assert.equal(superseded.snapshot.progress, undefined);
  assert.equal(superseded.snapshot.error, undefined);
  assert.equal(superseded.snapshot.stages[1].status, 'skipped');
  assert.equal(superseded.snapshot.stages[1].finishedAt, superseded.snapshot.finishedAt);
});

test('expired leases are reclaimable, tokens fence old workers, and expiry is strict', async () => {
  const store = createMemoryPublicationJobStore();
  const job = makeJob('deck-lease');
  job.snapshot.attempt = 3;
  job.snapshot.stages[0].attempt = 2;
  await store.submit(job);
  const firstToken = randomUUID();
  const first = await store.claim({
    now,
    leaseUntil: later(1),
    leaseToken: firstToken,
    deckId: job.snapshot.deckId,
  });
  assert.equal(first.leaseToken, firstToken);
  assert.equal(first.snapshot.attempt, 3);
  assert.equal(first.snapshot.stages[0].attempt, 2);

  const secondToken = randomUUID();
  const reclaimed = await store.claim({
    now: later(1),
    leaseUntil: later(3),
    leaseToken: secondToken,
    deckId: job.snapshot.deckId,
  });
  assert.equal(reclaimed.snapshot.id, job.snapshot.id);
  assert.equal(reclaimed.leaseToken, secondToken);
  assert.equal(reclaimed.snapshot.attempt, 3);
  assert.equal(reclaimed.snapshot.stages[0].attempt, 2);
  assert.equal(
    await store.checkpoint(lease(job.snapshot.deckId, job.snapshot.id, firstToken, later(1)), {
      phase: 'compile',
    }),
    false,
  );
  assert.equal(
    await store.checkpoint(lease(job.snapshot.deckId, job.snapshot.id, secondToken, later(1)), {
      phase: 'compile',
      leaseUntil: later(2),
    }),
    true,
  );
  assert.equal(
    await store.finish(lease(job.snapshot.deckId, job.snapshot.id, secondToken, later(2)), {
      status: 'failed',
      stages: job.snapshot.stages,
    }),
    false,
    'leaseUntil must be strictly later than now',
  );
});

test('publication commit stores current and the published result atomically for recovery', async () => {
  const store = createMemoryPublicationJobStore();
  const job = makeJob('deck-commit');
  await store.submit(job);
  const token = randomUUID();
  await store.claim({ now, leaseUntil: later(2), leaseToken: token, deckId: job.snapshot.deckId });
  const prepared = { revision, slides: [{ path: '/index.html' }] };
  assert.equal(
    await store.checkpoint(lease(job.snapshot.deckId, job.snapshot.id, token), {
      preparedManifest: prepared,
      preparedCached: true,
    }),
    true,
  );
  const manifest = { revision, entry: '/index.html' };
  assert.equal(
    await store.commitPublication(
      lease(job.snapshot.deckId, job.snapshot.id, token),
      manifest,
      result(),
      job.snapshot.stages,
    ),
    'published',
  );
  assert.deepEqual(await store.publications.current(job.snapshot.deckId), manifest);
  const recovered = await store.get({ deckId: job.snapshot.deckId, jobId: job.snapshot.id });
  assert.deepEqual(recovered.snapshot.result, result());
  assert.deepEqual(recovered.preparedManifest, prepared);
  assert.equal(recovered.preparedCached, true);
  assert.equal(
    await store.commitPublication(
      lease(job.snapshot.deckId, job.snapshot.id, token),
      manifest,
      result(),
      job.snapshot.stages,
    ),
    'published',
    'a retry after the atomic commit can safely recover the same publication',
  );
  assert.equal(
    await store.finish(lease(job.snapshot.deckId, job.snapshot.id, token), {
      status: 'partial',
      stages: job.snapshot.stages,
    }),
    true,
  );
  assert.deepEqual(
    (await store.get({ deckId: job.snapshot.deckId, jobId: job.snapshot.id })).snapshot.result,
    result(),
  );
});

test('thumbnail retry targets and copies the old published result without allocating a generation', async () => {
  const store = createMemoryPublicationJobStore();
  const deckId = 'deck-thumbnail';
  const parent = makeJob(deckId);
  await store.submit(parent);
  const parentToken = randomUUID();
  await store.claim({ now, leaseUntil: later(3), leaseToken: parentToken, deckId });
  const oldResult = result(revision, 'skipped');
  assert.equal(
    await store.commitPublication(
      lease(deckId, parent.snapshot.id, parentToken),
      {
        revision,
        entry: '/index.html',
      },
      oldResult,
      parent.snapshot.stages,
    ),
    'published',
  );
  assert.equal(
    await store.finish(lease(deckId, parent.snapshot.id, parentToken), {
      status: 'partial',
      stages: parent.snapshot.stages,
      result: oldResult,
    }),
    true,
  );

  const newer = makeJob(deckId);
  const newerAccepted = await store.submit(newer);
  const newerToken = randomUUID();
  await store.claim({ now, leaseUntil: later(3), leaseToken: newerToken, deckId });
  const newerRevision = 'e'.repeat(64);
  assert.equal(
    await store.commitPublication(
      lease(deckId, newer.snapshot.id, newerToken),
      {
        revision: newerRevision,
        entry: '/index.html',
      },
      result(newerRevision, 'ready'),
      newer.snapshot.stages,
    ),
    'published',
  );
  assert.equal(newerAccepted.job.generation, '2');

  const child = makeJob(deckId, {
    kind: 'thumbnail',
    parentJobId: parent.snapshot.id,
    targetRevision: revision,
    result: { ...oldResult, thumbnail: 'pending' },
  });
  const retried = await store.retry({ deckId, jobId: parent.snapshot.id }, 'thumbnail', child);
  assert.equal(retried.outcome, 'accepted');
  assert.equal(retried.job.targetRevision, revision);
  assert.deepEqual(retried.job.snapshot.result, { ...oldResult, thumbnail: 'pending' });
  assert.equal(retried.job.generation, undefined);
  const duplicateChild = makeJob(deckId, {
    kind: 'thumbnail',
    parentJobId: parent.snapshot.id,
    requestHash: 'another',
  });
  assert.equal(
    (await store.retry({ deckId, jobId: parent.snapshot.id }, 'thumbnail', duplicateChild)).outcome,
    'active_retry',
  );
  const after = await store.submit(makeJob(deckId));
  assert.equal(
    after.job.generation,
    '3',
    'thumbnail retries never consume a publication generation',
  );
});

test('ten active jobs enforce quota without consuming a generation on rejection', async () => {
  const store = createMemoryPublicationJobStore();
  const deckId = 'deck-quota';
  const leases = [];
  for (let index = 0; index < 10; index += 1) {
    const job = makeJob(deckId);
    const accepted = await store.submit(job);
    assert.equal(accepted.outcome, 'accepted');
    const token = randomUUID();
    await store.claim({ now, leaseUntil: later(10), leaseToken: token, deckId });
    const jobResult = result(index.toString(16).padStart(64, 'f'), 'pending');
    assert.equal(
      await store.commitPublication(
        lease(deckId, job.snapshot.id, token),
        {
          revision: jobResult.revision,
          entry: '/index.html',
        },
        jobResult,
        job.snapshot.stages,
      ),
      'published',
    );
    leases.push({ id: job.snapshot.id, token, stages: job.snapshot.stages });
  }
  const rejected = await store.submit(makeJob(deckId));
  assert.equal(rejected.outcome, 'limit');
  for (const item of leases) {
    assert.equal(
      await store.finish(lease(deckId, item.id, item.token), {
        status: 'partial',
        stages: item.stages,
      }),
      true,
    );
  }
  const next = await store.submit(makeJob(deckId));
  assert.equal(next.outcome, 'accepted');
  assert.equal(next.job.generation, '11');
});

test('list cursors page deterministically and reject cross-deck or malformed cursors', async () => {
  const store = createMemoryPublicationJobStore();
  const deckId = 'deck-cursor';
  const ids = [
    '00000000-0000-4000-8000-000000000009',
    '00000000-0000-4000-8000-00000000000a',
    '00000000-0000-4000-8000-00000000000f',
    '00000000-0000-4000-8000-000000000010',
  ];
  for (const id of ids) await store.submit(makeJob(deckId, { id }));
  const first = await store.list({ deckId, limit: 2 });
  assert.deepEqual(
    first.items.map((item) => item.snapshot.id),
    ids.slice(2).reverse(),
  );
  assert.ok(first.nextCursor);
  const second = await store.list({ deckId, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    second.items.map((item) => item.snapshot.id),
    ids.slice(0, 2).reverse(),
  );
  assert.equal(second.nextCursor, undefined);
  await assert.rejects(
    store.list({ deckId: 'other-deck', limit: 2, cursor: first.nextCursor }),
    /cursor/i,
  );
  await assert.rejects(store.list({ deckId, limit: 2, cursor: 'not-a-cursor' }), /cursor/i);
});

test('full retry rejects active siblings before changing the deck generation', async () => {
  const store = createMemoryPublicationJobStore();
  const deckId = 'deck-active-retry';
  const parent = makeJob(deckId, {
    inputKey: 'private/jobs/source.json',
    inputHash: 'f'.repeat(64),
  });
  const acceptedParent = await store.submit(parent);
  const parentToken = randomUUID();
  await store.claim({ now, leaseUntil: later(2), leaseToken: parentToken, deckId });
  assert.equal(
    await store.finish(lease(deckId, parent.snapshot.id, parentToken), {
      status: 'failed',
      stages: parent.snapshot.stages,
    }),
    true,
  );

  const child = makeJob(deckId, {
    parentJobId: parent.snapshot.id,
    inputKey: parent.inputKey,
    inputHash: parent.inputHash,
  });
  const retried = await store.retry({ deckId, jobId: parent.snapshot.id }, 'all', child);
  assert.equal(retried.outcome, 'accepted');
  assert.equal(retried.job.generation, String(Number(acceptedParent.job.generation) + 1));
  const duplicate = makeJob(deckId, {
    parentJobId: parent.snapshot.id,
    inputKey: parent.inputKey,
    inputHash: parent.inputHash,
  });
  assert.equal(
    (await store.retry({ deckId, jobId: parent.snapshot.id }, 'all', duplicate)).outcome,
    'active_retry',
  );
  const next = await store.submit(makeJob(deckId));
  assert.equal(next.job.generation, String(Number(retried.job.generation) + 1));
});
