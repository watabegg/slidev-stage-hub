import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-chromium';
import { createConfiguredHub } from '@slidock/server-app';
import { startHubServer } from '@slidock/adapter-node';

const output = resolve('artifacts/portability');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'hub-portable-'));
const checks = [];
const id = `portable/deck-${Date.now()}`;
const token = 'local-verification-only';
const env = {
  HUB_STATIC_DIR: resolve('apps/slidock-worker/artifacts/site'),
  HUB_STORAGE: 'filesystem',
  HUB_ARTIFACT_DIR: join(directory, 'objects'),
  HUB_PUBLICATIONS: process.env.HUB_TEST_DATABASE_URL ? 'postgres' : 'memory',
  HUB_DATABASE_URL: process.env.HUB_TEST_DATABASE_URL,
  HUB_DATABASE_INIT: 'true',
  HUB_PUBLISH_TOKEN: token,
};
let app, http, browser;
function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
}
async function start() {
  app = await createConfiguredHub(env);
  http = await startHubServer({ server: app.server, port: 0 });
}
async function stop() {
  await http?.close();
  await app?.close();
}
try {
  await start();
  const source = join(directory, 'slides.md');
  await writeFile(
    source,
    '---\nlayout: default\n---\n# Portable original\n\n<!-- private presenter note -->',
  );
  const headers = join(directory, 'headers.json');
  // CLI uses the same origin-bound private header format as Stage.
  await writeFile(
    headers,
    JSON.stringify({ origin: http.origin, headers: { Authorization: `Bearer ${token}` } }),
    { mode: 0o600 },
  );
  const cli = await promisify(execFile)(
    process.execPath,
    [
      resolve('packages/cli/dist/bin/hub.js'),
      'publish',
      '--origin',
      http.origin,
      '--id',
      id,
      '--source',
      source,
      '--headers-file',
      headers,
      '--json',
    ],
    { cwd: directory },
  );
  check(
    'CLI publishes through the portable HTTP endpoint from another cwd',
    cli.stdout.includes('revision'),
  );
  const firstResponse = await fetch(`${http.origin}/api/decks/${id}`);
  const first = await firstResponse.json();
  check(
    'publication has a revision',
    firstResponse.status === 200 && /^[a-f0-9]{64}$/.test(first.revision),
  );
  const documentResponse = await fetch(http.origin + first.entry);
  check(
    'Stage proxy can load a document without an HTML Accept header',
    documentResponse.ok && documentResponse.headers.get('content-type')?.includes('text/html'),
  );
  await documentResponse.body?.cancel();
  const moduleResponse = await fetch(http.origin + first.slides[0].module);
  const compiled = await moduleResponse.text();
  check(
    'public module strips presenter notes',
    moduleResponse.ok && !compiled.includes('private presenter note'),
  );
  check(
    'immutable release has HTTP metadata',
    moduleResponse.headers.get('cache-control')?.includes('immutable') &&
      moduleResponse.headers.has('etag'),
  );
  for (const path of ['/private/anything.json', '/api/not-an-endpoint', '/_runtime/missing.js']) {
    const response = await fetch(http.origin + path, { headers: { accept: 'text/html' } });
    check(`${path} never returns the SPA`, response.status === 404);
  }
  const unauthorized = await fetch(`${http.origin}/api/decks/${id}`, {
    method: 'POST',
    body: JSON.stringify({ markdown: '# Unauthorized' }),
  });
  check('publishing requires authentication', unauthorized.status === 401);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // Headless Chrome denies wake-lock requests; use Slidev's user setting for this rendering check.
  await page.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(http.origin + first.entry);
  await page
    .locator('.slidev-page h1')
    .filter({ hasText: 'Portable original' })
    .waitFor({ timeout: 20000 });
  check('shared browser runtime renders the Node publication', true);
  await page.screenshot({ path: join(output, 'node-slide.png') });
  const secondResponse = await fetch(`${http.origin}/api/decks/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: '---\nlayout: default\n---\n# Portable updated' }),
  });
  const second = await secondResponse.json();
  check(
    'new publication advances revision',
    secondResponse.ok && second.revision !== first.revision,
  );
  await page.reload();
  await page
    .locator('.slidev-page h1')
    .filter({ hasText: 'Portable original' })
    .waitFor({ timeout: 20000 });
  check('existing revision remains pinned across reload after publish', true);
  const discovery = await (await fetch(`${http.origin}/native-player.json`)).json();
  const native = discovery.decks.find((deck) => deck.id === id);
  check(
    'Stage discovery exposes latest revision and revision-query contract',
    native?.revision === second.revision && native.playback.parameter === 'revision',
  );
  await page.goto(http.origin);
  await page.getByText('Portable updated', { exact: true }).first().waitFor({ timeout: 20000 });
  check('shared Hub catalog renders published deck', true);
  assert.deepEqual(pageErrors, [], 'browser errors');
  check('browser has no uncaught errors', true);
  if (env.HUB_PUBLICATIONS === 'postgres') {
    await stop();
    await start();
    const restored = await (await fetch(`${http.origin}/api/decks/${id}`)).json();
    check(
      'application restart restores current publication from PostgreSQL',
      restored.revision === second.revision,
    );
    check(
      'application restart retains old immutable artifacts',
      (await fetch(http.origin + first.slides[0].module)).ok,
    );
  }
  await writeFile(
    join(output, 'server.json'),
    JSON.stringify(
      {
        status: 'passed',
        storage: 'local-filesystem',
        publications: env.HUB_PUBLICATIONS,
        checks,
        cloudDeployed: false,
        wakeLock: 'disabled via Slidev user setting in headless rendering check',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ status: 'passed', checks }));
} catch (error) {
  await writeFile(
    join(output, 'server.json'),
    JSON.stringify({ status: 'failed', checks, error: error.message }, null, 2) + '\n',
  );
  throw error;
} finally {
  await browser?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
}
