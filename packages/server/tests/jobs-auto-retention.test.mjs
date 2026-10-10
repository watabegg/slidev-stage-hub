import assert from 'node:assert/strict';
import test from 'node:test';
import { runPublicationJobCleanup } from '../dist/index.js';

const jobId = '550e8400-e29b-41d4-a716-446655440000';
const now = Date.parse('2026-10-10T12:00:00.000Z');
function fixture({ failDelete = false, more = false, failCleanup = false } = {}) {
  const publications = {};
  const input = {
    deckId: 'demo/talk',
    jobId,
    inputKey: `private/jobs/demo/talk/${jobId}.json`,
    token: 'outbox-token',
  };
  let pending = [input];
  const calls = { claims: [], batches: [], deletes: [], finishes: [] };
  const lease = {
    deckId: input.deckId,
    leaseToken: 'lease-token',
    leaseUntil: new Date(now + 120000).toISOString(),
  };
  const maintenance = {
    automatic: {
      async claim(options) {
        calls.claims.push(options);
        return lease;
      },
      async finish(actual, options) {
        assert.equal(actual, lease);
        calls.finishes.push(options);
        return true;
      },
    },
    async cleanup(options) {
      calls.batches.push(options);
      if (failCleanup) throw new Error('database temporarily unavailable');
      return { jobs: [{ jobId, finishedAt: '2026-09-01T00:00:00.000Z' }], more };
    },
    async listPendingInputDeletes() {
      return { items: pending, pendingCount: pending.length };
    },
    async acknowledgeInputDelete(actual) {
      assert.equal(actual, input);
      pending = [];
      return true;
    },
  };
  const env = {
    publications,
    jobs: { publications, maintenance },
    artifacts: {
      async delete(key) {
        calls.deletes.push(key);
        if (failDelete) throw new Error('storage unavailable');
      },
    },
  };
  return { env, calls };
}

test('automatic cleanup uses one bounded 30-day batch and acknowledges completion separately from publication', async () => {
  const { env, calls } = fixture();
  assert.equal(await runPublicationJobCleanup(env, { now: () => now }), true);
  assert.equal(calls.claims.length, 1);
  assert.equal(calls.claims[0].leaseUntil, '2026-10-10T12:02:00.000Z');
  assert.deepEqual(calls.batches, [
    { deckId: 'demo/talk', cutoff: '2026-09-10T12:00:00.000Z', limit: 100, dryRun: false },
  ]);
  assert.deepEqual(calls.deletes, [`private/jobs/demo/talk/${jobId}.json`]);
  assert.deepEqual(calls.finishes, [{ now: '2026-10-10T12:00:00.000Z', retry: false }]);
});

for (const reason of ['failDelete', 'more', 'failCleanup']) {
  test(`automatic cleanup retains a daily continuation for ${reason}`, async () => {
    const { env, calls } = fixture({ [reason]: true });
    assert.equal(await runPublicationJobCleanup(env, { now: () => now }), true);
    assert.equal(calls.finishes[0].retry, true);
    assert.equal(calls.batches.length, 1);
  });
}

test('unsupported stores, missing deletion and shutdown never claim automatic work', async () => {
  const { env, calls } = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await runPublicationJobCleanup(env, { signal: controller.signal }), false);
  assert.equal(await runPublicationJobCleanup({ ...env, artifacts: {} }), false);
  assert.equal(await runPublicationJobCleanup({ ...env, publications: {} }), false);
  assert.equal(
    await runPublicationJobCleanup({
      ...env,
      jobs: { publications: env.publications, maintenance: {} },
    }),
    false,
  );
  assert.equal(calls.claims.length, 0);
});

test('shutdown arriving during claim leaves the persisted request retryable without deleting', async () => {
  const { env, calls } = fixture();
  const controller = new AbortController();
  const claim = env.jobs.maintenance.automatic.claim;
  env.jobs.maintenance.automatic.claim = async (options) => {
    const lease = await claim(options);
    controller.abort();
    return lease;
  };
  assert.equal(
    await runPublicationJobCleanup(env, { now: () => now, signal: controller.signal }),
    true,
  );
  assert.equal(calls.batches.length, 0);
  assert.equal(calls.finishes[0].retry, true);
});

test('automatic cleanup skips an idle deck without mutating history', async () => {
  const { env, calls } = fixture();
  env.jobs.maintenance.automatic.claim = async () => null;
  assert.equal(await runPublicationJobCleanup(env, { now: () => now }), false);
  assert.equal(calls.batches.length, 0);
  assert.equal(calls.finishes.length, 0);
});
