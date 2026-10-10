import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createMemoryPublicationJobStore } from '../dist/index.js';

const deckId = 'retention-deck';
const cutoff = '2024-02-01T00:00:00.000Z';
const phases = ['runtime', 'compile', 'store', 'publish', 'thumbnail'];

function makeJob(deck, options = {}) {
  const jobId = options.jobId ?? randomUUID();
  const createdAt = options.createdAt ?? '2024-01-01T00:00:00.000Z';
  return {
    snapshot: {
      id: jobId,
      deckId: deck,
      ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
      kind: options.kind ?? 'publication',
      status: 'queued',
      phase: 'runtime',
      version: 1,
      createdAt,
      updatedAt: createdAt,
      attempt: 0,
      stages: phases.map((phase) => ({ phase, status: 'pending', attempt: 0 })),
    },
    requestHash: `hash-${jobId}`,
    ...(options.inputKey
      ? {
          inputKey:
            options.inputKey === true ? `private/jobs/${deck}/${jobId}.json` : options.inputKey,
        }
      : {}),
    profileDigest: 'a'.repeat(64),
    compilerContractVersion: 'native-click-metadata-v1',
    thumbnail: 'none',
    viewTokenHash: 'b'.repeat(64),
    viewExpiresAt: '2024-01-08T00:00:00.000Z',
  };
}

async function finish(store, job, status, finishedAt) {
  const now = job.snapshot.createdAt;
  const leaseToken = randomUUID();
  const leaseUntil = new Date(Date.parse(finishedAt) + 60_000).toISOString();
  await store.claim({ now, leaseUntil, leaseToken, deckId: job.snapshot.deckId });
  assert.equal(
    await store.finish(
      { deckId: job.snapshot.deckId, jobId: job.snapshot.id, leaseToken, now: finishedAt },
      { status, stages: job.snapshot.stages },
    ),
    true,
  );
}

test('cleanup prunes old leaf families in passes and fences expired identity re-enqueue', async () => {
  const store = createMemoryPublicationJobStore();
  const parent = makeJob(deckId, { inputKey: true });
  await store.submit(parent);
  await finish(store, parent, 'failed', cutoff);
  const child = makeJob(deckId, {
    parentJobId: parent.snapshot.id,
    kind: 'thumbnail',
    inputKey: true,
  });
  await store.submit(child);
  await finish(store, child, 'succeeded', cutoff);
  const recent = makeJob(deckId, { inputKey: true });
  await store.submit(recent);
  await finish(store, recent, 'failed', '2024-02-01T00:00:00.001Z');
  const active = makeJob(deckId);
  await store.submit(active);
  const otherDeck = makeJob('other-retention-deck');
  await store.submit(otherDeck);
  await finish(store, otherDeck, 'failed', cutoff);

  const preview = await store.maintenance.cleanup({ deckId, cutoff, limit: 1, dryRun: true });
  assert.deepEqual(preview.jobs, [{ jobId: child.snapshot.id, finishedAt: cutoff }]);
  assert.equal(
    preview.more,
    true,
    'dry-run sees the eligible parent exposed by removing its child',
  );
  assert.ok(await store.get({ deckId, jobId: child.snapshot.id }));
  assert.equal(await store.maintenance.isExpired({ deckId, jobId: child.snapshot.id }), false);
  assert.equal(
    (await store.maintenance.listPendingInputDeletes({ deckId, limit: 1 })).pendingCount,
    0,
  );

  const first = await store.maintenance.cleanup({ deckId, cutoff, limit: 1, dryRun: false });
  assert.deepEqual(first.jobs, preview.jobs);
  assert.equal(first.more, true);
  assert.equal(await store.get({ deckId, jobId: child.snapshot.id }), null);
  assert.equal(await store.maintenance.isExpired({ deckId, jobId: child.snapshot.id }), true);
  assert.ok(
    await store.get({ deckId, jobId: parent.snapshot.id }),
    'a parent with a retained child stays',
  );
  assert.ok(await store.get({ deckId, jobId: recent.snapshot.id }), 'a post-cutoff job stays');
  assert.ok(await store.get({ deckId, jobId: active.snapshot.id }), 'an active job stays');
  assert.ok(await store.get({ deckId: 'other-retention-deck', jobId: otherDeck.snapshot.id }));

  const stalePending = (await store.maintenance.listPendingInputDeletes({ deckId, limit: 1 }))
    .items[0];
  assert.ok(stalePending);
  assert.equal((await store.submit(child)).outcome, 'expired');
  const refreshed = (await store.maintenance.listPendingInputDeletes({ deckId, limit: 1 }))
    .items[0];
  assert.notEqual(refreshed.token, stalePending.token);
  assert.equal(await store.maintenance.acknowledgeInputDelete(stalePending), false);

  const second = await store.maintenance.cleanup({ deckId, cutoff, limit: 1, dryRun: false });
  assert.deepEqual(second.jobs, [{ jobId: parent.snapshot.id, finishedAt: cutoff }]);
  assert.equal(second.more, false);
  assert.equal(await store.get({ deckId, jobId: parent.snapshot.id }), null);
  assert.equal((await store.get({ deckId, jobId: recent.snapshot.id })) !== null, true);
  assert.equal(
    (await store.maintenance.listPendingInputDeletes({ deckId, limit: 1 })).pendingCount,
    2,
  );
});

