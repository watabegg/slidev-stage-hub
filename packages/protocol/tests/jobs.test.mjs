import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_PHASES,
  isJobSnapshot,
  isJobViewToken,
  isPublicationJobSubmitResponse,
  isPublicationJobListResponse,
  isPublicationJobsCapabilities,
} from '../dist/contracts/index.js';
const id = '550e8400-e29b-41d4-a716-446655440000';
const revision = 'a'.repeat(64);
function job() {
  return {
    id,
    deckId: 'demo/overview',
    kind: 'publication',
    status: 'queued',
    phase: 'runtime',
    version: 1,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    attempt: 0,
    stages: JOB_PHASES.map((phase) => ({ phase, status: 'pending', attempt: 0 })),
  };
}
test('public snapshot accepts omitted unknown progress and validates safe integer counters', () => {
  assert.equal(isJobSnapshot(job()), true);
  for (const field of ['version', 'attempt'])
    assert.equal(isJobSnapshot({ ...job(), [field]: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(
    isJobSnapshot({ ...job(), progress: { completed: 3, total: 8, unit: 'slides' } }),
    true,
  );
  assert.equal(
    isJobSnapshot({ ...job(), progress: { completed: 9, total: 8, unit: 'slides' } }),
    false,
  );
});
test('snapshots reject private fields, null optionals, and malformed phase/timestamp', () => {
  for (const invalid of [
    { source: 'private' },
    { viewTokenHash: 'private' },
    { generation: 'private' },
    { result: null },
    { phase: 'received' },
    { createdAt: 'yesterday' },
  ])
    assert.equal(isJobSnapshot({ ...job(), ...invalid }), false);
  assert.equal(
    isJobSnapshot({
      ...job(),
      stages: [
        { phase: 'runtime', status: 'pending', attempt: 0 },
        { phase: 'runtime', status: 'pending', attempt: 0 },
      ],
    }),
    false,
  );
});
test('published result links must target same deck and immutable revision', () => {
  const result = {
    revision,
    entry: `/demo/overview/1?revision=${revision}`,
    pages: 2,
    cached: false,
    thumbnail: 'pending',
  };
  assert.equal(isJobSnapshot({ ...job(), result }), true);
  for (const entry of [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    `/other/1?revision=${revision}`,
    `/demo/overview/1?revision=${'b'.repeat(64)}`,
  ])
    assert.equal(isJobSnapshot({ ...job(), result: { ...result, entry } }), false);
});
test('canonical 32-byte view capability rejects malformed encoding', () => {
  assert.equal(isJobViewToken('A'.repeat(43)), true);
  assert.equal(isJobViewToken('A'.repeat(42) + 'B'), false);
  assert.equal(isJobViewToken('A'.repeat(44)), false);
});
test('wire envelopes validate contained snapshots and configuration capability', () => {
  assert.equal(
    isPublicationJobSubmitResponse({
      schemaVersion: 1,
      job: job(),
      statusUrl: `/api/jobs/${id}?deckId=demo`,
      viewPath: `/_hub/jobs?deckId=demo&jobId=${id}`,
      replayed: false,
    }),
    true,
  );
  assert.equal(
    isPublicationJobListResponse({ schemaVersion: 1, items: [{ ...job(), status: 'invalid' }] }),
    false,
  );
  assert.equal(
    isPublicationJobsCapabilities({
      schemaVersion: 1,
      publicationJobs: { enabled: false, pollAfterMs: 2000 },
      thumbnail: { available: false },
      limits: { requestBytes: 524288, maxSlides: 100 },
    }),
    true,
  );
});
