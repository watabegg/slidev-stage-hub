import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hubBin = path.join(packageRoot, 'dist/bin/hub.js');
const phases = ['runtime', 'compile', 'store', 'publish', 'thumbnail'];
const timestamp = '2026-10-10T00:00:00.000Z';
const parentJobId = '0fc53dd9-2715-4b7a-96ae-f4a43be26a6c';

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slidev-hub-jobs-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function run(args, cwd, stateHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hubBin, ...args], {
      cwd,
      env: { ...process.env, XDG_STATE_HOME: stateHome },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function jsonOutput(result) {
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
  return JSON.parse(result.stdout);
}

function capabilities(enabled = true) {
  return {
    schemaVersion: 1,
    publicationJobs: { enabled, pollAfterMs: 2000 },
    thumbnail: { available: true },
    limits: { requestBytes: 524288, maxSlides: 100 },
  };
}

function snapshot(id, deckId = 'course/topic', overrides = {}) {
  return {
    id,
    deckId,
    kind: 'publication',
    status: 'queued',
    phase: 'runtime',
    version: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    attempt: 0,
    stages: phases.map((phase) => ({ phase, status: 'pending', attempt: 0 })),
    ...overrides,
  };
}

function submitResponse(job, replayed = false) {
  const deckQuery = `deckId=${encodeURIComponent(job.deckId)}`;
  return {
    schemaVersion: 1,
    job,
    statusUrl: `/api/jobs/${job.id}?${deckQuery}`,
    viewPath: `/_hub/jobs?${deckQuery}&jobId=${job.id}`,
    replayed,
  };
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const source = Buffer.concat(chunks).toString('utf8');
  return source.length ? JSON.parse(source) : undefined;
}

async function writeHeadersFile(cwd, origin, headers) {
  const filePath = path.join(cwd, 'auth', 'headers.json');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ origin, headers }), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

test('hub init creates a profile without overwriting; doctor checks capabilities only', async () => {
  await withTempDir(async (cwd) => {
    const stateHome = path.join(cwd, 'state');
    let paths = [];
    await withServer(
      (request, response) => {
        paths.push(request.url);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(capabilities()));
      },
      async (origin) => {
        const init = await run(
          ['init', '--origin', origin, '--remote-config', 'remote/profile.json', '--json'],
          cwd,
          stateHome,
        );
        assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);
        assert.equal(jsonOutput(init).data.origin, origin);
        const profilePath = path.join(cwd, 'remote', 'profile.json');
        const profile = JSON.parse(await readFile(profilePath, 'utf8'));
        assert.deepEqual(profile, { schemaVersion: 1, origin });

        const overwrite = await run(
          ['init', '--origin', origin, '--remote-config', 'remote/profile.json', '--json'],
          cwd,
          stateHome,
        );
        assert.equal(overwrite.status, 2);
        assert.equal(jsonOutput(overwrite).error.code, 'REMOTE_CONFIG_EXISTS');

        const doctor = await run(
          ['doctor', '--remote-config', 'remote/profile.json', '--json'],
          cwd,
          stateHome,
        );
        assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
        const data = jsonOutput(doctor).data;
        assert.equal(data.ready, true);
        assert.equal(data.publicationJobsEnabled, true);
        assert.equal(data.liveWorkerHealthChecked, false);
        assert.deepEqual(paths, ['/api/capabilities']);
      },
    );
  });
});

