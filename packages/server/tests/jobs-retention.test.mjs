import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createHubServer } from '../dist/index.js';
import { jobOptions } from './jobs-support.mjs';

const token = 'A'.repeat(43);
const jobId = '550e8400-e29b-41d4-a716-000000000000';
const cutoff = '2024-01-01T00:00:00.000Z';

function maintenanceFor(fixture) {
  const tombstones = new Set();
  const outbox = new Map();
  const key = (deckId, jobId) => `${deckId}/${jobId}`;
  const recordKey = (deckId, jobId) => JSON.stringify([deckId, jobId]);
  const eligible = (deckId, at, excluded = new Set()) =>
    [...fixture.records.values()]
      .filter((record) => {
        const snapshot = record.snapshot;
        return (
          snapshot.deckId === deckId &&
          !excluded.has(snapshot.id) &&
          ['succeeded', 'partial', 'failed', 'superseded'].includes(snapshot.status) &&
          snapshot.finishedAt <= at &&
          ![...fixture.records.values()].some(
            (child) =>
              child.snapshot.deckId === deckId &&
              child.snapshot.parentJobId === snapshot.id &&
              !excluded.has(child.snapshot.id),
          )
        );
      })
      .sort((a, b) => a.snapshot.finishedAt.localeCompare(b.snapshot.finishedAt));
  function enqueue(record) {
    if (!record.inputKey) return;
    if (
      [...fixture.records.values()].some(
        (other) =>
          other.inputKey === record.inputKey && other.snapshot.deckId === record.snapshot.deckId,
      )
    )
      return;
    outbox.set(record.inputKey, {
      deckId: record.snapshot.deckId,
      jobId: record.snapshot.id,
      inputKey: record.inputKey,
      token: randomUUID(),
    });
  }
  return {
    tombstones,
    outbox,
    store: {
      async isExpired(identity) {
        return tombstones.has(key(identity.deckId, identity.jobId));
      },
      async cleanup(options) {
        const candidates = eligible(options.deckId, options.cutoff);
        const selected = candidates.slice(0, options.limit);
        if (!options.dryRun) {
          for (const record of selected) {
            fixture.records.delete(recordKey(record.snapshot.deckId, record.snapshot.id));
            tombstones.add(key(record.snapshot.deckId, record.snapshot.id));
            enqueue(record);
          }
        }
        const excluded = options.dryRun
          ? new Set(selected.map((record) => record.snapshot.id))
          : new Set();
        return {
          jobs: selected.map((record) => ({
            jobId: record.snapshot.id,
            finishedAt: record.snapshot.finishedAt,
          })),
          more: eligible(options.deckId, options.cutoff, excluded).length > 0,
        };
      },
      async listPendingInputDeletes({ deckId, limit }) {
        const items = [...outbox.values()].filter((item) => item.deckId === deckId);
        return { items: structuredClone(items.slice(0, limit)), pendingCount: items.length };
      },
      async acknowledgeInputDelete(item) {
        const pending = outbox.get(item.inputKey);
        if (pending?.token !== item.token) return false;
        outbox.delete(item.inputKey);
        return true;
      },
    },
  };
}

function cleanupRequest(body, headers = {}) {
  return new Request('http://localhost:4180/api/jobs/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function preparedFixture() {
  const fixture = jobOptions();
  const server = createHubServer(fixture.options);
  const admitted = await server.fetch(
    new Request('http://localhost:4180/api/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer publish-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        deckId: 'demo/overview',
        markdown: '# Hello',
        viewToken: token,
        thumbnail: 'none',
      }),
    }),
  );
  assert.equal(admitted.status, 202);
  const record = fixture.records.get(JSON.stringify(['demo/overview', jobId]));
  record.snapshot.status = 'failed';
  record.snapshot.finishedAt = cutoff;
  record.snapshot.updatedAt = cutoff;
  const maintenance = maintenanceFor(fixture);
  fixture.options.jobs.maintenance = maintenance.store;
  fixture.options.jobsEnabled = false;
  fixture.options.allowLocalMutations = false;
  const deletes = [];
  fixture.options.artifacts.delete = async (key) => {
    deletes.push(key);
    if (fixture.failDelete) throw new Error('private deletion error');
    fixture.values.delete(key);
  };
  return { fixture, server, maintenance, record, deletes };
}