test('cleanup preserves a shared input until every referencing job is gone', async () => {
  const store = createMemoryPublicationJobStore();
  const old = makeJob(deckId, { inputKey: true });
  const inputKey = old.inputKey;
  await store.submit(old);
  await finish(store, old, 'failed', cutoff);
  const retained = makeJob(deckId, { inputKey });
  await store.submit(retained);

  const result = await store.maintenance.cleanup({ deckId, cutoff, limit: 10, dryRun: false });
  assert.deepEqual(
    result.jobs.map((job) => job.jobId),
    [old.snapshot.id],
  );
  assert.equal(result.more, false);
  assert.equal(
    (await store.maintenance.listPendingInputDeletes({ deckId, limit: 10 })).pendingCount,
    0,
  );
  assert.ok(await store.get({ deckId, jobId: retained.snapshot.id }));
});

test('an old parent stays while a recent or active child is retained', async () => {
  const store = createMemoryPublicationJobStore();
  const recentParent = makeJob(deckId);
  await store.submit(recentParent);
  await finish(store, recentParent, 'failed', cutoff);
  const recentChild = makeJob(deckId, {
    parentJobId: recentParent.snapshot.id,
    kind: 'thumbnail',
  });
  await store.submit(recentChild);
  await finish(store, recentChild, 'succeeded', '2024-02-01T00:00:00.001Z');

  const activeParent = makeJob(deckId);
  await store.submit(activeParent);
  await finish(store, activeParent, 'failed', cutoff);
  const activeChild = makeJob(deckId, {
    parentJobId: activeParent.snapshot.id,
    kind: 'thumbnail',
  });
  await store.submit(activeChild);

  const result = await store.maintenance.cleanup({ deckId, cutoff, limit: 100, dryRun: false });
  assert.deepEqual(result.jobs, []);
  assert.equal(result.more, false);
  for (const job of [recentParent, recentChild, activeParent, activeChild]) {
    assert.ok(await store.get({ deckId, jobId: job.snapshot.id }));
  }
});

const now = '2024-03-01T00:00:00.000Z';
const later = (minutes) => plusMs(now, minutes * 60_000);

function plusMs(value, milliseconds) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

async function completeJob(store, job, status, at) {
  const workToken = randomUUID();
  await store.claim({
    now: job.snapshot.createdAt,
    leaseUntil: plusMs(at, 60_000),
    leaseToken: workToken,
    deckId: job.snapshot.deckId,
  });
  assert.equal(
    await store.finish(
      { deckId: job.snapshot.deckId, jobId: job.snapshot.id, leaseToken: workToken, now: at },
      { status, stages: job.snapshot.stages },
    ),
    true,
  );
}