test('publish --no-wait stores a private receipt before submit and keeps the token out of stdout', async () => {
  await withTempDir(async (cwd) => {
    const stateHome = path.join(cwd, 'state');
    const markdown = '# LOCAL_MARKDOWN_CANARY\n';
    const auth = 'Bearer JOB_PUBLISH_AUTH';
    await writeFile(path.join(cwd, 'slides.md'), markdown);
    let observed;
    await withServer(
      async (request, response) => {
        if (request.url === '/api/capabilities') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(capabilities()));
          return;
        }
        const body = await readRequest(request);
        observed = {
          method: request.method,
          url: request.url,
          auth: request.headers.authorization,
          body,
        };
        const receiptDir = path.join(stateHome, 'slidev-stage-hub', 'receipts');
        const receipts = await readdir(receiptDir);
        assert.equal(receipts.length, 1, 'receipt must be durable before the POST arrives');
        const receiptPath = path.join(receiptDir, receipts[0]);
        const receiptSource = await readFile(receiptPath, 'utf8');
        const receipt = JSON.parse(receiptSource);
        assert.equal(receipt.jobId, body.jobId);
        assert.equal(receipt.viewToken, body.viewToken);
        assert.equal(receiptSource.includes(markdown.trim()), false);
        assert.equal(receiptSource.includes(auth), false);
        if (process.platform !== 'win32') {
          assert.equal((await stat(receiptDir)).mode & 0o777, 0o700);
          assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
        }
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify(submitResponse(snapshot(body.jobId))));
      },
      async (origin) => {
        const headersPath = await writeHeadersFile(cwd, origin, { Authorization: auth });
        const result = await run(
          [
            'publish',
            '--origin',
            origin,
            '--id',
            'course/topic',
            '--source',
            'slides.md',
            '--headers-file',
            path.relative(cwd, headersPath),
            '--no-wait',
            '--json',
          ],
          cwd,
          stateHome,
        );
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const envelope = jsonOutput(result);
        assert.deepEqual(envelope, {
          ok: true,
          command: 'hub publish',
          data: {
            origin,
            jobId: observed.body.jobId,
            deckId: 'course/topic',
            status: 'queued',
            accepted: true,
            complete: false,
            replayed: false,
          },
        });
        assert.equal(observed.method, 'POST');
        assert.equal(observed.url, '/api/jobs');
        assert.equal(observed.auth, auth);
        assert.equal(observed.body.deckId, 'course/topic');
        assert.equal(observed.body.markdown, markdown);
        assert.equal(observed.body.thumbnail, 'auto');
        assert.match(
          observed.body.jobId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        assert.match(observed.body.viewToken, /^[A-Za-z0-9_-]{43}$/u);
        assert.equal(result.stdout.includes(observed.body.viewToken), false);
        assert.equal(result.stderr.trimEnd().endsWith(`#view=${observed.body.viewToken}`), true);
        assert.equal(`${result.stdout}${result.stderr}`.includes(markdown.trim()), false);
      },
    );
  });
});

test('jobs status and list use the authenticated remote profile and return one JSON envelope', async () => {
  await withTempDir(async (cwd) => {
    const stateHome = path.join(cwd, 'state');
    const auth = 'Bearer JOBS_READ_AUTH';
    const seen = [];
    await withServer(
      async (request, response) => {
        seen.push({ url: request.url, auth: request.headers.authorization });
        if (request.url === '/api/capabilities') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(capabilities()));
          return;
        }
        if (request.url === `/api/jobs/${parentJobId}?deckId=course%2Ftopic`) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ schemaVersion: 1, job: snapshot(parentJobId) }));
          return;
        }
        if (request.url === '/api/decks/course%2Ftopic/jobs?limit=8&cursor=next%2Fpage') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              items: [snapshot(parentJobId)],
              nextCursor: 'next page',
            }),
          );
          return;
        }
        response.writeHead(404);
        response.end();
      },
      async (origin) => {
        await writeHeadersFile(cwd, origin, { Authorization: auth });
        await writeFile(
          path.join(cwd, 'hub.remote.json'),
          JSON.stringify({
            schemaVersion: 1,
            origin,
            defaultDeckId: 'course/topic',
            headersFile: 'auth/headers.json',
          }),
        );
        const status = await run(
          ['jobs', 'status', '--job', parentJobId, '--json'],
          cwd,
          stateHome,
        );
        assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
        assert.equal(jsonOutput(status).data.status, 'queued');

        const list = await run(
          [
            'jobs',
            'list',
            '--id',
            'course/topic',
            '--limit',
            '8',
            '--cursor',
            'next/page',
            '--json',
          ],
          cwd,
          stateHome,
        );
        assert.equal(list.status, 0, `${list.stdout}\n${list.stderr}`);
        assert.equal(jsonOutput(list).data.items[0].id, parentJobId);
        assert.equal(jsonOutput(list).data.nextCursor, 'next page');
        assert.deepEqual(seen, [
          { url: `/api/jobs/${parentJobId}?deckId=course%2Ftopic`, auth },
          { url: '/api/decks/course%2Ftopic/jobs?limit=8&cursor=next%2Fpage', auth },
        ]);
      },
    );
  });
});

