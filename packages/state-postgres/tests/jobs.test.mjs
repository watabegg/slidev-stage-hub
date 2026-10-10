import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import test from 'node:test';
import {
  createPostgresPublicationJobStore,
  initializePostgresPublicationJobStore,
} from '../dist/index.js';

const connectionString = process.env.HUB_TEST_DATABASE_URL;
const databaseTest = connectionString ? test : test.skip;
const now = '2026-10-10T02:00:00.000Z';
const later = (minutes) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const revision = 'a'.repeat(64);
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
    ...(options.runtimeId === null ? {} : { runtimeId: options.runtimeId ?? 'b'.repeat(64) }),
    profileDigest: 'c'.repeat(64),
    compilerContractVersion: 'native-click-metadata-v1',
    thumbnail: options.thumbnail ?? 'auto',
    viewTokenHash: 'd'.repeat(64),
    viewExpiresAt: later(7 * 24 * 60),
  };
}

function jobResult(revisionValue = revision, thumbnail = 'pending') {
  return { revision: revisionValue, entry: '/index.html', pages: 3, cached: false, thumbnail };
}

function lease(deckId, jobId, leaseToken, at = now) {
  return { deckId, jobId, leaseToken, now: at };
}

async function clean(pool, decks) {
  await pool.query('DELETE FROM hub_publication_job_cleanup WHERE deck_id = ANY($1::text[])', [
    decks,
  ]);
  await pool.query('DELETE FROM hub_publication_jobs WHERE deck_id = ANY($1::text[])', [decks]);
  await pool.query('DELETE FROM hub_publications WHERE deck_id = ANY($1::text[])', [decks]);
}