test('automatic cleanup is triggered only by terminal publication finish', async () => {
  const store = createMemoryPublicationJobStore();
  const schedule = store.maintenance.automatic;
  const thumbnail = makeJob('auto-thumbnail', { kind: 'thumbnail' });
  await store.submit(thumbnail);
  await completeJob(store, thumbnail, 'succeeded', now);
  assert.equal(
    await schedule.claim({
      now,
      leaseUntil: later(2),
      leaseToken: randomUUID(),
      deckId: thumbnail.snapshot.deckId,
    }),
    null,
  );

  const retryWait = makeJob('auto-retry-wait');
  await store.submit(retryWait);
  await completeJob(store, retryWait, 'retry_wait', now);
  assert.equal(
    await schedule.claim({
      now,
      leaseUntil: later(2),
      leaseToken: randomUUID(),
      deckId: retryWait.snapshot.deckId,
    }),
    null,
  );

  const superseded = makeJob('auto-superseded');
  await store.submit(superseded);
  await store.publications.begin(superseded.snapshot.deckId);
  assert.equal(
    await schedule.claim({
      now,
      leaseUntil: later(2),
      leaseToken: randomUUID(),
      deckId: superseded.snapshot.deckId,
    }),
    null,
  );

  const publication = makeJob('auto-terminal');
  await store.submit(publication);
  await completeJob(store, publication, 'failed', now);
  const lease = await schedule.claim({
    now,
    leaseUntil: later(2),
    leaseToken: randomUUID(),
    deckId: publication.snapshot.deckId,
  });
  assert.equal(lease?.deckId, publication.snapshot.deckId);
});

test('automatic cleanup throttles each deck for 24 hours and stops after an empty batch', async () => {
  const store = createMemoryPublicationJobStore();
  const schedule = store.maintenance.automatic;
  const first = makeJob('auto-throttle');
  await store.submit(first);
  await completeJob(store, first, 'failed', now);

  const attempts = await Promise.all([
    schedule.claim({
      now,
      leaseUntil: later(2),
      leaseToken: randomUUID(),
      deckId: first.snapshot.deckId,
    }),
    schedule.claim({
      now,
      leaseUntil: later(2),
      leaseToken: randomUUID(),
      deckId: first.snapshot.deckId,
    }),
  ]);
  assert.equal(attempts.filter(Boolean).length, 1, 'concurrent claims have a single winner');
  const lease = attempts.find(Boolean);
  assert.ok(lease);
  assert.equal(await schedule.finish(lease, { now: later(1), retry: false }), true);

  const second = makeJob(first.snapshot.deckId);
  await store.submit(second);
  await completeJob(store, second, 'partial', later(5));
  assert.equal(
    await schedule.claim({
      now: later(24 * 60 - 1),
      leaseUntil: later(24 * 60 + 1),
      leaseToken: randomUUID(),
      deckId: first.snapshot.deckId,
    }),
    null,
  );
  const nextDay = await schedule.claim({
    now: later(24 * 60),
    leaseUntil: later(24 * 60 + 2),
    leaseToken: randomUUID(),
    deckId: first.snapshot.deckId,
  });
  assert.equal(nextDay?.deckId, first.snapshot.deckId);
  assert.equal(await schedule.finish(nextDay, { now: later(24 * 60 + 1), retry: false }), true);
  assert.equal(
    await schedule.claim({
      now: later(3 * 24 * 60),
      leaseUntil: later(3 * 24 * 60 + 2),
      leaseToken: randomUUID(),
      deckId: first.snapshot.deckId,
    }),
    null,
  );
});