test('cleanup is authorized, dry-run is read-only, and apply leaves failed deletes retryable', async () => {
  const { fixture, server, maintenance, deletes } = await preparedFixture();
  const body = { deckId: 'demo/overview', limit: 1 };
  const noAuth = await server.fetch(cleanupRequest(body));
  assert.equal(noAuth.status, 401);
  assert.equal((await server.fetch(cleanupRequest(body, { 'X-Hub-Job-View': token }))).status, 401);

  const preview = await server.fetch(
    cleanupRequest(body, { authorization: 'Bearer publish-secret' }),
  );
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.dryRun, true);
  assert.deepEqual(previewBody.jobs, [{ jobId, finishedAt: cutoff }]);
  assert.equal(previewBody.deletedJobs, 0);
  assert.equal(previewBody.deletedInputs, 0);
  assert.equal(previewBody.pendingInputs, 0);
  assert.equal(previewBody.more, false);
  assert.equal(fixture.records.has(JSON.stringify(['demo/overview', jobId])), true);
  assert.equal(maintenance.tombstones.size, 0);
  assert.equal(maintenance.outbox.size, 0);
  assert.equal(deletes.length, 0);

  fixture.failDelete = true;
  const failedDelete = await server.fetch(
    cleanupRequest({ ...body, apply: true }, { authorization: 'Bearer publish-secret' }),
  );
  assert.equal(failedDelete.status, 200);
  const pending = await failedDelete.json();
  assert.equal(pending.deletedJobs, 1);
  assert.equal(pending.deletedInputs, 0);
  assert.equal(pending.pendingInputs, 1);
  assert.equal(pending.more, true);
  assert.equal(fixture.records.has(JSON.stringify(['demo/overview', jobId])), false);
  assert.equal(maintenance.tombstones.has(`demo/overview/${jobId}`), true);
  assert.equal(maintenance.outbox.size, 1);

  fixture.failDelete = false;
  const retry = await server.fetch(
    cleanupRequest({ ...body, apply: true }, { authorization: 'Bearer publish-secret' }),
  );
  assert.equal(retry.status, 200);
  const retried = await retry.json();
  assert.equal(retried.deletedJobs, 0);
  assert.equal(retried.deletedInputs, 1);
  assert.equal(retried.pendingInputs, 0);
  assert.equal(retried.more, false);
  assert.ok(deletes.every((key) => key === `private/jobs/demo/overview/${jobId}.json`));
  assert.equal(JSON.stringify(retried).includes('private/jobs/'), false);
});

test('cleanup checks capabilities before mutation and read accepts scoped token beside stale auth', async () => {
  const { fixture, server, maintenance, record } = await preparedFixture();
  const removeDelete = fixture.options.artifacts.delete;
  delete fixture.options.artifacts.delete;
  const unavailable = await server.fetch(
    cleanupRequest(
      { deckId: 'demo/overview', apply: true },
      { authorization: 'Bearer publish-secret' },
    ),
  );
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, 'JOB_CLEANUP_UNAVAILABLE');
  assert.equal(fixture.records.has(JSON.stringify(['demo/overview', jobId])), true);
  assert.equal(maintenance.tombstones.size, 0);
  fixture.options.artifacts.delete = removeDelete;

  const read = await server.fetch(
    new Request(`http://localhost:4180/api/jobs/${jobId}?deckId=demo%2Foverview`, {
      headers: { 'X-Hub-Job-View': token, authorization: 'Bearer stale-publish-token' },
    }),
  );
  assert.equal(read.status, 200);
  assert.equal((await read.json()).job.id, record.snapshot.id);
  const disabledAdmission = await server.fetch(
    cleanupRequest({ deckId: 'demo/overview' }, { authorization: 'Bearer publish-secret' }),
  );
  assert.equal(
    disabledAdmission.status,
    200,
    'manual maintenance remains available while admission is disabled',
  );
});

test('cleanup refuses malformed private-input keys before calling artifact deletion', async () => {
  const { fixture, server, maintenance, deletes } = await preparedFixture();
  const record = fixture.records.get(JSON.stringify(['demo/overview', jobId]));
  record.snapshot.status = 'queued';
  delete record.snapshot.finishedAt;
  const malformed = {
    deckId: 'demo/overview',
    jobId,
    inputKey: 'private/jobs/other-deck/not-a-job.json',
    token: randomUUID(),
  };
  maintenance.outbox.set(malformed.inputKey, malformed);

  const response = await server.fetch(
    cleanupRequest(
      { deckId: 'demo/overview', apply: true },
      { authorization: 'Bearer publish-secret' },
    ),
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.deletedInputs, 0);
  assert.equal(result.pendingInputs, 1);
  assert.equal(result.more, true);
  assert.deepEqual(deletes, []);
  assert.equal(maintenance.outbox.has(malformed.inputKey), true);
});
