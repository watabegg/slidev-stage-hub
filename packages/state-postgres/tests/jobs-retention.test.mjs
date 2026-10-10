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
const cutoff = '2024-02-01T00:00:00.000Z';
const automaticAt = '2026-10-10T04:00:00.000Z';
const phases = ['runtime', 'compile', 'store', 'publish', 'thumbnail'];

const plusMs = (value, milliseconds) => new Date(Date.parse(value) + milliseconds).toISOString();

function makeJob(deckId, options = {}) {
  const jobId = options.jobId ?? randomUUID();
  const createdAt = options.createdAt ?? '2024-01-01T00:00:00.000Z';
  return {
    snapshot: {
      id: jobId,
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
    requestHash: `hash-${jobId}`,
    ...(options.inputKey
      ? {
          inputKey:
            options.inputKey === true ? `private/jobs/${deckId}/${jobId}.json` : options.inputKey,
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
  const leaseToken = randomUUID();
  const leaseUntil = new Date(Date.parse(finishedAt) + 60_000).toISOString();
  await store.claim({
    now: job.snapshot.createdAt,
    leaseUntil,
    leaseToken,
    deckId: job.snapshot.deckId,
  });
  assert.equal(
    await store.finish(
      { deckId: job.snapshot.deckId, jobId: job.snapshot.id, leaseToken, now: finishedAt },
      { status, stages: job.snapshot.stages },
    ),
    true,
  );
}

databaseTest(
  'PostgreSQL retention is per-deck, write-free in dry-run, and safely drains the outbox',
  async () => {
    const pool = new Pool({ connectionString, max: 4 });
    const suffix = randomUUID();
    const deckId = `jobs-retention-${suffix}`;
    const otherDeck = `jobs-retention-other-${suffix}`;
    const unknownDeck = `jobs-retention-unknown-${suffix}`;
    const protectedDeck = `jobs-retention-protected-${suffix}`;
    try {
      await initializePostgresPublicationJobStore(pool);
      const store = createPostgresPublicationJobStore({ pool });
      const unknown = await store.maintenance.cleanup({
        deckId: unknownDeck,
        cutoff,
        limit: 1,
        dryRun: true,
      });
      assert.deepEqual(unknown, { jobs: [], more: false });
      assert.equal(
        (await pool.query('SELECT 1 FROM hub_publications WHERE deck_id = $1', [unknownDeck]))
          .rowCount,
        0,
      );

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
      const isolated = makeJob(otherDeck);
      await store.submit(isolated);
      await finish(store, isolated, 'failed', cutoff);

      const preview = await store.maintenance.cleanup({ deckId, cutoff, limit: 1, dryRun: true });
      assert.deepEqual(preview.jobs, [{ jobId: child.snapshot.id, finishedAt: cutoff }]);
      assert.equal(preview.more, true);
      assert.ok(await store.get({ deckId, jobId: child.snapshot.id }));
      assert.equal(await store.maintenance.isExpired({ deckId, jobId: child.snapshot.id }), false);
      assert.equal(
        (await store.maintenance.listPendingInputDeletes({ deckId, limit: 1 })).pendingCount,
        0,
      );

      const first = await store.maintenance.cleanup({ deckId, cutoff, limit: 1, dryRun: false });
      assert.deepEqual(first.jobs, preview.jobs);
      assert.equal(first.more, true, 'removing the child exposes its eligible parent');
      assert.equal(await store.get({ deckId, jobId: child.snapshot.id }), null);
      assert.equal(await store.maintenance.isExpired({ deckId, jobId: child.snapshot.id }), true);
      assert.ok(await store.get({ deckId, jobId: parent.snapshot.id }));
      assert.ok(await store.get({ deckId, jobId: recent.snapshot.id }));
      assert.ok(await store.get({ deckId, jobId: active.snapshot.id }));
      assert.ok(await store.get({ deckId: otherDeck, jobId: isolated.snapshot.id }));

      const stale = (await store.maintenance.listPendingInputDeletes({ deckId, limit: 1 }))
        .items[0];
      assert.ok(stale);
      assert.equal((await store.submit(child)).outcome, 'expired');
      const refreshed = (await store.maintenance.listPendingInputDeletes({ deckId, limit: 1 }))
        .items[0];
      assert.notEqual(refreshed.token, stale.token);
      assert.equal(await store.maintenance.acknowledgeInputDelete(stale), false);

      const second = await store.maintenance.cleanup({ deckId, cutoff, limit: 1, dryRun: false });
      assert.deepEqual(second.jobs, [{ jobId: parent.snapshot.id, finishedAt: cutoff }]);
      assert.equal(second.more, false);
      assert.equal(
        (await store.maintenance.listPendingInputDeletes({ deckId, limit: 1 })).pendingCount,
        2,
      );
      assert.equal(await store.maintenance.acknowledgeInputDelete(refreshed), true);
      assert.equal(await store.maintenance.acknowledgeInputDelete(refreshed), false);

      const recentParent = makeJob(protectedDeck);
      await store.submit(recentParent);
      await finish(store, recentParent, 'failed', cutoff);
      const recentChild = makeJob(protectedDeck, {
        parentJobId: recentParent.snapshot.id,
        kind: 'thumbnail',
      });
      await store.submit(recentChild);
      await finish(store, recentChild, 'succeeded', '2024-02-01T00:00:00.001Z');
      const activeParent = makeJob(protectedDeck);
      await store.submit(activeParent);
      await finish(store, activeParent, 'failed', cutoff);
      const activeChild = makeJob(protectedDeck, {
        parentJobId: activeParent.snapshot.id,
        kind: 'thumbnail',
      });
      await store.submit(activeChild);
      const protectedResult = await store.maintenance.cleanup({
        deckId: protectedDeck,
        cutoff,
        limit: 100,
        dryRun: false,
      });
      assert.deepEqual(protectedResult.jobs, []);
      for (const job of [recentParent, recentChild, activeParent, activeChild]) {
        assert.ok(await store.get({ deckId: protectedDeck, jobId: job.snapshot.id }));
      }
      const sharedOld = makeJob(protectedDeck, { inputKey: true });
      await store.submit(sharedOld);
      await finish(store, sharedOld, 'failed', cutoff);
      const sharedRetained = makeJob(protectedDeck, { inputKey: sharedOld.inputKey });
      await store.submit(sharedRetained);
      const sharedCleanup = await store.maintenance.cleanup({
        deckId: protectedDeck,
        cutoff,
        limit: 100,
        dryRun: false,
      });
      assert.deepEqual(
        sharedCleanup.jobs.map((job) => job.jobId),
        [sharedOld.snapshot.id],
      );
      assert.equal(
        (await store.maintenance.listPendingInputDeletes({ deckId: protectedDeck, limit: 10 }))
          .pendingCount,
        0,
      );
      assert.ok(await store.get({ deckId: protectedDeck, jobId: sharedRetained.snapshot.id }));
    } finally {
      await pool.query(
        'DELETE FROM hub_publication_job_input_outbox WHERE deck_id = ANY($1::text[])',
        [[deckId, otherDeck, unknownDeck, protectedDeck]],
      );
      await pool.query('DELETE FROM hub_publication_job_cleanup WHERE deck_id = ANY($1::text[])', [
        [deckId, otherDeck, unknownDeck, protectedDeck],
      ]);
      await pool.query(
        'DELETE FROM hub_publication_job_tombstones WHERE deck_id = ANY($1::text[])',
        [[deckId, otherDeck, unknownDeck, protectedDeck]],
      );
      await pool.query('DELETE FROM hub_publication_jobs WHERE deck_id = ANY($1::text[])', [
        [deckId, otherDeck, unknownDeck, protectedDeck],
      ]);
      await pool.query('DELETE FROM hub_publications WHERE deck_id = ANY($1::text[])', [
        [deckId, otherDeck, unknownDeck, protectedDeck],
      ]);
      await pool.end();
    }
  },
);

databaseTest(
  'PostgreSQL automatic retention persists daily leases, retries, and in-lease requests',
  async () => {
    let pool = new Pool({ connectionString, max: 4 });
    let store;
    const suffix = randomUUID();
    const deckId = `jobs-auto-cleanup-${suffix}`;
    const legacyDeck = `jobs-auto-cleanup-legacy-${suffix}`;
    const token = () => randomUUID();
    try {
      await initializePostgresPublicationJobStore(pool);
      store = createPostgresPublicationJobStore({ pool });

      const legacy = makeJob(legacyDeck);
      await store.submit(legacy);
      await pool.query(
        `UPDATE hub_publication_jobs SET status = 'failed', finished_at = $3::timestamptz
         WHERE deck_id = $1 AND job_id = $2::uuid`,
        [legacyDeck, legacy.snapshot.id, automaticAt],
      );
      assert.equal(
        await store.maintenance.automatic.claim({
          now: automaticAt,
          leaseUntil: plusMs(automaticAt, 120_000),
          leaseToken: token(),
          deckId: legacyDeck,
        }),
        null,
        'schema initialization does not enqueue already completed jobs',
      );

      const first = makeJob(deckId);
      await store.submit(first);
      await finish(store, first, 'failed', automaticAt);
      assert.equal(
        (
          await pool.query('SELECT pending FROM hub_publication_job_cleanup WHERE deck_id = $1', [
            deckId,
          ])
        ).rows[0]?.pending,
        true,
      );

      await pool.end();
      pool = new Pool({ connectionString, max: 4 });
      await initializePostgresPublicationJobStore(pool);
      store = createPostgresPublicationJobStore({ pool });
      const secondPool = new Pool({ connectionString, max: 2 });
      const secondStore = createPostgresPublicationJobStore({ pool: secondPool });
      try {
        const claims = await Promise.all([
          store.maintenance.automatic.claim({
            now: automaticAt,
            leaseUntil: plusMs(automaticAt, 120_000),
            leaseToken: token(),
            deckId,
          }),
          secondStore.maintenance.automatic.claim({
            now: automaticAt,
            leaseUntil: plusMs(automaticAt, 120_000),
            leaseToken: token(),
            deckId,
          }),
        ]);
        assert.equal(claims.filter(Boolean).length, 1, 'SKIP LOCKED admits one deck lease');
        const activeLease = claims.find(Boolean);
        assert.ok(activeLease);

        const duringLease = makeJob(deckId);
        await store.submit(duringLease);
        await finish(store, duringLease, 'partial', plusMs(automaticAt, 60_000));
        assert.equal(
          await store.maintenance.automatic.claim({
            now: plusMs(automaticAt, 180_000),
            leaseUntil: plusMs(automaticAt, 300_000),
            leaseToken: token(),
            deckId,
          }),
          null,
          'a live scheduler lease prevents another batch',
        );
        assert.equal(
          await store.maintenance.automatic.finish(activeLease, {
            now: plusMs(automaticAt, 60_000),
            retry: false,
          }),
          true,
        );
        assert.equal(
          await store.maintenance.automatic.finish(activeLease, {
            now: plusMs(automaticAt, 60_000),
            retry: true,
          }),
          false,
          'completed scheduler leases are fenced',
        );

        const tooEarly = await store.maintenance.automatic.claim({
          now: plusMs(automaticAt, 24 * 60 * 60_000 - 1),
          leaseUntil: plusMs(automaticAt, 24 * 60 * 60_000 + 120_000),
          leaseToken: token(),
          deckId,
        });
        assert.equal(tooEarly, null, 'pending coalesced work stays behind the rolling 24h limit');
        const retry = await store.maintenance.automatic.claim({
          now: plusMs(automaticAt, 24 * 60 * 60_000),
          leaseUntil: plusMs(automaticAt, 24 * 60 * 60_000 + 120_000),
          leaseToken: token(),
          deckId,
        });
        assert.equal(retry?.deckId, deckId);
        assert.equal(
          await store.maintenance.automatic.finish(retry, {
            now: plusMs(automaticAt, 24 * 60 * 60_000 + 60_000),
            retry: true,
          }),
          true,
        );
        assert.equal(
          await store.maintenance.automatic.claim({
            now: plusMs(automaticAt, 48 * 60 * 60_000 - 1),
            leaseUntil: plusMs(automaticAt, 48 * 60 * 60_000 + 120_000),
            leaseToken: token(),
            deckId,
          }),
          null,
        );
        const nextRetry = await store.maintenance.automatic.claim({
          now: plusMs(automaticAt, 48 * 60 * 60_000),
          leaseUntil: plusMs(automaticAt, 48 * 60 * 60_000 + 120_000),
          leaseToken: token(),
          deckId,
        });
        assert.equal(nextRetry?.deckId, deckId);
        assert.equal(
          await store.maintenance.automatic.finish(nextRetry, {
            now: plusMs(automaticAt, 48 * 60 * 60_000 + 60_000),
            retry: false,
          }),
          true,
        );
        assert.equal(
          await store.maintenance.automatic.claim({
            now: plusMs(automaticAt, 5 * 24 * 60 * 60_000),
            leaseUntil: plusMs(automaticAt, 5 * 24 * 60 * 60_000 + 120_000),
            leaseToken: token(),
            deckId,
          }),
          null,
          'idle rows do not create a perpetual sweep',
        );
      } finally {
        await secondPool.end();
      }
    } finally {
      await pool.query('DELETE FROM hub_publication_job_cleanup WHERE deck_id = ANY($1::text[])', [
        [deckId, legacyDeck],
      ]);
      await pool.query('DELETE FROM hub_publication_jobs WHERE deck_id = ANY($1::text[])', [
        [deckId, legacyDeck],
      ]);
      await pool.query('DELETE FROM hub_publications WHERE deck_id = ANY($1::text[])', [
        [deckId, legacyDeck],
      ]);
      await pool.end();
    }
  },
  {
    timeout: 30_000,
    skip: connectionString ? false : 'Set HUB_TEST_DATABASE_URL to run PostgreSQL job-store tests',
  },
);

databaseTest(
  'expired input re-enqueue survives an idle and leased cleanup completion',
  async () => {
    const pool = new Pool({ connectionString, max: 3 });
    const deckId = `jobs-auto-outbox-${randomUUID()}`;
    const token = () => randomUUID();
    try {
      await initializePostgresPublicationJobStore(pool);
      const store = createPostgresPublicationJobStore({ pool });
      const job = makeJob(deckId, { inputKey: true });
      await store.submit(job);
      await finish(store, job, 'failed', cutoff);

      const firstBatch = await store.maintenance.automatic.claim({
        now: automaticAt,
        leaseUntil: plusMs(automaticAt, 120_000),
        leaseToken: token(),
        deckId,
      });
      assert.ok(firstBatch);
      const deleted = await store.maintenance.cleanup({
        deckId,
        cutoff,
        limit: 100,
        dryRun: false,
      });
      assert.deepEqual(deleted.jobs, [{ jobId: job.snapshot.id, finishedAt: cutoff }]);
      const firstInput = (await store.maintenance.listPendingInputDeletes({ deckId, limit: 10 }))
        .items[0];
      assert.ok(firstInput);
      assert.equal(await store.maintenance.acknowledgeInputDelete(firstInput), true);
      assert.equal(
        await store.maintenance.automatic.finish(firstBatch, {
          now: plusMs(automaticAt, 60_000),
          retry: false,
        }),
        true,
      );

      assert.equal((await store.submit(job)).outcome, 'expired');
      assert.equal(
        (
          await pool.query('SELECT pending FROM hub_publication_job_cleanup WHERE deck_id = $1', [
            deckId,
          ])
        ).rows[0]?.pending,
        true,
      );
      const nextDay = plusMs(automaticAt, 24 * 60 * 60_000);
      assert.equal(
        await store.maintenance.automatic.claim({
          now: plusMs(nextDay, -1),
          leaseUntil: plusMs(nextDay, 120_000),
          leaseToken: token(),
          deckId,
        }),
        null,
      );
      const idleWake = await store.maintenance.automatic.claim({
        now: nextDay,
        leaseUntil: plusMs(nextDay, 120_000),
        leaseToken: token(),
        deckId,
      });
      assert.ok(idleWake);

      const secondInput = (await store.maintenance.listPendingInputDeletes({ deckId, limit: 10 }))
        .items[0];
      assert.ok(secondInput);
      assert.equal(await store.maintenance.acknowledgeInputDelete(secondInput), true);
      assert.equal((await store.submit(job)).outcome, 'expired');
      assert.equal(
        await store.maintenance.automatic.finish(idleWake, {
          now: plusMs(nextDay, 60_000),
          retry: false,
        }),
        true,
      );
      const twoDays = plusMs(automaticAt, 48 * 60 * 60_000);
      assert.equal(
        await store.maintenance.automatic.claim({
          now: plusMs(twoDays, -1),
          leaseUntil: plusMs(twoDays, 120_000),
          leaseToken: token(),
          deckId,
        }),
        null,
      );
      assert.equal(
        (
          await store.maintenance.automatic.claim({
            now: twoDays,
            leaseUntil: plusMs(twoDays, 120_000),
            leaseToken: token(),
            deckId,
          })
        )?.deckId,
        deckId,
        're-enqueue during finish(retry=false) remains pending until the next day',
      );
    } finally {
      await pool.query('DELETE FROM hub_publication_job_input_outbox WHERE deck_id = $1', [deckId]);
      await pool.query('DELETE FROM hub_publication_job_cleanup WHERE deck_id = $1', [deckId]);
      await pool.query('DELETE FROM hub_publication_job_tombstones WHERE deck_id = $1', [deckId]);
      await pool.query('DELETE FROM hub_publication_jobs WHERE deck_id = $1', [deckId]);
      await pool.query('DELETE FROM hub_publications WHERE deck_id = $1', [deckId]);
      await pool.end();
    }
  },
  {
    timeout: 30_000,
    skip: connectionString ? false : 'Set HUB_TEST_DATABASE_URL to run PostgreSQL job-store tests',
  },
);
