import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-chromium';
import { createConfiguredHub } from '@slidock/server-app';
import { startHubServer } from '@slidock/adapter-node';
import { startHarness } from './harness.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);
const output = resolve(
  root,
  'artifacts/runtime-pinning',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(output, { recursive: true });
const checks = [];
const failures = [];
const siteA = join(output, 'runtime-a');
const siteB = join(output, 'runtime-b');
const builtSite = resolve(root, 'apps/slidock-worker/artifacts/site');
const builder = resolve(root, 'apps/slidock-worker/scripts/build-runtime.mjs');
const id = `runtime/deck-${Date.now()}`;
const markdown =
  '---\nlayout: default\n---\n# Pinned runtime\n\n<div v-click>Still works after an upgrade</div>';
const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log('PASS', label);
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let browser;
let active;
const stop = async () => {
  await active?.close();
  active = undefined;
};

async function buildRuntime(theme, destination, label) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('SLIDEV_')) delete env[key];
  if (theme) env.SLIDEV_THEME_PATH = theme;
  const result = await run(process.execPath, [builder], {
    cwd: root,
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  await writeFile(join(output, `build-${label}.log`), result.stdout + result.stderr);
  await cp(builtSite, destination, { recursive: true });
  return JSON.parse(await readFile(join(destination, 'runtime-manifest.json'), 'utf8'));
}
async function publish(origin) {
  const response = await fetch(`${origin}/api/decks/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function render(origin, manifest, label, entry = manifest.entry) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => localStorage.setItem('slidev-wake-lock', 'false'));
  const page = await context.newPage();
  const errors = [];
  const runtimeRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`);
  });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (['script', 'stylesheet', 'font'].includes(request.resourceType()))
      runtimeRequests.push(path);
  });
  try {
    await page.goto(origin + entry);
    await page
      .locator('.slidev-page h1')
      .filter({ hasText: 'Pinned runtime' })
      .waitFor({ timeout: 25000 });
    await page.waitForFunction(
      (revision) => window.__workersPoc?.revision === revision,
      manifest.revision,
    );
    check(
      `${label}: page selects the expected revision`,
      new URL(page.url()).searchParams.get('revision') === manifest.revision,
    );
    assert.deepEqual(errors, []);
    const immutableRuntimePaths = runtimeRequests.filter((path) => path.startsWith('/runtimes/'));
    check(
      `${label}: browser downloads the pinned runtime`,
      immutableRuntimePaths.length > 0 &&
        immutableRuntimePaths.every((path) => path.startsWith(`/runtimes/${manifest.runtimeId}/`)),
    );
    check(
      `${label}: browser never mixes mutable runtime assets`,
      runtimeRequests.every(
        (path) => !path.startsWith('/_runtime/') && !path.startsWith('/assets/'),
      ),
    );
    await page.keyboard.press('ArrowRight');
    await page
      .getByText('Still works after an upgrade', { exact: true })
      .waitFor({ state: 'visible' });
    await page.screenshot({ path: join(output, `${label}.png`) });
    assert.deepEqual(errors, [], `${label}: no browser errors`);
    return { runtimeRequests, revision: manifest.revision, runtimeId: manifest.runtimeId, errors };
  } finally {
    await context.close();
  }
}
async function probe(provider, start, a, b) {
  const aCopy = join(output, `${provider}-a-static`);
  await cp(siteA, aCopy, { recursive: true });
  active = await start(aCopy);
  const first = await publish(active.origin);
  check(`${provider}: first publication pins runtime A`, first.runtimeId === a.runtime.id);
  const sourcePath = `runtimes/${a.runtime.id}/_runtime/vue.js`;
  const firstBytes = new Uint8Array(
    await (await fetch(`${active.origin}/${sourcePath}`)).arrayBuffer(),
  );
  await render(active.origin, first, `${provider}-a-before`);
  await stop();
  await rm(aCopy, { recursive: true, force: true });
  active = await start(siteB);
  const second = await publish(active.origin);
  check(
    `${provider}: identical source with runtime B creates a new revision`,
    second.runtimeId === b.runtime.id && first.revision !== second.revision,
  );
  await stop();
  active = await start(siteB);
  const current = await (await fetch(`${active.origin}/api/decks/${id}`)).json();
  check(
    `${provider}: restarted application restores runtime B publication`,
    current.revision === second.revision && current.runtimeId === b.runtime.id,
  );
  const oldBytes = new Uint8Array(
    await (await fetch(`${active.origin}/${sourcePath}`)).arrayBuffer(),
  );
  check(
    `${provider}: runtime A bytes survive static replacement and restart`,
    hash(oldBytes) === hash(firstBytes),
  );
  const observations = [
    await render(active.origin, first, `${provider}-a-after`),
    await render(active.origin, second, `${provider}-b-after`, `/${id}/1`),
  ];
  const head = await fetch(active.origin + first.entry, { method: 'HEAD' });
  check(
    `${provider}: pinned document works for headerless Stage requests`,
    head.ok && head.headers.get('content-type')?.includes('text/html'),
  );
  await stop();
  return { first, second, observations };
}
try {
  if (!process.env.HUB_TEST_DATABASE_URL)
    throw new Error('HUB_TEST_DATABASE_URL must point to a disposable local PostgreSQL database');
  const a = await buildRuntime(undefined, siteA, 'a');
  const theme = dirname(fileURLToPath(import.meta.resolve('slidev-theme-watabegg/package.json')));
  const b = await buildRuntime(theme, siteB, 'b');
  check('distinct built themes produce distinct runtime IDs', a.runtime.id !== b.runtime.id);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
  });
  const node = await probe(
    'node',
    async (site) => {
      const app = await createConfiguredHub({
        HUB_STATIC_DIR: site,
        HUB_STORAGE: 'filesystem',
        HUB_ARTIFACT_DIR: join(output, 'node-objects'),
        HUB_PUBLICATIONS: 'postgres',
        HUB_DATABASE_URL: process.env.HUB_TEST_DATABASE_URL,
        HUB_DATABASE_INIT: 'true',
        HUB_ALLOW_LOCAL_MUTATIONS: 'true',
      });
      const http = await startHubServer({ server: app.server, port: 0 });
      return {
        origin: http.origin,
        close: async () => {
          await http.close();
          await app.close();
        },
      };
    },
    a,
    b,
  );
  const cloudflare = await probe(
    'workerd',
    async (site) => {
      const { mf, origin } = await startHarness({
        site,
        persist: true,
        statePath: join(output, 'cf-state'),
        workerPath: join(output, 'worker.mjs'),
      });
      return { origin, close: () => mf.dispose() };
    },
    a,
    b,
  );
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ status: 'passed', checks, node, cloudflare, cloudDeployed: false }, null, 2) +
      '\n',
  );
  console.log(JSON.stringify({ status: 'passed', output, checks: checks.length }));
} catch (error) {
  failures.push(error.message);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ status: 'failed', checks, failures, cloudDeployed: false }, null, 2) + '\n',
  );
  throw error;
} finally {
  await browser?.close();
  await stop();
  // Keep the normal development runtime on the default theme after the two-build test.
  if (
    await readFile(join(siteA, 'runtime-manifest.json')).then(
      () => true,
      () => false,
    )
  ) {
    await rm(builtSite, { recursive: true, force: true });
    await cp(siteA, builtSite, { recursive: true });
  }
}