databaseTest(
  'paired PostgreSQL stores commit current and job result atomically and supersede only unpublished jobs',
  async () => {
    const pool = new Pool({ connectionString, max: 8 });
    const otherPool = new Pool({ connectionString, max: 2 });
    const suffix = randomUUID();
    const deckId = `jobs-paired-${suffix}`;
    try {
      await initializePostgresPublicationJobStore(pool);
      await initializePostgresPublicationJobStore(pool);
      const firstStore = createPostgresPublicationJobStore({ pool });
      const secondStore = createPostgresPublicationJobStore({ pool: otherPool });
      const job = makeJob(deckId);
      const accepted = await firstStore.submit(job);
      assert.equal(accepted.outcome, 'accepted');
      assert.equal(accepted.job.generation, '1');
      assert.equal((await secondStore.submit(job)).outcome, 'replayed');
      assert.equal(
        (await secondStore.submit({ ...job, requestHash: 'different' })).outcome,
        'conflict',
      );

      const token = randomUUID();
      const claimed = await firstStore.claim({
        now,
        leaseUntil: later(2),
        leaseToken: token,
        deckId,
      });
      assert.equal(claimed.snapshot.attempt, 0);
      assert.equal(claimed.snapshot.stages[0].attempt, 0);
      const prepared = { revision, slideCount: 3 };
      assert.equal(
        await firstStore.checkpoint(lease(deckId, job.snapshot.id, token), {
          preparedManifest: prepared,
          preparedCached: true,
        }),
        true,
      );
      const manifest = { revision, entry: '/index.html' };
      assert.equal(
        await secondStore.commitPublication(
          lease(deckId, job.snapshot.id, token),
          manifest,
          jobResult(),
          job.snapshot.stages,
        ),
        'published',
      );
      assert.deepEqual(await firstStore.publications.current(deckId), manifest);
      const persisted = await firstStore.get({ deckId, jobId: job.snapshot.id });
      assert.deepEqual(persisted.snapshot.result, jobResult());
      assert.deepEqual(persisted.preparedManifest, prepared);
      assert.equal(persisted.preparedCached, true);
      assert.equal(persisted.runtimeId, job.runtimeId);

      assert.equal(await firstStore.publications.begin(deckId), '2');
      const publishedJob = await firstStore.get({ deckId, jobId: job.snapshot.id });
      assert.equal(publishedJob.snapshot.status, 'running');
      assert.equal(publishedJob.leaseToken, token);
      assert.equal(
        await firstStore.finish(lease(deckId, job.snapshot.id, token), {
          status: 'partial',
          stages: job.snapshot.stages,
        }),
        true,
      );
      assert.deepEqual(
        (await secondStore.get({ deckId, jobId: job.snapshot.id })).snapshot.result,
        jobResult(),
      );

      const pending = makeJob(deckId);
      assert.equal((await firstStore.submit(pending)).job.generation, '3');
      const pendingToken = randomUUID();
      await firstStore.claim({ now, leaseUntil: later(2), leaseToken: pendingToken, deckId });
      const pendingStages = pending.snapshot.stages.map((stage, index) =>
        index === 0 ? { ...stage, status: 'running' } : stage,
      );
      await firstStore.checkpoint(lease(deckId, pending.snapshot.id, pendingToken), {
        progress: { completed: 1, total: 3, unit: 'slides' },
        stages: pendingStages,
      });
      assert.equal(await secondStore.publications.begin(deckId), '4');
      const superseded = await firstStore.get({ deckId, jobId: pending.snapshot.id });
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
      assert.equal(
        await firstStore.checkpoint(lease(deckId, pending.snapshot.id, pendingToken), {
          phase: 'compile',
        }),
        false,
      );
      assert.equal(
        await firstStore.commitPublication(
          lease(deckId, pending.snapshot.id, pendingToken),
          { revision: 'e'.repeat(64) },
          jobResult('e'.repeat(64)),
          pending.snapshot.stages,
        ),
        'superseded',
      );
      assert.deepEqual(await firstStore.publications.current(deckId), manifest);

      const retryWait = makeJob(deckId);
      await firstStore.submit(retryWait);
      const retryWaitToken = randomUUID();
      const retryClaim = await firstStore.claim({
        now,
        leaseUntil: later(2),
        leaseToken: retryWaitToken,
        deckId,
      });
      const retryStages = retryClaim.snapshot.stages.map((stage, index) =>
        index === 1 ? { ...stage, status: 'running' } : stage,
      );
      await firstStore.checkpoint(lease(deckId, retryWait.snapshot.id, retryWaitToken), {
        progress: { completed: 1, total: 3, unit: 'slides' },
        stages: retryStages,
      });
      await firstStore.finish(lease(deckId, retryWait.snapshot.id, retryWaitToken), {
        status: 'retry_wait',
        nextRunAt: later(5),
        stages: retryStages,
        error: { code: 'STORE_FAILED', message: 'Private failure', retryable: true },
      });
      await firstStore.submit(makeJob(deckId));
      const normalizedRetry = await firstStore.get({ deckId, jobId: retryWait.snapshot.id });
      assert.equal(normalizedRetry.snapshot.status, 'superseded');
      assert.equal(normalizedRetry.snapshot.nextRunAt, undefined);
      assert.equal(normalizedRetry.snapshot.progress, undefined);
      assert.equal(normalizedRetry.snapshot.error, undefined);
      assert.equal(normalizedRetry.snapshot.stages[1].status, 'skipped');
      assert.equal(
        normalizedRetry.snapshot.stages[1].finishedAt,
        normalizedRetry.snapshot.finishedAt,
      );
    } finally {
      await clean(pool, [deckId]);
      await Promise.all([pool.end(), otherPool.end()]);
    }
  },
  {
    timeout: 30_000,
    skip: connectionString ? false : 'Set HUB_TEST_DATABASE_URL to run PostgreSQL job-store tests',
  },
);