test('jobs retry creates a distinct private child receipt and posts the selected stage', async () => {
  await withTempDir(async (cwd) => {
    const stateHome = path.join(cwd, 'state');
    const auth = 'Bearer JOB_RETRY_AUTH';
    let submitted;
    await withServer(
      async (request, response) => {
        if (request.url === '/api/capabilities') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(capabilities()));
          return;
        }
        const body = await readRequest(request);
        submitted = { url: request.url, auth: request.headers.authorization, body };
        const receiptDir = path.join(stateHome, 'slidev-stage-hub', 'receipts');
        const receipts = await readdir(receiptDir);
        assert.equal(receipts.length, 1);
        const receipt = JSON.parse(await readFile(path.join(receiptDir, receipts[0]), 'utf8'));
        assert.equal(receipt.jobId, body.jobId);
        assert.equal(receipt.parentJobId, parentJobId);
        assert.equal(receipt.stage, 'thumbnail');
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            submitResponse(
              snapshot(body.jobId, 'course/topic', {
                kind: 'thumbnail',
                parentJobId,
              }),
            ),
          ),
        );
      },
      async (origin) => {
        await writeHeadersFile(cwd, origin, { Authorization: auth });
        const result = await run(
          [
            'jobs',
            'retry',
            '--origin',
            origin,
            '--headers-file',
            'auth/headers.json',
            '--id',
            'course/topic',
            '--job',
            parentJobId,
            '--stage',
            'thumbnail',
            '--no-wait',
            '--json',
          ],
          cwd,
          stateHome,
        );
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const envelope = jsonOutput(result);
        assert.equal(envelope.data.status, 'queued');
        assert.equal(envelope.data.complete, false);
        assert.equal(submitted.url, `/api/jobs/${parentJobId}/retry?deckId=course%2Ftopic`);
        assert.equal(submitted.auth, auth);
        assert.equal(submitted.body.stage, 'thumbnail');
        assert.notEqual(submitted.body.jobId, parentJobId);
        assert.match(submitted.body.viewToken, /^[A-Za-z0-9_-]{43}$/u);
      },
    );
  });
});

test('legacy fallback is limited to unsupported or disabled jobs; require-jobs and capability errors do not publish', async () => {
  await withTempDir(async (cwd) => {
    const stateHome = path.join(cwd, 'state');
    await writeFile(path.join(cwd, 'slides.md'), '# Legacy deck\n');
    let legacyPosts = 0;
    await withServer(
      async (request, response) => {
        if (request.url === '/api/capabilities') {
          response.writeHead(404);
          response.end();
          return;
        }
        legacyPosts += 1;
        assert.equal(request.method, 'POST');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'course/topic',
            revision: 'legacy-1',
            entry: '/course/topic/1?revision=legacy-1',
            published: true,
            cached: false,
            slides: [{ no: 1 }],
            warnings: [],
          }),
        );
      },
      async (origin) => {
        const required = await run(
          [
            'publish',
            '--origin',
            origin,
            '--id',
            'course/topic',
            '--source',
            'slides.md',
            '--require-jobs',
            '--json',
          ],
          cwd,
          stateHome,
        );
        assert.equal(required.status, 1);
        assert.equal(jsonOutput(required).error.code, 'JOBS_REQUIRED');
        assert.equal(legacyPosts, 0);

        const fallback = await run(
          [
            'publish',
            '--origin',
            origin,
            '--id',
            'course/topic',
            '--source',
            'slides.md',
            '--no-wait',
            '--json',
          ],
          cwd,
          stateHome,
        );
        assert.equal(fallback.status, 0, `${fallback.stdout}\n${fallback.stderr}`);
        assert.equal(jsonOutput(fallback).data.revision, 'legacy-1');
        assert.match(fallback.stderr, /synchronous publication/u);
        assert.match(fallback.stderr, /does not support durable jobs or automatic thumbnails/u);
        assert.equal(legacyPosts, 1);
      },
    );

    await withServer(
      async (_request, response) => {
        response.writeHead(503);
        response.end('do not fallback');
      },
      async (origin) => {
        const failure = await run(
          [
            'publish',
            '--origin',
            origin,
            '--id',
            'course/topic',
            '--source',
            'slides.md',
            '--json',
          ],
          cwd,
          stateHome,
        );
        assert.equal(failure.status, 1);
        assert.equal(jsonOutput(failure).error.code, 'PUBLISH_CAPABILITIES_FAILED');
        assert.equal(legacyPosts, 1);
      },
    );
  });
});
