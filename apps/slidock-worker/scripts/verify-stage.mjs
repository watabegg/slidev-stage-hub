#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectStage } from '@slidock/slive-tools';
import { startHarness } from './harness.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const stageRoot = join(repository, 'apps/slive');
const workerRoot = join(repository, 'apps/slidock-worker');
const stageBinary = join(stageRoot, 'target/debug/slive');
const hubCli = join(repository, 'packages/cli/dist/bin/hub.js');
const deckId = 'step7/native-stage';
const revisionPattern = /^[a-f0-9]{64}$/u;
const runId = `${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '-')}-${process.pid}`;
const evidenceDirectory = join(repository, 'artifacts/step7', runId);
const configPath = join(evidenceDirectory, 'local-config.json');
const notesDirectory = join(evidenceDirectory, 'remote-notes');
const sourceA = join(evidenceDirectory, 'deck-a.md');
const sourceB = join(evidenceDirectory, 'deck-b.md');
const assetsPath = join(evidenceDirectory, 'assets.json');
const emptyCwd = join(evidenceDirectory, 'empty-cwd');
const workerSite = join(workerRoot, 'artifacts/site');
const workerState = join(evidenceDirectory, 'worker-state');
const workerBundle = join(evidenceDirectory, 'worker.mjs');
const evidence = {
  schemaVersion: 1,
  runId,
  deckId,
  startedAt: new Date().toISOString(),
  status: 'running',
  checks: [],
};
let harness;
let controlServer;
let nativeProcess;
let nativeLog;
let publicationBFromCli;

function check(name, condition, details) {
  evidence.checks.push({
    name,
    pass: Boolean(condition),
    ...(details === undefined ? {} : { details }),
  });
  assert.ok(condition, name);
}

async function run(name, command, args, cwd = repository) {
  process.stdout.write(`Workers Stage verification: ${name}\n`);
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        CARGO_BUILD_JOBS: '2',
        NO_AT_BRIDGE: process.env.NO_AT_BRIDGE ?? '1',
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? accept() : reject(new Error(`${name} failed (${code})`)),
    );
  });
  evidence.checks.push({ name, pass: true, category: 'quality-gate' });
}