databaseTest(
  'PostgreSQL claims use SKIP LOCKED, reclaim expired leases, and fence the previous worker',
  async () => {
    const poolA = new Pool({ connectionString, max: 4 });
    const poolB = new Pool({ connectionString, max: 4 });
    const suffix = randomUUID();
    const deckId = `jobs-claim-${suffix}`;
    try {
      await initializePostgresPublicationJobStore(poolA);
      const storeA = createPostgresPublicationJobStore({ pool: poolA });
      const storeB = createPostgresPublicationJobStore({ pool: poolB });
      const job = makeJob(deckId);
      job.snapshot.attempt = 3;
      job.snapshot.stages[0].attempt = 2;
      await storeA.submit(job);
      const claims = await Promise.all([
        storeA.claim({ now, leaseUntil: later(1), leaseToken: randomUUID(), deckId }),
        storeB.claim({ now, leaseUntil: later(1), leaseToken: randomUUID(), deckId }),
      ]);
      const successful = claims.filter(Boolean);
      assert.equal(successful.length, 1, 'two workers cannot claim the same queue row');
      const previous = successful[0];
      assert.equal(previous.snapshot.attempt, 3);
      assert.equal(previous.snapshot.stages[0].attempt, 2);
      const nextToken = randomUUID();
      const reclaimed = await storeB.claim({
        now: later(1),
        leaseUntil: later(3),
        leaseToken: nextToken,
        deckId,
      });
      assert.equal(reclaimed.snapshot.id, job.snapshot.id);
      assert.equal(reclaimed.leaseToken, nextToken);
      assert.equal(reclaimed.snapshot.attempt, 3);
      assert.equal(reclaimed.snapshot.stages[0].attempt, 2);
      assert.equal(reclaimed.snapshot.attempt, previous.snapshot.attempt);
      assert.deepEqual(reclaimed.snapshot.stages, previous.snapshot.stages);
      assert.equal(
        await storeA.checkpoint(lease(deckId, job.snapshot.id, previous.leaseToken, later(1)), {
          phase: 'compile',
        }),
        false,
      );
      assert.equal(
        await storeB.checkpoint(lease(deckId, job.snapshot.id, nextToken, later(1)), {
          phase: 'compile',
          leaseUntil: later(2),
        }),
        true,
      );
      assert.equal(
        await storeB.finish(lease(deckId, job.snapshot.id, nextToken, later(2)), {
          status: 'failed',
          stages: job.snapshot.stages,
        }),
        false,
        'leaseUntil must be greater than the supplied time',
      );
    } finally {
      await clean(poolA, [deckId]);
      await Promise.all([poolA.end(), poolB.end()]);
    }
  },
  {
    timeout: 30_000,
    skip: connectionString ? false : 'Set HUB_TEST_DATABASE_URL to run PostgreSQL job-store tests',
  },
);

