import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDurableObjectPublicationJobStore } from '@slidock/adapter-cloudflare';
import { startHarness } from './harness.mjs';

const cutoff = '2030-01-10T00:00:00.000Z';
const phases = ['runtime', 'compile', 'store', 'publish', 'thumbnail'];
const checks = [];
const check = (label, condition) => {
  assert.ok(condition, label);
  checks.push(label);
};

function makeJob(deckId, options = {}) {
  const id = options.id ?? randomUUID();
  const createdAt = options.createdAt;
  return {
    snapshot: {
      id,
      deckId,
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
    requestHash: `retention-${id}`,
    ...(options.inputKey
      ? {
          inputKey:
            options.inputKey === true ? `private/jobs/${deckId}/${id}.json` : options.inputKey,
        }
      : {}),
    profileDigest: 'a'.repeat(64),
    compilerContractVersion: 'native-click-metadata-v1',
    thumbnail: 'none',
    viewTokenHash: 'b'.repeat(64),
    viewExpiresAt: '2030-01-08T00:00:00.000Z',
  };
}

async function storeFor(mf) {
  const namespace = await mf.getDurableObjectNamespace('VERSIONS');
  return createDurableObjectPublicationJobStore({
    getByName: (name) => namespace.get(namespace.idFromName(name)),
  });
}

async function finishOld(store, job, status, seconds) {
  const now = job.snapshot.createdAt;
  const leaseToken = randomUUID();
  const finishedAt = new Date(Date.parse(now) + seconds * 1000).toISOString();
  const leaseUntil = new Date(Date.parse(finishedAt) + 120_000).toISOString();
  await store.claim({ deckId: job.snapshot.deckId, now, leaseUntil, leaseToken });
  assert.equal(
    await store.finish(
      {
        deckId: job.snapshot.deckId,
        jobId: job.snapshot.id,
        leaseToken,
        now: finishedAt,
      },
      { status, stages: job.snapshot.stages },
    ),
    true,
  );
}

async function finishWithPastTimestamp(store, job, status, finishedAt) {
  const claimAt = job.snapshot.createdAt;
  const leaseToken = randomUUID();
  const leaseUntil = new Date(Date.parse(claimAt) + 120_000).toISOString();
  assert.ok(
    await store.claim({
      deckId: job.snapshot.deckId,
      now: claimAt,
      leaseUntil,
      leaseToken,
    }),
  );
  assert.equal(
    await store.finish(
      {
        deckId: job.snapshot.deckId,
        jobId: job.snapshot.id,
        leaseToken,
        now: finishedAt,
      },
      { status, stages: job.snapshot.stages },
    ),
    true,
  );
}

const scratch = await mkdtemp(resolve(tmpdir(), 'slidev-jobs-retention-do-'));
const statePath = resolve(scratch, 'persistent-state');
const workerPath = resolve(scratch, 'worker.mjs');
let first;
let resumed;
try {
  first = await startHarness({
    persist: true,
    statePath,
    workerPath,
    bindings: { HUB_JOBS_ENABLED: 'true' },
  });
  const store = await storeFor(first.mf);
  const bucket = await first.mf.getR2Bucket('FILES');
  const deckId = 'retention/do-family';
  const futureA = '2030-01-01T00:00:00.000Z';
  const futureB = '2030-01-02T00:00:00.000Z';
  const parent = makeJob(deckId, { createdAt: futureA, inputKey: true });
  const child = makeJob(deckId, {
    createdAt: futureB,
    parentJobId: parent.snapshot.id,
    kind: 'thumbnail',
    inputKey: true,
  });
  for (const job of [parent, child])
    await bucket.put(job.inputKey, JSON.stringify({ job: job.snapshot.id }));
  assert.equal((await store.submit(parent)).outcome, 'accepted');
  await finishOld(store, parent, 'failed', 0);
  assert.equal((await store.submit(child)).outcome, 'accepted');
  await finishOld(store, child, 'succeeded', 1);

  const preview = await store.maintenance.cleanup({ deckId, cutoff, limit: 1, dryRun: true });
  check(
    'dry-run selects the old leaf and reports its newly exposed parent without mutation',
    preview.jobs.length === 1 && preview.jobs[0].jobId === child.snapshot.id && preview.more,
  );
  check(
    'dry-run creates neither tombstones nor pending input deletes',
    !(await store.maintenance.isExpired({ deckId, jobId: child.snapshot.id })) &&
      (await store.maintenance.listPendingInputDeletes({ deckId, limit: 10 })).pendingCount === 0,
  );

  const firstBatch = await store.maintenance.cleanup({ deckId, cutoff, limit: 1, dryRun: false });
  check(
    'apply deletes only the leaf and points to another cleanup pass',
    firstBatch.jobs.length === 1 &&
      firstBatch.jobs[0].jobId === child.snapshot.id &&
      firstBatch.more,
  );
  const staleItem = (await store.maintenance.listPendingInputDeletes({ deckId, limit: 10 }))
    .items[0];
  check(
    'the removed child identity is permanently tombstoned',
    await store.maintenance.isExpired({
      deckId,
      jobId: child.snapshot.id,
    }),
  );
  check(
    'a deleted child input is durably pending',
    !!staleItem && staleItem.inputKey === child.inputKey,
  );
  check(
    'its parent remains while a child was retained',
    (await store.get({
      deckId,
      jobId: parent.snapshot.id,
    })) !== null,
  );

  check(
    'late admission is rejected and refreshes the outbox token',
    (await store.submit(child)).outcome === 'expired',
  );
  const refreshed = (await store.maintenance.listPendingInputDeletes({ deckId, limit: 10 }))
    .items[0];
  check(
    'a stale deletion acknowledgement cannot erase a refreshed outbox item',
    refreshed.token !== staleItem.token &&
      !(await store.maintenance.acknowledgeInputDelete(staleItem)),
  );

  const secondBatch = await store.maintenance.cleanup({ deckId, cutoff, limit: 1, dryRun: false });
  check(
    'the next pass removes its now-leaf parent and reports completion',
    secondBatch.jobs.length === 1 &&
      secondBatch.jobs[0].jobId === parent.snapshot.id &&
      !secondBatch.more,
  );
  const beforeRestart = await store.maintenance.listPendingInputDeletes({ deckId, limit: 10 });
  check(
    'parent and child deletions both remain in the durable outbox',
    beforeRestart.pendingCount === 2,
  );

  await first.mf.dispose();
  first = undefined;
  resumed = await startHarness({
    persist: true,
    statePath,
    workerPath,
    bindings: { HUB_JOBS_ENABLED: 'true' },
  });
  const resumedStore = await storeFor(resumed.mf);
  const resumedBucket = await resumed.mf.getR2Bucket('FILES');
  const afterRestart = await resumedStore.maintenance.listPendingInputDeletes({
    deckId,
    limit: 10,
  });
  check(
    'pending private-input deletion survives a Worker restart',
    afterRestart.pendingCount === 2,
  );
  for (const item of afterRestart.items) {
    await resumedBucket.delete(item.inputKey);
    check(
      `R2 deletion and fenced acknowledgement succeed for ${item.jobId}`,
      await resumedStore.maintenance.acknowledgeInputDelete(item),
    );
  }
  check(
    'retry drains the durable outbox and treats object deletion as complete',
    (await resumedStore.maintenance.listPendingInputDeletes({ deckId, limit: 10 })).pendingCount ===
      0 &&
      (await resumedBucket.get(parent.inputKey)) === null &&
      (await resumedBucket.get(child.inputKey)) === null,
  );

  const protectedDeck = 'retention/do-protected-children';
  const recentParent = makeJob(protectedDeck, { createdAt: '2030-01-03T00:00:00.000Z' });
  await resumedStore.submit(recentParent);
  await finishOld(resumedStore, recentParent, 'failed', 0);
  const recentChild = makeJob(protectedDeck, {
    createdAt: '2030-01-11T00:00:00.000Z',
    parentJobId: recentParent.snapshot.id,
    kind: 'thumbnail',
  });
  await resumedStore.submit(recentChild);
  await finishOld(resumedStore, recentChild, 'succeeded', 86_460);
  const activeParent = makeJob(protectedDeck, { createdAt: '2030-01-05T00:00:00.000Z' });
  await resumedStore.submit(activeParent);
  await finishOld(resumedStore, activeParent, 'failed', 0);
  const activeChild = makeJob(protectedDeck, {
    createdAt: '2030-01-06T00:00:00.000Z',
    parentJobId: activeParent.snapshot.id,
    kind: 'thumbnail',
  });
  await resumedStore.submit(activeChild);
  const protectedJobs = await resumedStore.maintenance.cleanup({
    deckId: protectedDeck,
    cutoff,
    limit: 10,
    dryRun: false,
  });
  check(
    'old parent jobs remain while their recent or active child is retained',
    protectedJobs.jobs.length === 0 &&
      (await resumedStore.get({ deckId: protectedDeck, jobId: recentParent.snapshot.id })) !==
        null &&
      (await resumedStore.get({ deckId: protectedDeck, jobId: recentChild.snapshot.id })) !==
        null &&
      (await resumedStore.get({ deckId: protectedDeck, jobId: activeParent.snapshot.id })) !==
        null &&
      (await resumedStore.get({ deckId: protectedDeck, jobId: activeChild.snapshot.id })) !== null,
  );

  const sharedDeck = 'retention/do-shared-input';
  const sharedOld = makeJob(sharedDeck, {
    createdAt: '2030-01-07T00:00:00.000Z',
    inputKey: true,
  });
  await resumedStore.submit(sharedOld);
  await finishOld(resumedStore, sharedOld, 'failed', 0);
  const sharedRetained = makeJob(sharedDeck, {
    createdAt: '2030-01-08T00:00:00.000Z',
    inputKey: sharedOld.inputKey,
  });
  await resumedStore.submit(sharedRetained);
  const sharedCleanup = await resumedStore.maintenance.cleanup({
    deckId: sharedDeck,
    cutoff,
    limit: 10,
    dryRun: false,
  });
  check(
    'an input shared with a retained job is not added to the deletion outbox',
    sharedCleanup.jobs.length === 1 &&
      sharedCleanup.jobs[0].jobId === sharedOld.snapshot.id &&
      (await resumedStore.maintenance.listPendingInputDeletes({ deckId: sharedDeck, limit: 10 }))
        .pendingCount === 0 &&
      (await resumedStore.get({ deckId: sharedDeck, jobId: sharedRetained.snapshot.id })) !== null,
  );

  const alarmDeck = 'retention/do-alarm';
  const alarmJob = makeJob(alarmDeck, {
    createdAt: '2030-01-09T00:00:00.000Z',
    inputKey: true,
  });
  await resumedBucket.put(alarmJob.inputKey, JSON.stringify({ job: alarmJob.snapshot.id }));
  assert.equal((await resumedStore.submit(alarmJob)).outcome, 'accepted');
  await finishWithPastTimestamp(resumedStore, alarmJob, 'failed', '2024-01-01T00:00:01.000Z');
  const alarmDeadline = Date.now() + 30_000;
  let alarmCleanupDone = false;
  while (Date.now() < alarmDeadline) {
    alarmCleanupDone =
      (await resumedStore.maintenance.isExpired({
        deckId: alarmDeck,
        jobId: alarmJob.snapshot.id,
      })) &&
      (await resumedStore.get({ deckId: alarmDeck, jobId: alarmJob.snapshot.id })) === null &&
      (await resumedBucket.get(alarmJob.inputKey)) === null;
    if (alarmCleanupDone) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  check(
    'a terminal publication persists an alarm that automatically cleans old history and input',
    alarmCleanupDone,
  );

  const followup = makeJob(alarmDeck, { createdAt: '2030-01-10T00:00:00.000Z' });
  assert.equal((await resumedStore.submit(followup)).outcome, 'accepted');
  await finishOld(resumedStore, followup, 'failed', 1);
  await resumedBucket.put(alarmJob.inputKey, JSON.stringify({ recreated: true }));
  check(
    'expired admission after an idle cleanup recreates pending cleanup work',
    (await resumedStore.submit(alarmJob)).outcome === 'expired',
  );

  const automatic = resumedStore.maintenance.automatic;
  const baseMs = Date.parse('2035-01-01T00:00:00.000Z');
  const schedulerLease = await automatic.claim({
    deckId: alarmDeck,
    now: new Date(baseMs).toISOString(),
    leaseUntil: new Date(baseMs + 120_000).toISOString(),
    leaseToken: randomUUID(),
  });
  check('recreated outbox work can be claimed after the previous idle batch', !!schedulerLease);
  check(
    'expired admission during a cleanup lease persists another pending request',
    (await resumedStore.submit(alarmJob)).outcome === 'expired',
  );
  check(
    'successful idle completion preserves an outbox wake made while leased',
    await automatic.finish(schedulerLease, {
      now: new Date(baseMs + 1_000).toISOString(),
      retry: false,
    }),
  );
  const nextDayMs = baseMs + 24 * 60 * 60 * 1000;
  const beforeNextDay = await automatic.claim({
    deckId: alarmDeck,
    now: new Date(nextDayMs - 1_000).toISOString(),
    leaseUntil: new Date(nextDayMs + 120_000).toISOString(),
    leaseToken: randomUUID(),
  });
  check('outbox wake remains throttled until the next daily slot', beforeNextDay === null);

  await resumed.mf.dispose();
  resumed = undefined;
  resumed = await startHarness({
    persist: true,
    statePath,
    workerPath,
    bindings: { HUB_JOBS_ENABLED: 'true' },
  });
  const persistedStore = await storeFor(resumed.mf);
  const persistedAutomatic = persistedStore.maintenance.automatic;
  const persistedBeforeNextDay = await persistedAutomatic.claim({
    deckId: alarmDeck,
    now: new Date(nextDayMs - 1_000).toISOString(),
    leaseUntil: new Date(nextDayMs + 120_000).toISOString(),
    leaseToken: randomUUID(),
  });
  check(
    'the daily throttle and pending request survive a Worker restart',
    persistedBeforeNextDay === null,
  );
  const persistedNextDay = await persistedAutomatic.claim({
    deckId: alarmDeck,
    now: new Date(nextDayMs).toISOString(),
    leaseUntil: new Date(nextDayMs + 120_000).toISOString(),
    leaseToken: randomUUID(),
  });
  check('persisted pending work becomes claimable at the next daily slot', !!persistedNextDay);
} finally {
  await first?.mf.dispose();
  await resumed?.mf.dispose();
  await rm(scratch, { recursive: true, force: true });
}

console.log(`Verified ${checks.length} Durable Object job-retention invariants.`);
