import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Pool } from 'pg';
import {
  createHubServer,
  runPublicationJob,
  runPublicationJobCleanup,
} from '@slidev-stage-hub/server';
import {
  createPostgresPublicationJobStore,
  initializePostgresPublicationJobStore,
} from '@slidev-stage-hub/state-postgres';
import { createFileArtifactStore } from '@slidev-stage-hub/adapter-node';
import { startPublicationJobWorker } from '../dist/job-worker.js';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
test(
  'a fresh worker publishes an update and automatically removes old history while preserving public artifacts',
  {
    skip: databaseUrl ? false : 'HUB_TEST_DATABASE_URL is required',
    timeout: 20000,
  },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const root = await mkdtemp(join(tmpdir(), 'hub-auto-retention-'));
    let worker;
    try {
      await initializePostgresPublicationJobStore(pool);
      const jobs = createPostgresPublicationJobStore({ pool });
      const artifacts = createFileArtifactStore({ root });
      const options = {
        artifacts,
        profile: { digest: 'profile-digest' },
        staticAssets: { fetch: async () => new Response('test document') },
        jobs,
        publications: jobs.publications,
        jobsEnabled: true,
        publishToken: 'publish-secret',
        allowLocalMutations: false,
      };
      const server = createHubServer(options);
      const deckId = `auto-retention-${randomUUID()}`;
      async function submit(jobId, markdown) {
        const res = await server.fetch(
          new Request('http://localhost/api/jobs', {
            method: 'POST',
            headers: { authorization: 'Bearer publish-secret', 'content-type': 'application/json' },
            body: JSON.stringify({
              deckId,
              jobId,
              markdown,
              viewToken: 'A'.repeat(43),
              thumbnail: 'none',
            }),
          }),
        );
        assert.equal(res.status, 202);
      }
      const oldId = randomUUID();
      await submit(oldId, '# Old slide');
      const compile = async (input) => ({
        title: input.markdown.slice(2),
        frontmatter: {},
        warnings: [],
        native: { clickTotals: [0] },
        slides: [{ no: 1, frontmatter: {}, code: 'export default {}', css: '' }],
      });
      await runPublicationJob(options, { compile, deckId });
      const oldRecord = await jobs.get({ deckId, jobId: oldId });
      assert.equal(oldRecord.snapshot.status, 'succeeded');
      await pool.query(
        "UPDATE hub_publication_jobs SET finished_at = CURRENT_TIMESTAMP - INTERVAL '31 days' WHERE deck_id = $1 AND job_id = $2",
        [deckId, oldId],
      );
      assert.ok(await artifacts.head(oldRecord.inputKey));
      const publishedKeys = (await artifacts.list({ prefix: 'releases/', limit: 100 })).keys;
      assert.ok(publishedKeys.length > 0);

      const nextId = randomUUID();
      await submit(nextId, '# Updated slide');
      // A new store instance has only PostgreSQL state, including the persisted cleanup request.
      const resumedJobs = createPostgresPublicationJobStore({ pool });
      const errors = [];
      worker = startPublicationJobWorker(
        { ...options, jobs: resumedJobs, publications: resumedJobs.publications },
        {
          concurrency: 1,
          pollIntervalMs: 5,
          run: (env, settings) => runPublicationJob(env, { ...settings, compile, deckId }),
          cleanup: (env, settings) => runPublicationJobCleanup(env, { ...settings, deckId }),
          onError: () => errors.push('worker error'),
        },
      );
      const deadline = Date.now() + 10000;
      let nextRecord;
      while (Date.now() < deadline) {
        nextRecord = await resumedJobs.get({ deckId, jobId: nextId });
        if (
          nextRecord?.snapshot.status === 'succeeded' &&
          !(await artifacts.head(oldRecord.inputKey))
        )
          break;
        await delay(10);
      }
      await worker.close();
      worker = undefined;
      assert.deepEqual(errors, []);
      assert.equal(nextRecord.snapshot.status, 'succeeded');
      assert.equal(await resumedJobs.get({ deckId, jobId: oldId }), null);
      assert.equal(await artifacts.head(oldRecord.inputKey), null);
      assert.equal(await resumedJobs.maintenance.isExpired({ deckId, jobId: oldId }), true);
      assert.ok(await artifacts.head(nextRecord.inputKey));
      for (const key of publishedKeys)
        assert.ok(await artifacts.head(key), `public artifact retained: ${key}`);
      assert.equal(
        (await resumedJobs.publications.current(deckId)).revision,
        nextRecord.snapshot.result.revision,
      );
    } finally {
      await worker?.close();
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