databaseTest(
  'PostgreSQL retry rejection preserves generation, thumbnail retries keep their original revision, and cursors bind decks',
  async () => {
    const pool = new Pool({ connectionString, max: 6 });
    const otherPool = new Pool({ connectionString, max: 2 });
    const suffix = randomUUID();
    const deckId = `jobs-retry-${suffix}`;
    try {
      await initializePostgresPublicationJobStore(pool);
      const store = createPostgresPublicationJobStore({ pool });
      const other = createPostgresPublicationJobStore({ pool: otherPool });

      const quotaDeck = `${deckId}-quota`;
      const quotaParent = makeJob(quotaDeck);
      await store.submit(quotaParent);
      const quotaParentToken = randomUUID();
      await store.claim({
        now,
        leaseUntil: later(2),
        leaseToken: quotaParentToken,
        deckId: quotaDeck,
      });
      const quotaParentResult = jobResult(revision, 'skipped');
      assert.equal(
        await store.commitPublication(
          lease(quotaDeck, quotaParent.snapshot.id, quotaParentToken),
          { revision, entry: '/index.html' },
          quotaParentResult,
          quotaParent.snapshot.stages,
        ),
        'published',
      );
      assert.equal(
        await store.finish(lease(quotaDeck, quotaParent.snapshot.id, quotaParentToken), {
          status: 'partial',
          stages: quotaParent.snapshot.stages,
          result: quotaParentResult,
        }),
        true,
      );
      for (let index = 0; index < 9; index += 1) {
        const activeJob = makeJob(quotaDeck);
        assert.equal((await store.submit(activeJob)).outcome, 'accepted');
        const activeToken = randomUUID();
        await store.claim({
          now,
          leaseUntil: later(2),
          leaseToken: activeToken,
          deckId: quotaDeck,
        });
        const activeResult = jobResult(String(index).repeat(64), 'pending');
        assert.equal(
          await store.commitPublication(
            lease(quotaDeck, activeJob.snapshot.id, activeToken),
            { revision: activeResult.revision, entry: '/index.html' },
            activeResult,
            activeJob.snapshot.stages,
          ),
          'published',
        );
      }
      const failedParent = makeJob(quotaDeck, {
        inputKey: `private/jobs/retry-${suffix}.json`,
        inputHash: 'e'.repeat(64),
      });
      assert.equal((await store.submit(failedParent)).outcome, 'accepted');
      const failedParentToken = randomUUID();
      await store.claim({
        now,
        leaseUntil: later(2),
        leaseToken: failedParentToken,
        deckId: quotaDeck,
      });
      assert.equal(
        await store.finish(lease(quotaDeck, failedParent.snapshot.id, failedParentToken), {
          status: 'failed',
          stages: failedParent.snapshot.stages,
        }),
        true,
      );
      const olderThumbnail = makeJob(quotaDeck, {
        kind: 'thumbnail',
        parentJobId: quotaParent.snapshot.id,
        targetRevision: revision,
      });
      assert.equal(
        (
          await store.retry(
            { deckId: quotaDeck, jobId: quotaParent.snapshot.id },
            'thumbnail',
            olderThumbnail,
          )
        ).outcome,
        'accepted',
      );
      const activeCount = (
        await pool.query(
          `SELECT COUNT(*)::integer AS count FROM hub_publication_jobs
           WHERE deck_id = $1 AND status IN ('queued', 'running', 'retry_wait')`,
          [quotaDeck],
        )
      ).rows[0].count;
      assert.equal(
        activeCount,
        10,
        'all ten active jobs have published results and remain workers',
      );
      const generationBeforeRejectedRetry = (
        await pool.query('SELECT generation FROM hub_publications WHERE deck_id = $1', [quotaDeck])
      ).rows[0].generation;
      const quotaRetry = makeJob(quotaDeck, {
        parentJobId: failedParent.snapshot.id,
        inputKey: failedParent.inputKey,
        inputHash: failedParent.inputHash,
      });
      assert.equal(
        (
          await store.retry(
            { deckId: quotaDeck, jobId: failedParent.snapshot.id },
            'all',
            quotaRetry,
          )
        ).outcome,
        'limit',
      );
      const generationAfterRejectedRetry = (
        await pool.query('SELECT generation FROM hub_publications WHERE deck_id = $1', [quotaDeck])
      ).rows[0].generation;
      assert.equal(generationAfterRejectedRetry, generationBeforeRejectedRetry);

      const parent = makeJob(deckId, {
        inputKey: `private/jobs/${suffix}.json`,
        inputHash: 'f'.repeat(64),
      });
      await store.submit(parent);
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
      const accepted = await store.retry({ deckId, jobId: parent.snapshot.id }, 'all', child);
      assert.equal(accepted.outcome, 'accepted');
      assert.equal(accepted.job.generation, '2');
      const duplicate = makeJob(deckId, {
        parentJobId: parent.snapshot.id,
        inputKey: parent.inputKey,
        inputHash: parent.inputHash,
      });
      assert.equal(
        (await other.retry({ deckId, jobId: parent.snapshot.id }, 'all', duplicate)).outcome,
        'active_retry',
      );
      const afterReject = await store.submit(makeJob(deckId));
      assert.equal(
        afterReject.job.generation,
        '3',
        'ACTIVE_RETRY does not consume another generation',
      );

      const ids = [
        '00000000-0000-4000-8000-000000000009',
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-00000000000f',
      ];
      for (const id of ids) await store.submit(makeJob(`${deckId}-history`, { id }));
      const firstPage = await store.list({ deckId: `${deckId}-history`, limit: 2 });
      assert.equal(firstPage.items.length, 2);
      assert.deepEqual(
        firstPage.items.map((item) => item.snapshot.id),
        ids.slice(1).reverse(),
      );
      assert.ok(firstPage.nextCursor);
      const secondPage = await other.list({
        deckId: `${deckId}-history`,
        limit: 2,
        cursor: firstPage.nextCursor,
      });
      assert.equal(secondPage.items.length, 1);
      assert.equal(secondPage.items[0].snapshot.id, ids[0]);
      assert.notEqual(firstPage.items[0].snapshot.id, secondPage.items[0].snapshot.id);
      await assert.rejects(
        other.list({ deckId, limit: 2, cursor: firstPage.nextCursor }),
        /cursor/i,
      );

      const thumbDeck = `${deckId}-thumb`;
      const published = makeJob(thumbDeck);
      await store.submit(published);
      const publishToken = randomUUID();
      await store.claim({ now, leaseUntil: later(2), leaseToken: publishToken, deckId: thumbDeck });
      const skipped = jobResult(revision, 'skipped');
      assert.equal(
        await store.commitPublication(
          lease(thumbDeck, published.snapshot.id, publishToken),
          {
            revision,
            entry: '/index.html',
          },
          skipped,
          published.snapshot.stages,
        ),
        'published',
      );
      assert.equal(
        await store.finish(lease(thumbDeck, published.snapshot.id, publishToken), {
          status: 'partial',
          stages: published.snapshot.stages,
          result: skipped,
        }),
        true,
      );
      const childThumbnail = makeJob(thumbDeck, {
        kind: 'thumbnail',
        parentJobId: published.snapshot.id,
        targetRevision: revision,
        result: { ...skipped, thumbnail: 'pending' },
      });
      const thumb = await other.retry(
        { deckId: thumbDeck, jobId: published.snapshot.id },
        'thumbnail',
        childThumbnail,
      );
      assert.equal(thumb.outcome, 'accepted');
      assert.equal(thumb.job.targetRevision, revision);
      assert.deepEqual(thumb.job.snapshot.result, { ...skipped, thumbnail: 'pending' });
      assert.equal(thumb.job.generation, undefined);
    } finally {
      await clean(pool, [deckId, `${deckId}-history`, `${deckId}-thumb`, `${deckId}-quota`]);
      await Promise.all([pool.end(), otherPool.end()]);
    }
  },
  {
    timeout: 30_000,
    skip: connectionString ? false : 'Set HUB_TEST_DATABASE_URL to run PostgreSQL job-store tests',
  },
);