function runHubPublish(origin, sourcePath) {
  return new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        hubCli,
        'publish',
        '--origin',
        origin,
        '--id',
        deckId,
        '--source',
        sourcePath,
        '--assets',
        assetsPath,
        '--json',
      ],
      {
        cwd: repository,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`slidock publish failed (${code}): ${stderr.trim()}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout.trim());
        if (envelope.ok !== true || envelope.command !== 'slidock publish')
          throw new Error('slidock publish returned an invalid JSON envelope');
        const result = envelope.data;
        if (
          result?.id !== deckId ||
          typeof result.revision !== 'string' ||
          !revisionPattern.test(result.revision) ||
          result.entry !== `${origin}/${deckId}/1?revision=${result.revision}`
        )
          throw new Error('slidock publish returned an invalid pinned entry');
        accept(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function currentNativeDeck(origin) {
  const response = await fetch(`${origin}/native-player.json`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`native-player discovery returned HTTP ${response.status}`);
  const document = await response.json();
  if (document.schemaVersion !== 2 || document.protocolVersion !== 1)
    throw new Error('Worker did not expose native-player schema v2');
  const deck = document.decks.find((item) => item.id === deckId);
  if (!deck) throw new Error(`Worker discovery did not include ${deckId}`);
  return deck;
}

async function listen(server) {
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('QA control server did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

async function startPublishControl(origin) {
  let publishPromise;
  controlServer = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/publish-b') {
      response.writeHead(404).end();
      return;
    }
    publishPromise ??= runHubPublish(origin, sourceB).then((result) => {
      publicationBFromCli = result;
      return result;
    });
    void publishPromise.then(
      (result) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(result));
      },
      (error) => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: String(error) }));
      },
    );
  });
  return listen(controlServer);
}

function waitForNativeQa(child, phase, timeoutMs = 180_000) {
  return new Promise((accept, reject) => {
    let buffer = '';
    const prefix = 'VIEWER_READY presenter ';
    const timeout = setTimeout(() => finish(new Error(`${phase} native QA timed out`)), timeoutMs);
    const finish = (error, result) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('close', onClose);
      if (error) reject(error);
      else accept(result);
    };
    const onClose = (code, signal) =>
      finish(new Error(`${phase} native app exited before QA completed (${code ?? signal})`));
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith(prefix)) continue;
        try {
          const event = JSON.parse(line.slice(prefix.length));
          const qa = event.qa;
          if (typeof qa?.complete !== 'boolean') continue;
          if (qa.complete) finish(undefined, qa);
          else finish(new Error(`${phase} native QA failed: ${qa.error ?? 'assertion failed'}`));
          return;
        } catch {
          // Other VIEWER_READY messages contain bridge diagnostics and rendered reports.
        }
      }
    };
    child.stdout.on('data', onData);
    child.once('close', onClose);
  });
}

async function stopNative() {
  if (!nativeProcess) return;
  const child = nativeProcess;
  nativeProcess = undefined;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((accept) => child.once('close', accept)),
    new Promise((accept) => setTimeout(accept, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function runNativePhase(phase, controlUrl) {
  const logPath = join(evidenceDirectory, `stage-${phase}.log`);
  const stream = createWriteStream(logPath, { flags: 'w' });
  nativeLog = stream;
  const env = {
    ...process.env,
    NO_AT_BRIDGE: process.env.NO_AT_BRIDGE ?? '1',
    NATIVE_POC_QA: '1',
    NATIVE_POC_NOTES_DIR: notesDirectory,
    NATIVE_POC_QA_CONTROL_URL: controlUrl,
  };
  nativeProcess = spawn(stageBinary, ['--config', configPath], {
    cwd: emptyCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  nativeProcess.stdout.pipe(stream, { end: false });
  nativeProcess.stderr.pipe(stream, { end: false });
  const qa = await waitForNativeQa(nativeProcess, phase);
  await stopNative();
  await new Promise((accept) => stream.end(accept));
  nativeLog = undefined;
  check(
    `${phase} native QA assertions`,
    qa.assertions?.length > 0 && qa.assertions.every((item) => item.pass),
    {
      assertionCount: qa.assertions?.length ?? 0,
    },
  );
  evidence.checks.push({
    name: `${phase} native user workflow`,
    pass: true,
    category: 'browser-qa',
  });
  return qa;
}

async function writeEvidence() {
  evidence.completedAt = new Date().toISOString();
  const screenshots = (await readdir(evidenceDirectory))
    .filter((name) => name.endsWith('.png'))
    .sort();
  evidence.screenshots = screenshots.map((name) => join(evidenceDirectory, name));
  await writeFile(join(evidenceDirectory, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

try {
  if (process.platform !== 'linux' || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY))
    throw new Error('Native WebKit QA requires Linux DISPLAY or WAYLAND_DISPLAY');

  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(emptyCwd, { recursive: true });
  await mkdir(workerState, { recursive: true });
  const fixtureMarkdown = await readFile(join(workerRoot, 'fixtures/deck.md'), 'utf8');
  const assets = await readFile(join(workerRoot, 'fixtures/assets.json'), 'utf8');
  const markdownA = fixtureMarkdown
    .replace('# Workers compile PoC', '# STEP7_REVISION_A')
    .replace("const revision = 'immutable'", "const revision = 'STEP7_REVISION_A'");
  const markdownB = fixtureMarkdown
    .replace('# Workers compile PoC', '# STEP7_REVISION_B')
    .replace("const revision = 'immutable'", "const revision = 'STEP7_REVISION_B'");
  assert.notEqual(markdownA, markdownB);
  await Promise.all([
    writeFile(sourceA, markdownA),
    writeFile(sourceB, markdownB),
    writeFile(assetsPath, assets),
  ]);

  await run('Stage UI build', 'pnpm', ['--filter', '@slidock/slive', 'build:ui']);
  await run(
    'Tauri desktop build (serialized, low priority)',
    'bash',
    [
      '-c',
      'source "$1"; export CARGO_BUILD_JOBS=2; exec nice -n 10 cargo build --locked -p slive --features desktop',
      'workers-stage-build',
      join(stageRoot, 'scripts/desktop-env.sh'),
    ],
    stageRoot,
  );

  harness = await startHarness({
    site: workerSite,
    persist: true,
    statePath: workerState,
    workerPath: workerBundle,
  });
  evidence.workerOrigin = harness.origin;
  evidence.workerProfileDigest = harness.profileDigest;
  const publicationA = await runHubPublish(harness.origin, sourceA);
  check(
    'CLI publishes revision A to local Worker',
    publicationA.id === deckId && revisionPattern.test(publicationA.revision),
    publicationA,
  );
  const workerDeckA = await currentNativeDeck(harness.origin);
  check(
    'Worker discovery pins revision A in native-player v2',
    workerDeckA.revision === publicationA.revision &&
      workerDeckA.entry === `/${deckId}/1` &&
      workerDeckA.playback?.kind === 'revision-query' &&
      workerDeckA.playback.parameter === 'revision',
    workerDeckA,
  );

  const connectedA = await connectStage({ origin: harness.origin, configPath });
  check(
    'Stage Tools connects and stores revision A with the playback strategy',
    connectedA.config.decks.length === 1 &&
      connectedA.config.decks[0].revision === publicationA.revision &&
      connectedA.config.decks[0].playback?.kind === 'revision-query',
  );
  await writeFile(join(evidenceDirectory, 'stage-a-config.json'), await readFile(configPath));
  const controlUrl = await startPublishControl(harness.origin);
  evidence.qaControlUrl = controlUrl;

  const stageA = await runNativePhase('a', controlUrl);
  evidence.stageA = stageA;
  const publicationB = stageA.revisionPinning?.revisionB;
  check(
    'native QA published revision B while revision A remained active',
    typeof publicationB === 'string' &&
      revisionPattern.test(publicationB) &&
      publicationB !== publicationA.revision,
    stageA.revisionPinning,
  );
  const workerDeckB = await currentNativeDeck(harness.origin);
  check(
    'Worker discovery now selects revision B',
    workerDeckB.revision === publicationB && workerDeckB.id === deckId,
    workerDeckB,
  );
  check(
    'CLI B publication details match Worker discovery',
    publicationBFromCli?.id === deckId &&
      publicationBFromCli.revision === publicationB &&
      publicationBFromCli.entry === `${harness.origin}/${deckId}/1?revision=${publicationB}`,
    publicationBFromCli,
  );

  const connectedB = await connectStage({ origin: harness.origin, configPath });
  check(
    'Stage Tools reconnects the same origin and deck at revision B',
    connectedB.config.viewerOrigin === connectedA.config.viewerOrigin &&
      connectedB.config.decks.length === 1 &&
      connectedB.config.decks[0].id === connectedA.config.decks[0].id &&
      connectedB.config.decks[0].revision === publicationB,
  );
  await writeFile(join(evidenceDirectory, 'stage-b-config.json'), await readFile(configPath));

  const stageB = await runNativePhase('b', controlUrl);
  evidence.stageB = stageB;
  check(
    'reconnected native Stage keeps the sidecar note and shows its revision warning',
    stageB.notes?.persistedFromPreviousRun === true &&
      stageB.notes?.revisionWarning === true &&
      stageB.revisionPinning?.revisionB === publicationB,
    { notes: stageB.notes, revisionPinning: stageB.revisionPinning },
  );
  evidence.publications = {
    a: { ...publicationA, nativeEntry: workerDeckA.entry },
    b: { ...publicationBFromCli, nativeEntry: workerDeckB.entry },
  };
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await stopNative().catch(() => {});
  if (nativeLog) await new Promise((accept) => nativeLog.end(accept));
  if (controlServer) await new Promise((accept) => controlServer.close(accept));
  if (harness) await harness.mf.dispose();
  await mkdir(evidenceDirectory, { recursive: true });
  await writeEvidence();
  process.stdout.write(
    `${JSON.stringify({ status: evidence.status, evidence: join(evidenceDirectory, 'result.json') }, null, 2)}\n`,
  );
}

if (evidence.status !== 'passed') process.exitCode = 1;