test('automatic cleanup keeps enqueues made during a lease and retries unfinished batches next day', async () => {
  const store = createMemoryPublicationJobStore();
  const schedule = store.maintenance.automatic;
  const first = makeJob('auto-during-lease');
  await store.submit(first);
  await completeJob(store, first, 'failed', now);
  const lease = await schedule.claim({
    now,
    leaseUntil: later(2),
    leaseToken: randomUUID(),
    deckId: first.snapshot.deckId,
  });
  assert.ok(lease);

  const second = makeJob(first.snapshot.deckId);
  await store.submit(second);
  await completeJob(store, second, 'failed', later(1));
  assert.equal(
    await schedule.claim({
      now: later(3),
      leaseUntil: later(5),
      leaseToken: randomUUID(),
      deckId: first.snapshot.deckId,
    }),
    null,
  );
  assert.equal(await schedule.finish(lease, { now: later(1), retry: false }), true);
  assert.equal(await schedule.finish(lease, { now: later(1), retry: true }), false);
  const followingDay = await schedule.claim({
    now: later(24 * 60),
    leaseUntil: later(24 * 60 + 2),
    leaseToken: randomUUID(),
    deckId: first.snapshot.deckId,
  });
  assert.equal(followingDay?.deckId, first.snapshot.deckId);
  assert.equal(await schedule.finish(followingDay, { now: later(24 * 60 + 1), retry: true }), true);
  assert.equal(
    await schedule.claim({
      now: later(48 * 60 - 1),
      leaseUntil: later(48 * 60 + 1),
      leaseToken: randomUUID(),
      deckId: first.snapshot.deckId,
    }),
    null,
  );
  assert.equal(
    (
      await schedule.claim({
        now: later(48 * 60),
        leaseUntil: later(48 * 60 + 2),
        leaseToken: randomUUID(),
        deckId: first.snapshot.deckId,
      })
    )?.deckId,
    first.snapshot.deckId,
  );
});

test('expired admission keeps automatic cleanup scheduled after idle and leased outbox drains', async () => {
  const store = createMemoryPublicationJobStore();
  const schedule = store.maintenance.automatic;
  const job = makeJob('auto-outbox-wake', { inputKey: true });
  await store.submit(job);
  await completeJob(store, job, 'failed', cutoff);

  const firstLease = await schedule.claim({
    now,
    leaseUntil: later(2),
    leaseToken: randomUUID(),
    deckId: job.snapshot.deckId,
  });
  assert.ok(firstLease);
  await store.maintenance.cleanup({
    deckId: job.snapshot.deckId,
    cutoff,
    limit: 100,
    dryRun: false,
  });
  const firstOutbox = (
    await store.maintenance.listPendingInputDeletes({
      deckId: job.snapshot.deckId,
      limit: 10,
    })
  ).items[0];
  assert.ok(firstOutbox);
  assert.equal(await store.maintenance.acknowledgeInputDelete(firstOutbox), true);
  assert.equal(await schedule.finish(firstLease, { now: later(1), retry: false }), true);

  assert.equal((await store.submit(job)).outcome, 'expired');
  assert.equal(
    (await store.maintenance.listPendingInputDeletes({ deckId: job.snapshot.deckId, limit: 10 }))
      .pendingCount,
    1,
  );
  const nextDayAt = later(24 * 60);
  const beforeIdleFollowup = await schedule.claim({
    now: later(24 * 60 - 1),
    leaseUntil: later(24 * 60 + 2),
    leaseToken: randomUUID(),
    deckId: job.snapshot.deckId,
  });
  assert.equal(beforeIdleFollowup, null);
  const idleFollowup = await schedule.claim({
    now: nextDayAt,
    leaseUntil: later(24 * 60 + 2),
    leaseToken: randomUUID(),
    deckId: job.snapshot.deckId,
  });
  assert.ok(idleFollowup);

  const secondOutbox = (
    await store.maintenance.listPendingInputDeletes({
      deckId: job.snapshot.deckId,
      limit: 10,
    })
  ).items[0];
  assert.ok(secondOutbox);
  assert.equal(await store.maintenance.acknowledgeInputDelete(secondOutbox), true);
  assert.equal((await store.submit(job)).outcome, 'expired');
  assert.equal(
    await schedule.finish(idleFollowup, { now: later(24 * 60 + 1), retry: false }),
    true,
  );

  const afterLeaseNextDay = await schedule.claim({
    now: later(48 * 60),
    leaseUntil: later(48 * 60 + 2),
    leaseToken: randomUUID(),
    deckId: job.snapshot.deckId,
  });
  assert.ok(afterLeaseNextDay, 'an expired submit during a batch survives finish(retry=false)');
});