databaseTest(
  'PostgreSQL preserves an exact runtime ID and its absence across a fresh pool',
  async () => {
    const initialPool = new Pool({ connectionString, max: 3 });
    const suffix = randomUUID();
    const deckId = `jobs-runtime-${suffix}`;
    const exactRuntimeId = `runtime:${suffix}/native`;
    const withRuntimeJob = makeJob(deckId, { runtimeId: exactRuntimeId });
    const withoutRuntimeJob = makeJob(deckId, { runtimeId: null });
    let reopenedPool;
    try {
      await initializePostgresPublicationJobStore(initialPool);
      const store = createPostgresPublicationJobStore({ pool: initialPool });
      assert.equal((await store.submit(withRuntimeJob)).outcome, 'accepted');
      assert.equal((await store.submit(withoutRuntimeJob)).outcome, 'accepted');
    } finally {
      await initialPool.end();
    }

    reopenedPool = new Pool({ connectionString, max: 2 });
    try {
      await initializePostgresPublicationJobStore(reopenedPool);
      const reopened = createPostgresPublicationJobStore({ pool: reopenedPool });
      const withRuntime = await reopened.get({ deckId, jobId: withRuntimeJob.snapshot.id });
      const withoutRuntime = await reopened.get({ deckId, jobId: withoutRuntimeJob.snapshot.id });
      assert.equal(withRuntime.runtimeId, `runtime:${suffix}/native`);
      assert.equal(Object.hasOwn(withoutRuntime, 'runtimeId'), false);
    } finally {
      await clean(reopenedPool, [deckId]);
      await reopenedPool.end();
    }
  },
  {
    timeout: 30_000,
    skip: connectionString ? false : 'Set HUB_TEST_DATABASE_URL to run PostgreSQL job-store tests',
  },
);
