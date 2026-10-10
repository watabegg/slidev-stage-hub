import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { startPublicationJobWorker } from '../dist/job-worker.js';

test('worker bounds concurrency and shutdown drains accepted work without claiming more', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const releases = [];
  const worker = startPublicationJobWorker(
    { jobs: {} },
    {
      run: async (_options, { signal }) => {
        assert.equal(signal.aborted, false);
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => releases.push(resolve));
        active -= 1;
        return true;
      },
    },
  );
  assert.equal(calls, 2);
  let closed = false;
  const closing = worker.close().then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  releases.forEach((release) => release());
  await closing;
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(calls, 2);
  await worker.close();
});

test('worker recovers from a failed claim and can stop while waiting for work', async () => {
  let calls = 0;
  let failures = 0;
  let resumed;
  const completed = new Promise((resolve) => {
    resumed = resolve;
  });
  const worker = startPublicationJobWorker(
    { jobs: {} },
    {
      concurrency: 1,
      pollIntervalMs: 5,
      onError: () => {
        failures += 1;
      },
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('database unavailable');
        resumed();
        return false;
      },
    },
  );
  try {
    await completed;
    assert.equal(failures, 1);
    assert.equal(calls, 2);
  } finally {
    await worker.close();
  }
});

test('worker requires a job store and valid concurrency', () => {
  assert.throws(() => startPublicationJobWorker({}), /job store/);
  assert.throws(() => startPublicationJobWorker({ jobs: {} }, { concurrency: 0 }), /concurrency/);
});
