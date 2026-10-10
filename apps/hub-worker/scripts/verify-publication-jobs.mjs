import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredHub } from '@slidev-stage-hub/server-app';
import { startHubServer } from '@slidev-stage-hub/adapter-node';
import { chromium } from 'playwright-chromium';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(scriptsDirectory, '..');
const appDirectory = resolve(workerDirectory, '..');
const repositoryRoot = resolve(appDirectory, '..');
const fixtureDirectory = join(workerDirectory, 'tests', 'fixtures', 'jobs');
const staticRoot = join(workerDirectory, 'artifacts', 'site');
const workerEntry = join(repositoryRoot, 'apps', 'hub-server', 'dist', 'worker.js');
const cliEntry = join(repositoryRoot, 'packages', 'cli', 'dist', 'bin', 'hub.js');
const runId =
  new Date().toISOString().replaceAll(/[:.]/gu, '-') + '-' + randomBytes(4).toString('hex');
const runDirectory = join(workerDirectory, 'artifacts', 'publication-jobs', runId);
const receiptStateDirectory = join(runDirectory, 'cli-state');
const artifactDirectory = join(runDirectory, 'objects');
const screenshotDirectory = join(runDirectory, 'screenshots');
const chromiumExecutable = chromium.executablePath();
const results = [];
const screenshots = [];
const secrets = new Set();
let activeCase = 'preflight';
let appInstance;
let workerProcess;
let browser;
let origin;
let publishToken;
let externalBrowserRequestsAttempted = 0;
let externalBrowserRequestsBlocked = 0;
let externalBrowserResponsesReceived = 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  check(actual === expected, message);
}

function recordPass(name) {
  results.push({ name, status: 'passed' });
  console.log('PASS ' + name);
}

async function scenario(name, operation) {
  activeCase = name;
  try {
    const value = await operation();
    recordPass(name);
    return value;
  } catch (error) {
    results.push({ name, status: 'failed', error: sanitizedMessage(error) });
    throw error;
  }
}

function sanitizedMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
  return message
    .replaceAll(/postgres(?:ql)?:\/\/[^\s"']+/giu, '[redacted database URL]')
    .replaceAll(/https?:\/\/127\.0\.0\.1:\d+/gu, '[local origin]');
}

function uuid() {
  return randomUUID();
}

function viewToken() {
  const value = randomBytes(32).toString('base64url');
  secrets.add(value);
  return value;
}

function deckId(label) {
  return 'jobs-e2e-' + runId.replaceAll(/[^A-Za-z0-9_-]/gu, '-') + '-' + label;
}

function fixture(name) {
  return join(fixtureDirectory, name);
}

async function loadInjectedSnapshot(name, jobId, id) {
  const snapshot = JSON.parse(await readFile(fixture(name), 'utf8'));
  check(
    snapshot.schemaVersion === 1 && snapshot.job,
    'synthetic job fixture has an invalid envelope',
  );
  const now = Date.now();
  snapshot.job.id = jobId;
  snapshot.job.deckId = id;
  snapshot.job.createdAt = new Date(now - 60_000).toISOString();
  snapshot.job.updatedAt = new Date(now).toISOString();
  if (snapshot.job.startedAt !== undefined)
    snapshot.job.startedAt = new Date(now - 30_000).toISOString();
  if (snapshot.job.finishedAt !== undefined) snapshot.job.finishedAt = new Date(now).toISOString();
  if (snapshot.job.nextRunAt !== undefined)
    snapshot.job.nextRunAt = new Date(now + 5 * 60_000).toISOString();
  if (snapshot.job.result)
    snapshot.job.result.entry = `/${id}/1?revision=${snapshot.job.result.revision}`;
  return snapshot;
}

function isTerminal(status) {
  return ['succeeded', 'partial', 'failed', 'superseded'].includes(status);
}

async function responseJson(response, label) {
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(label + ' did not return JSON');
  }
  check(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    label + ' returned an invalid JSON object',
  );
  return value;
}

function statusEndpoint(jobId, id) {
  const query = new URLSearchParams({ deckId: id });
  return new URL('/api/jobs/' + encodeURIComponent(jobId) + '?' + query, origin);
}

function publishHeaders() {
  return { authorization: 'Bearer ' + publishToken };
}

async function submitJob({
  id,
  jobId = uuid(),
  token = viewToken(),
  markdown,
  thumbnail = 'auto',
}) {
  const body = { jobId, deckId: id, markdown, thumbnail, viewToken: token };
  const response = await fetch(new URL('/api/jobs', origin), {
    method: 'POST',
    headers: { ...publishHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body, token };
}

async function getStatus(id, jobId, token) {
  const response = await fetch(statusEndpoint(jobId, id), {
    headers: { 'X-Hub-Job-View': token, accept: 'application/json' },
    cache: 'no-store',
  });
  check(response.status === 200, 'view token could not read its job');
  const envelope = await responseJson(response, 'job status endpoint');
  check(
    envelope.schemaVersion === 1 && envelope.job?.id === jobId,
    'job status envelope did not match the requested job',
  );
  return envelope.job;
}

async function waitForTerminal(id, jobId, token, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await getStatus(id, jobId, token);
    if (isTerminal(last.status)) return last;
    await new Promise((accept) => setTimeout(accept, 250));
  }
  throw new Error(
    'job did not reach a terminal state (last status: ' + (last?.status ?? 'unknown') + ')',
  );
}

async function waitForCondition(condition, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(label + ' timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function findFreePort() {
  const { createServer } = await import('node:net');
  const listener = createServer();
  await new Promise((accept, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', accept);
  });
  const address = listener.address();
  check(address !== null && typeof address !== 'string', 'could not reserve a local API port');
  const port = address.port;
  await new Promise((accept, reject) =>
    listener.close((error) => (error ? reject(error) : accept())),
  );
  return port;
}

function serverEnvironment(renderer, apiOrigin) {
  const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
  check(
    typeof databaseUrl === 'string' && databaseUrl.length > 0,
    'HUB_TEST_DATABASE_URL must point at the isolated local test database',
  );
  return {
    NODE_ENV: 'test',
    HUB_STATIC_DIR: staticRoot,
    HUB_STORAGE: 'filesystem',
    HUB_ARTIFACT_DIR: artifactDirectory,
    HUB_PUBLICATIONS: 'postgres',
    HUB_DATABASE_URL: databaseUrl,
    HUB_DATABASE_INIT: 'true',
    HUB_JOBS_ENABLED: 'true',
    HUB_ALLOW_LOCAL_MUTATIONS: 'false',
    HUB_PUBLISH_TOKEN: publishToken,
    HUB_PUBLIC_ORIGIN: apiOrigin,
    HUB_THUMBNAIL_RENDERER: renderer,
    HUB_CHROMIUM_EXECUTABLE: chromiumExecutable,
  };
}

async function startApi(renderer) {
  const port = await findFreePort();
  const apiOrigin = 'http://127.0.0.1:' + port;
  const env = serverEnvironment(renderer, apiOrigin);
  const application = await createConfiguredHub(env);
  let listener;
  try {
    listener = await startHubServer({ server: application.server, host: '127.0.0.1', port });
  } catch (error) {
    await application.close();
    throw error;
  }
  equal(listener.origin, apiOrigin, 'Node API did not bind to its configured public origin');
  const current = {
    env,
    application,
    close: async () => {
      await listener.close();
      await application.close();
      if (appInstance === current) appInstance = undefined;
    },
  };
  appInstance = current;
  origin = apiOrigin;
  return current;
}

function parseWorkerEvent(log, event) {
  for (const line of log.split(/\r?\n/u)) {
    try {
      if (JSON.parse(line)?.event === event) return true;
    } catch {
      // Worker diagnostic lines are not structured events.
    }
  }
  return false;
}

async function startWorker(env) {
  const child = spawn(process.execPath, [workerEntry], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let settled = false;
  let rejectStart;
  let resolveStart;
  const ready = new Promise((accept, reject) => {
    resolveStart = accept;
    rejectStart = reject;
  });
  const append = (chunk) => {
    log = (log + chunk.toString('utf8')).slice(-64 * 1024);
    if (!settled && parseWorkerEvent(log, 'hub.worker.started')) {
      settled = true;
      resolveStart();
    }
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', (error) => {
    if (settled) return;
    settled = true;
    rejectStart(error);
  });
  child.once('close', (code, signal) => {
    if (settled) return;
    settled = true;
    rejectStart(
      new Error('job worker exited before startup (' + (code ?? signal ?? 'unknown') + ')'),
    );
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectStart(new Error('job worker startup timed out'));
    child.kill('SIGTERM');
  }, 15_000);
  try {
    await ready;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return child;
}

async function stopWorker(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const ended = await Promise.race([
    closed.then(() => true),
    new Promise((accept) => setTimeout(() => accept(false), 10_000)),
  ]);
  if (!ended && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'close');
  }
}

async function runCli(args, stateDirectory, timeoutMs = 90_000) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, XDG_STATE_HOME: stateDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [code, signal] = await once(child, 'close');
    return {
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseSingleJsonEnvelope(source, label) {
  const lines = source.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  equal(lines.length, 1, label + ' must write one JSON envelope to stdout');
  try {
    return JSON.parse(lines[0]);
  } catch {
    throw new Error(label + ' stdout was not valid JSON');
  }
}

async function findReceiptFiles(stateDirectory) {
  const receiptDirectory = join(stateDirectory, 'slidev-stage-hub', 'receipts');
  let names;
  try {
    names = await readdir(receiptDirectory);
  } catch {
    throw new Error('CLI did not create its private publication receipt directory');
  }
  return names.filter((name) => name.endsWith('.json')).map((name) => join(receiptDirectory, name));
}

async function writeHeadersFile(directory) {
  const path = join(directory, 'publish-headers.json');
  await writeFile(
    path,
    JSON.stringify({ origin, headers: { Authorization: 'Bearer ' + publishToken } }),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

function addBrowserRequestTracking(page, token) {
  const evidence = { tokenHeaderSeen: false, tokenInUrl: false, requests: [] };
  page.on('request', (request) => {
    evidence.requests.push(request.url());
    if (request.url().includes(token)) evidence.tokenInUrl = true;
    void request
      .allHeaders()
      .then((headers) => {
        if (headers['x-hub-job-view'] === token) evidence.tokenHeaderSeen = true;
      })
      .catch(() => undefined);
  });
  return evidence;
}

async function blockExternalHttpRequests(page) {
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== origin) {
      externalBrowserRequestsAttempted += 1;
      externalBrowserRequestsBlocked += 1;
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  page.on('response', (response) => {
    try {
      const responseUrl = new URL(response.url());
      if (['http:', 'https:'].includes(responseUrl.protocol) && responseUrl.origin !== origin)
        externalBrowserResponsesReceived += 1;
    } catch {
      // Ignore browser-internal resources.
    }
  });
}

function jobViewUrl(viewPath, token) {
  const url = new URL(viewPath, origin);
  url.hash = new URLSearchParams({ view: token }).toString();
  return url.href;
}

async function capture(page, fileName) {
  const path = join(screenshotDirectory, fileName);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  screenshots.push(relative(runDirectory, path).split('\\').join('/'));
}

async function verifyDesktopAndMobileLayout(page, mobileScreenshot) {
  const footer = page.locator('.library-footer');
  const publishedLink = page.locator('.publication .slide-link');
  if (await publishedLink.count()) {
    await publishedLink.scrollIntoViewIfNeeded();
    check(await publishedLink.isVisible(), 'published slide link was clipped on desktop');
  }
  await footer.scrollIntoViewIfNeeded();
  check(await footer.isVisible(), 'job page footer was clipped on desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  if (await publishedLink.count()) {
    await publishedLink.scrollIntoViewIfNeeded();
    check(await publishedLink.isVisible(), 'published slide link was clipped at a 390px viewport');
  }
  await footer.scrollIntoViewIfNeeded();
  check(await footer.isVisible(), 'job page footer was clipped at a 390px viewport');
  const width = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  check(
    width.document <= width.viewport && width.body <= width.viewport,
    'job status page overflowed horizontally at a 390px viewport',
  );
  await capture(page, mobileScreenshot);
}

function pngDimensions(bytes) {
  check(
    bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'thumbnail is not a PNG',
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function readThumbnail(job) {
  check(typeof job.result?.revision === 'string', 'job has no published revision');
  const path = '/releases/' + job.deckId + '/' + job.result.revision + '/thumbnail.png';
  const response = await fetch(new URL(path, origin), { cache: 'no-store' });
  check(response.status === 200, 'published thumbnail could not be read');
  check(
    response.headers.get('content-type')?.startsWith('image/png'),
    'thumbnail response content type was not image/png',
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const dimensions = pngDimensions(bytes);
  check(bytes.byteLength <= 4 * 1024 * 1024, 'thumbnail exceeded the 4 MiB contract limit');
  equal(dimensions.width, 1200, 'thumbnail width was not 1200 pixels');
  equal(dimensions.height, 675, 'thumbnail height was not 675 pixels');
  return bytes;
}

async function expectError(response, status, code, label) {
  equal(response.status, status, label + ' returned an unexpected HTTP status');
  const body = await responseJson(response, label);
  if (code === undefined) {
    equal(body.phase, 'auth', label + ' did not return the authentication error phase');
  } else {
    equal(body.code, code, label + ' returned unexpected public error code ' + String(body.code));
  }
  return body;
}

async function submitNoThumbnail(id, markdown, job = uuid(), token = viewToken()) {
  const submitted = await submitJob({ id, markdown, thumbnail: 'none', jobId: job, token });
  equal(submitted.response.status, 202, 'no-thumbnail submission was not accepted');
  const envelope = await responseJson(submitted.response, 'no-thumbnail submission');
  return { ...submitted, envelope };
}

async function browserPageForJob(job, token) {
  const page = await browser.newPage();
  await blockExternalHttpRequests(page);
  const requests = addBrowserRequestTracking(page, token);
  let fragmentClearedBeforeStatusRequest = false;
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === origin && requestUrl.pathname.startsWith('/api/jobs/'))
      fragmentClearedBeforeStatusRequest = !page.url().includes(token) && !page.url().includes('#');
  });
  const target = jobViewUrl(job.viewPath, token);
  const response = await page.goto(target, { waitUntil: 'domcontentloaded' });
  return {
    page,
    requests,
    target,
    response,
    fragmentClearedBeforeStatusRequest: () => fragmentClearedBeforeStatusRequest,
  };
}

async function browserPageForInjectedSnapshot(snapshot, token, setupPage) {
  const page = await browser.newPage();
  await blockExternalHttpRequests(page);
  const requests = addBrowserRequestTracking(page, token);
  if (setupPage) await setupPage(page);
  const job = snapshot.job;
  const path = '/api/jobs/' + encodeURIComponent(job.id);
  const routeEvidence = {
    statusGets: 0,
    nonGetStatusRequests: 0,
    identityMatches: true,
    tokenHeaderMatches: true,
  };
  await page.route('**/api/jobs/**', async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== origin || requestUrl.pathname !== path) return route.continue();
    if (request.method() !== 'GET') {
      routeEvidence.nonGetStatusRequests += 1;
      return route.continue();
    }
    routeEvidence.statusGets += 1;
    if (requestUrl.searchParams.get('deckId') !== job.deckId) routeEvidence.identityMatches = false;
    const headers = await request.allHeaders();
    if (headers['x-hub-job-view'] !== token) routeEvidence.tokenHeaderMatches = false;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: JSON.stringify(snapshot),
    });
  });
  const viewPath =
    '/_hub/jobs?' + new URLSearchParams({ deckId: job.deckId, jobId: job.id }).toString();
  const response = await page.goto(jobViewUrl(viewPath, token), { waitUntil: 'domcontentloaded' });
  return { page, requests, response, routeEvidence };
}

function assertInjectedStatusRead(injected, label) {
  check(injected.routeEvidence.statusGets > 0, label + ' did not read an injected status snapshot');
  equal(injected.routeEvidence.nonGetStatusRequests, 0, label + ' made a non-GET status request');
  check(injected.routeEvidence.identityMatches, label + ' requested another deck identity');
  check(injected.routeEvidence.tokenHeaderMatches, label + ' omitted its view-token header');
}

async function assertNoCapabilityLeak(page, requests, token) {
  const observed = await page.evaluate(() => ({
    href: location.href,
    html: document.documentElement.outerHTML,
    links: [...document.querySelectorAll('a[href]')].map((link) => link.href),
    storage: Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
    localStorageLength: localStorage.length,
  }));
  check(!observed.href.includes(token), 'view token remained in browser location');
  check(!observed.html.includes(token), 'view token appeared in the rendered DOM');
  check(
    observed.links.every((link) => !link.includes(token)),
    'view token appeared in a link',
  );
  check(
    requests.requests.every((url) => !url.includes(token)),
    'view token appeared in a request URL',
  );
  equal(observed.localStorageLength, 0, 'job view stored its capability in localStorage');
  check(!requests.tokenInUrl, 'view token was observed in a browser request URL');
  check(
    observed.storage.some((entry) => entry[0].includes('hub.job-view:') && entry[1] === token),
    'job view did not keep its reload capability in scoped sessionStorage',
  );
  check(requests.tokenHeaderSeen, 'job status request did not send the view token in its header');
}

async function assertPublishedRuntime(job, marker) {
  const revision = job.result?.revision;
  check(typeof revision === 'string', 'publication has no revision to pin');
  const entry = new URL(job.result.entry, origin);
  equal(
    entry.searchParams.get('revision'),
    revision,
    'published entry was not pinned to its job revision',
  );
  const response = await fetch(entry, { redirect: 'manual', cache: 'no-store' });
  equal(response.status, 200, 'revision-pinned deck entry was not served');
  const document = await response.text();
  check(
    document.includes('name="hub-revision"') && document.includes(revision),
    'deck entry did not expose its pinned revision',
  );

  const page = await browser.newPage();
  await blockExternalHttpRequests(page);
  try {
    await page.goto(entry.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (expected) =>
        document.querySelector('meta[name="hub-revision"]')?.getAttribute('content') === expected,
      revision,
      { timeout: 20_000 },
    );
    await page
      .getByText(marker, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    const body = await page.locator('body').innerText();
    check(body.includes(marker), 'revision-pinned runtime rendered the wrong fixture marker');
  } finally {
    await page.close();
  }
}

async function testCapabilityBoundaries(submitted) {
  const anonymous = await fetch(new URL('/api/jobs', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(submitted.body),
  });
  await expectError(anonymous, 401, undefined, 'anonymous job submission');

  const statusUrl = new URL(submitted.envelope.statusUrl, origin);
  const missing = await fetch(statusUrl, { cache: 'no-store' });
  await expectError(missing, 401, 'AUTH_REQUIRED', 'job status without a capability');

  const unknown = await fetch(statusUrl, {
    headers: { 'X-Hub-Job-View': viewToken() },
    cache: 'no-store',
  });
  await expectError(unknown, 404, 'JOB_NOT_FOUND', 'job status with an unrelated capability');

  const list = await fetch(
    new URL('/api/decks/' + encodeURIComponent(submitted.body.deckId) + '/jobs', origin),
    {
      headers: { authorization: 'Bearer ' + submitted.token },
    },
  );
  await expectError(list, 401, undefined, 'view capability used to list jobs');

  const retry = await fetch(
    new URL(
      '/api/jobs/' +
        submitted.body.jobId +
        '/retry?deckId=' +
        encodeURIComponent(submitted.body.deckId),
      origin,
    ),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: uuid(), stage: 'all', viewToken: submitted.token }),
    },
  );
  await expectError(retry, 401, undefined, 'unauthenticated retry');
}

async function testBrowserCapabilityPage(job, token) {
  const { page, requests, response, fragmentClearedBeforeStatusRequest } = await browserPageForJob(
    job,
    token,
  );
  try {
    const expectedTitle =
      job.job?.result?.thumbnail === 'skipped' ? '公開完了・サムネイル生成を省略' : '完了';
    await page
      .getByRole('heading', { name: expectedTitle, exact: true })
      .waitFor({ state: 'visible' });
    equal(
      await page.locator('.summary h2').innerText(),
      expectedTitle,
      'success viewer did not show the terminal phase',
    );
    check(
      fragmentClearedBeforeStatusRequest(),
      'viewer sent a status request before clearing the capability fragment',
    );
    await assertNoCapabilityLeak(page, requests, token);
    equal(
      await page.locator('.sr-only[aria-live="polite"]').innerText(),
      '',
      'initial snapshot was announced as a phase transition',
    );
    equal(
      response?.headers()['referrer-policy']?.toLowerCase(),
      'no-referrer',
      'job page response did not set a restrictive referrer policy',
    );
    check(
      !JSON.stringify(requests.requests).includes(token),
      'view token leaked into browser request URLs',
    );
    const pageText = await page.locator('body').innerText();
    check(
      !pageText.includes('Publication jobs E2E'),
      'Markdown title leaked into the job status screen',
    );
    check(!/%\s*/u.test(pageText), 'job status screen displayed a fabricated percentage');
    await capture(
      page,
      job.job?.result?.thumbnail === 'skipped'
        ? 'job-view-cli-thumbnail-skipped.png'
        : 'job-view-succeeded.png',
    );
    await verifyDesktopAndMobileLayout(
      page,
      job.job?.result?.thumbnail === 'skipped'
        ? 'job-view-cli-thumbnail-skipped-mobile.png'
        : 'job-view-succeeded-mobile.png',
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page
      .getByRole('heading', { name: expectedTitle, exact: true })
      .waitFor({ state: 'visible' });
    equal(
      await page.locator('.summary h2').innerText(),
      expectedTitle,
      'reload did not recover the job view from sessionStorage',
    );
    await assertNoCapabilityLeak(page, requests, token);
  } finally {
    await page.close();
  }
}

async function testInvalidBrowserCapability(jobId, id, token) {
  const page = await browser.newPage();
  await blockExternalHttpRequests(page);
  addBrowserRequestTracking(page, token);
  const url = new URL('/_hub/jobs', origin);
  url.searchParams.set('deckId', id);
  url.searchParams.set('jobId', jobId);
  url.hash = new URLSearchParams({ view: token }).toString();
  let cleanUrlAtStatusRequest = false;
  await page.route('**/api/jobs/' + jobId + '**', async (route) => {
    cleanUrlAtStatusRequest = !page.url().includes(token) && !page.url().includes('#');
    await route.continue();
  });
  try {
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('heading', { name: '確認リンクを開けません' })
      .waitFor({ state: 'visible' });
    check(cleanUrlAtStatusRequest, 'fragment capability was not cleared before the status request');
    check(
      !page.url().includes(token) && !page.url().includes('#'),
      'invalid link retained its fragment capability',
    );
    const pageText = await page.locator('body').innerText();
    check(
      pageText.includes('無効または有効期限切れ'),
      'invalid link did not use the generic denied copy',
    );
    check(!pageText.includes(token), 'invalid capability appeared in the rendered page');
    const storage = await page.evaluate(() => Object.keys(sessionStorage));
    check(
      !storage.some((key) => key.includes('hub.job-view:')),
      'denied capability remained in sessionStorage',
    );
    await capture(page, 'job-view-invalid-capability.png');
  } finally {
    await page.close();
  }
}

async function testInjectedRetryWaitFixtures(id) {
  const compileJobId = uuid();
  const compileToken = viewToken();
  const compileSnapshot = await loadInjectedSnapshot(
    'retry-wait-compile.json',
    compileJobId,
    id + '-compile',
  );
  const compileView = await browserPageForInjectedSnapshot(compileSnapshot, compileToken);
  try {
    await compileView.page
      .getByRole('heading', { name: '再試行待ち' })
      .waitFor({ state: 'visible' });
    assertInjectedStatusRead(compileView, 'compile retry-wait fixture');
    const compileStage = compileView.page.locator('.steps li').filter({ hasText: 'コンパイル' });
    const compileCountdown = await compileStage.locator('small').innerText();
    check(
      /^次の再試行まで \d+ 分/u.test(compileCountdown),
      'compile retry countdown was missing or did not use the future nextRunAt',
    );
    equal(
      await compileView.page
        .locator('.steps li')
        .filter({ hasText: 'サムネイル生成' })
        .locator('small')
        .count(),
      0,
      'compile retry countdown appeared under the thumbnail phase',
    );
    equal(
      await compileView.page.locator('.publication .slide-link').count(),
      0,
      'compile-only fixture showed a publication link before a result existed',
    );
    await assertNoCapabilityLeak(compileView.page, compileView.requests, compileToken);
    await capture(compileView.page, 'job-view-injected-retry-wait-compile.png');
  } finally {
    await compileView.page.close();
  }

  const thumbnailJobId = uuid();
  const thumbnailToken = viewToken();
  const thumbnailSnapshot = await loadInjectedSnapshot(
    'retry-wait-thumbnail.json',
    thumbnailJobId,
    id + '-thumbnail',
  );
  const thumbnailView = await browserPageForInjectedSnapshot(thumbnailSnapshot, thumbnailToken);
  try {
    await thumbnailView.page
      .getByRole('heading', { name: '公開済み・サムネイル生成中' })
      .waitFor({ state: 'visible' });
    assertInjectedStatusRead(thumbnailView, 'thumbnail retry-wait fixture');
    const thumbnailCountdown = thumbnailView.page
      .locator('.steps li')
      .filter({ hasText: 'サムネイル生成' })
      .locator('small');
    check(
      /^次の再試行まで \d+ 分/u.test(await thumbnailCountdown.innerText()),
      'thumbnail retry countdown was missing or did not use the future nextRunAt',
    );
    equal(
      await thumbnailView.page
        .locator('.steps li')
        .filter({ hasText: 'コンパイル' })
        .locator('small')
        .count(),
      0,
      'thumbnail retry countdown appeared under the compile phase',
    );
    const publishedLink = thumbnailView.page.locator('.publication .slide-link');
    const expectedHref = thumbnailSnapshot.job.result.entry;
    equal(
      await publishedLink.getAttribute('href'),
      expectedHref,
      'retry-wait snapshot changed its revision-pinned publication link',
    );
    await assertNoCapabilityLeak(thumbnailView.page, thumbnailView.requests, thumbnailToken);
    await capture(thumbnailView.page, 'job-view-injected-retry-wait-thumbnail.png');

    await thumbnailView.page.reload({ waitUntil: 'domcontentloaded' });
    await thumbnailView.page
      .getByRole('heading', { name: '公開済み・サムネイル生成中' })
      .waitFor({ state: 'visible' });
    equal(
      await publishedLink.getAttribute('href'),
      expectedHref,
      'reload changed the retry-wait revision-pinned publication link',
    );
    assertInjectedStatusRead(thumbnailView, 'reloaded thumbnail retry-wait fixture');
    await assertNoCapabilityLeak(thumbnailView.page, thumbnailView.requests, thumbnailToken);
  } finally {
    await thumbnailView.page.close();
  }

  return {
    evidence: {
      source: 'browser-intercepted synthetic contract snapshots; no backend job state mutated',
      fixtures: ['retry-wait-compile.json', 'retry-wait-thumbnail.json'],
      assertions: [
        'future retry countdown renders only under the active compile phase',
        'future retry countdown renders only under the active thumbnail phase',
        'thumbnail retry retains its same-identity revision-pinned link after reload',
      ],
    },
  };
}

async function testInjectedSensitiveErrorFixture(id) {
  const jobId = uuid();
  const token = viewToken();
  const snapshot = await loadInjectedSnapshot('partial-sensitive-error.json', jobId, id);
  const message = snapshot.job.error.message;
  secrets.add(message);
  const sentinelPath = '/__publication-job-message-sentinel-';
  secrets.add(sentinelPath);
  const sentinelRequests = [];
  const injected = await browserPageForInjectedSnapshot(snapshot, token, async (page) => {
    await page.addInitScript(() => {
      window.__publicationJobErrorSentinelExecuted = false;
    });
    page.on('request', (request) => {
      if (request.url().includes(sentinelPath)) sentinelRequests.push(request.url());
    });
  });
  try {
    await injected.page
      .getByRole('heading', { name: 'サムネイル生成を利用できません' })
      .waitFor({ state: 'visible' });
    assertInjectedStatusRead(injected, 'partial sensitive-error fixture');
    equal(
      injected.routeEvidence.statusGets,
      1,
      'terminal partial fixture triggered extra status polls',
    );
    const code = injected.page.locator('.error-code code');
    equal(await code.count(), 1, 'partial fixture did not render exactly one public error code');
    equal(
      await code.innerText(),
      snapshot.job.error.code,
      'partial fixture did not render only the validated public error code',
    );
    const pageText = await injected.page.locator('body').innerText();
    check(
      !pageText.includes(message),
      'partial fixture rendered its sensitive backend error message',
    );
    check(
      !pageText.includes('PRIVATE_PUBLICATION_MESSAGE_SENTINEL'),
      'partial fixture exposed the private error sentinel in visible text',
    );
    await injected.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const domEvidence = await injected.page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      executed: window.__publicationJobErrorSentinelExecuted,
      sentinelImageCount: document.querySelectorAll(
        'img[src*="__publication-job-message-sentinel-image"]',
      ).length,
    }));
    check(
      !domEvidence.html.includes(message),
      'partial fixture inserted the error message into the DOM',
    );
    check(
      !domEvidence.html.includes('PRIVATE_PUBLICATION_MESSAGE_SENTINEL'),
      'partial fixture inserted its private sentinel into the DOM',
    );
    check(!domEvidence.executed, 'partial fixture executed its injected HTML event handler');
    equal(domEvidence.sentinelImageCount, 0, 'partial fixture created an injected image element');
    equal(sentinelRequests.length, 0, 'partial fixture triggered an injected HTML request');
    await assertNoCapabilityLeak(injected.page, injected.requests, token);
    await capture(injected.page, 'job-view-injected-sensitive-error-safe.png');
  } finally {
    await injected.page.close();
  }

  return {
    evidence: {
      source:
        'browser-intercepted synthetic partial contract snapshot; no backend job state mutated',
      fixture: 'partial-sensitive-error.json',
      publicCode: snapshot.job.error.code,
      privateMessageRendered: false,
      injectedHtmlExecuted: false,
      injectedRequests: sentinelRequests.length,
    },
  };
}

async function testCliNoWaitAndWatch(id) {
  const stateDirectory = join(receiptStateDirectory, 'publish-flow');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const headersFile = await writeHeadersFile(stateDirectory);
  const source = fixture('basic.md');
  const result = await runCli(
    [
      'publish',
      '--origin',
      origin,
      '--headers-file',
      headersFile,
      '--id',
      id,
      '--source',
      source,
      '--thumbnail',
      'none',
      '--no-wait',
      '--json',
    ],
    stateDirectory,
  );
  equal(result.code, 0, 'hub publish --no-wait did not exit successfully');
  const output = parseSingleJsonEnvelope(result.stdout, 'hub publish --no-wait');
  check(
    output.ok === true && output.command === 'hub publish',
    'hub publish returned an invalid JSON success envelope',
  );
  const data = output.data;
  check(
    data?.accepted === true && data?.complete === false && data?.replayed === false,
    'hub publish did not report an accepted nonterminal job',
  );
  equal(data.deckId, id, 'hub publish reported the wrong deck id');
  check(
    typeof data.jobId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(data.jobId),
    'hub publish did not report a UUIDv4 job id',
  );

  const receipts = await findReceiptFiles(stateDirectory);
  equal(receipts.length, 1, 'hub publish did not write exactly one private receipt');
  const receiptStat = await stat(receipts[0]);
  check((receiptStat.mode & 0o077) === 0, 'CLI job receipt is readable by group or other users');
  const receipt = JSON.parse(await readFile(receipts[0], 'utf8'));
  equal(receipt.jobId, data.jobId, 'CLI receipt job identity did not match the accepted job');
  equal(receipt.deckId, id, 'CLI receipt deck identity did not match the accepted deck');
  check(
    typeof receipt.viewToken === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(receipt.viewToken),
    'CLI receipt did not retain a valid view capability',
  );
  check(
    !JSON.stringify(receipt).includes('Publication jobs E2E'),
    'CLI receipt persisted the source Markdown',
  );
  secrets.add(receipt.viewToken);
  const emittedUrls = result.stderr.match(/https?:\/\/127\.0\.0\.1:\d+\/[^\s]+/gu) ?? [];
  equal(emittedUrls.length, 1, 'hub publish did not emit exactly one local progress link');
  check(
    emittedUrls[0].includes('jobId=' + data.jobId) &&
      emittedUrls[0].includes('view=' + receipt.viewToken),
    'hub publish progress link did not identify the accepted job',
  );
  equal(
    (result.stderr.match(new RegExp(receipt.viewToken, 'gu')) ?? []).length,
    1,
    'CLI emitted its view capability more than once',
  );

  const terminal = await waitForTerminal(id, data.jobId, receipt.viewToken);
  equal(terminal.status, 'succeeded', 'CLI no-wait job did not succeed');
  const status = await runCli(
    ['jobs', 'status', '--origin', origin, '--id', id, '--job', data.jobId, '--json'],
    stateDirectory,
  );
  equal(status.code, 0, 'hub jobs status could not use its private receipt');
  const statusOutput = parseSingleJsonEnvelope(status.stdout, 'hub jobs status');
  check(
    statusOutput.ok === true && statusOutput.command === 'hub jobs status',
    'hub jobs status returned an invalid JSON envelope',
  );
  equal(statusOutput.data?.status, 'succeeded', 'hub jobs status did not show the terminal job');

  const watch = await runCli(
    [
      'jobs',
      'watch',
      '--origin',
      origin,
      '--id',
      id,
      '--job',
      data.jobId,
      '--timeout',
      '60',
      '--json',
    ],
    stateDirectory,
  );
  equal(watch.code, 0, 'hub jobs watch did not finish the accepted job');
  const watchOutput = parseSingleJsonEnvelope(watch.stdout, 'hub jobs watch');
  check(
    watchOutput.ok === true && watchOutput.command === 'hub jobs watch',
    'hub jobs watch returned an invalid JSON envelope',
  );
  equal(
    watchOutput.data?.status,
    'succeeded',
    'hub jobs watch did not return the terminal snapshot',
  );

  const list = await runCli(
    ['jobs', 'list', '--origin', origin, '--headers-file', headersFile, '--id', id, '--json'],
    stateDirectory,
  );
  equal(list.code, 0, 'authenticated hub jobs list did not succeed');
  const listOutput = parseSingleJsonEnvelope(list.stdout, 'hub jobs list');
  check(
    listOutput.ok === true && listOutput.command === 'hub jobs list',
    'hub jobs list returned an invalid JSON envelope',
  );
  check(
    listOutput.data?.items?.some((item) => item.id === data.jobId),
    'authenticated job list omitted the CLI submission',
  );
  return {
    jobId: data.jobId,
    token: receipt.viewToken,
    envelope: {
      job: terminal,
      viewPath: '/_hub/jobs?deckId=' + encodeURIComponent(id) + '&jobId=' + data.jobId,
    },
  };
}

async function testDisconnectedViewer(id, apiEnv) {
  await stopWorker(workerProcess);
  workerProcess = undefined;
  const submitted = await submitNoThumbnail(id, await readFile(fixture('basic.md'), 'utf8'));
  const job = submitted.envelope;
  equal(job.job.status, 'queued', 'job was not queued while its worker was stopped');

  const page = await browser.newPage();
  await blockExternalHttpRequests(page);
  const requests = addBrowserRequestTracking(page, submitted.token);
  const target = jobViewUrl(job.viewPath, submitted.token);
  let allowSnapshot = false;
  let snapshotSeen = false;
  let failFollowingPoll = false;
  let pollFailures = 0;
  let statusRequests = 0;
  const path = '/api/jobs/' + submitted.body.jobId;
  await page.route('**/api/jobs/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== origin || requestUrl.pathname !== path) return route.continue();
    statusRequests += 1;
    if (!allowSnapshot) return route.abort('failed');
    if (failFollowingPoll && snapshotSeen) {
      pollFailures += 1;
      return route.abort('failed');
    }
    const response = await route.fetch();
    const payload = await response.text();
    if (response.status() === 200 && !snapshotSeen) {
      snapshotSeen = true;
      failFollowingPoll = true;
    }
    await route.fulfill({ response, body: payload });
  });

  try {
    await page.bringToFront();
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '接続を待っています' }).waitFor({ state: 'visible' });
    await page
      .getByText('公開ジョブの状態を取得できません。自動で再接続しています。', { exact: true })
      .waitFor({ state: 'visible' });
    await page
      .getByText('接続できません。状態を取得でき次第、自動で再接続します。', { exact: true })
      .waitFor({ state: 'visible' });
    equal(
      await page.locator('.sr-only[aria-live="polite"]').innerText(),
      '',
      'failed first request announced a phase transition',
    );
    await capture(page, 'job-view-before-first-snapshot.png');

    allowSnapshot = true;
    await page
      .getByRole('heading', { name: 'キューで待機中' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    check(snapshotSeen, 'browser did not pass an actual status snapshot through the route');
    await waitForCondition(
      () => pollFailures > 0,
      'browser did not make the injected post-snapshot poll',
      30_000,
    );
    try {
      await page
        .getByText('通信が途切れています。最後に確認した状態を表示しています。', { exact: true })
        .waitFor({ state: 'visible', timeout: 5_000 });
    } catch (error) {
      const visibleText = await page
        .locator('main')
        .innerText()
        .catch(() => '');
      throw new Error(
        String(error) +
          `; stale debug: snapshotSeen=${snapshotSeen}, pollFailures=${pollFailures}, statusRequests=${statusRequests}, UI=${visibleText.slice(0, 700)}`,
      );
    }
    check(pollFailures > 0, 'browser did not encounter the injected transient reconnect failure');
    equal(
      await page.locator('.sr-only[aria-live="polite"]').innerText(),
      '',
      'initial queued snapshot announced a phase transition',
    );
    await assertNoCapabilityLeak(page, requests, submitted.token);
    await capture(page, 'job-view-stale-last-known-state.png');

    await page.unroute('**/api/jobs/**');
    await page.reload({ waitUntil: 'domcontentloaded' });
    check(
      !page.url().includes(submitted.token) && !page.url().includes('#'),
      'reload retained the capability fragment',
    );
    await page
      .getByRole('heading', { name: 'キューで待機中' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    await assertNoCapabilityLeak(page, requests, submitted.token);

    workerProcess = await startWorker(apiEnv);
    const terminal = await waitForTerminal(id, submitted.body.jobId, submitted.token);
    equal(
      terminal.status,
      'succeeded',
      'durable queued job did not resume after the standalone worker restarted',
    );
    await page
      .getByRole('heading', { name: '完了' })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await capture(page, 'job-view-reconnected-success.png');
    return { job: terminal, token: submitted.token, viewPath: job.viewPath };
  } finally {
    await page.close();
  }
}

async function testPinnedRevisions(id) {
  const markdownA = await readFile(fixture('revision-a.md'), 'utf8');
  const markdownB = await readFile(fixture('revision-b.md'), 'utf8');
  const first = await submitNoThumbnail(id, markdownA);
  const firstEnvelope = first.envelope;
  const firstJob = await waitForTerminal(id, first.body.jobId, first.token);
  equal(firstJob.status, 'succeeded', 'revision A publication did not succeed');
  await assertPublishedRuntime(firstJob, 'Revision A marker');

  const second = await submitNoThumbnail(id, markdownB);
  const secondEnvelope = second.envelope;
  const secondJob = await waitForTerminal(id, second.body.jobId, second.token);
  equal(secondJob.status, 'succeeded', 'revision B publication did not succeed');
  check(
    firstJob.result.revision !== secondJob.result.revision,
    'distinct source fixtures produced the same revision',
  );
  await assertPublishedRuntime(firstJob, 'Revision A marker');
  await assertPublishedRuntime(secondJob, 'Revision B marker');

  const current = await fetch(new URL('/' + id + '/1', origin), { cache: 'no-store' });
  equal(current.status, 200, 'current deck pointer was not served after the update');
  const currentHtml = await current.text();
  check(
    currentHtml.includes('name="hub-revision"') && currentHtml.includes(secondJob.result.revision),
    'current deck pointer did not advance to revision B',
  );
  check(
    !currentHtml.includes(firstJob.result.revision),
    'current deck pointer still selected revision A',
  );
  const list = await fetch(new URL('/api/decks/' + encodeURIComponent(id) + '/jobs', origin), {
    headers: publishHeaders(),
  });
  equal(list.status, 200, 'publish authorization could not list same-deck job history');
  const listEnvelope = await responseJson(list, 'same-deck job history');
  check(
    listEnvelope.items.some((item) => item.id === first.body.jobId),
    'same-deck history lost revision A job',
  );
  check(
    listEnvelope.items.some((item) => item.id === second.body.jobId),
    'same-deck history lost revision B job',
  );
  return {
    first: { job: firstJob, token: first.token, viewPath: firstEnvelope.viewPath },
    second: { job: secondJob, token: second.token, viewPath: secondEnvelope.viewPath },
  };
}

async function testPartialAndThumbnailChild(id) {
  await stopWorker(workerProcess);
  workerProcess = undefined;
  if (appInstance) {
    await appInstance.close();
    appInstance = undefined;
  }

  await startApi('none');
  workerProcess = await startWorker(appInstance.env);

  const source = await readFile(fixture('basic.md'), 'utf8');
  const partialAdmission = await submitJob({ id, markdown: source, thumbnail: 'auto' });
  equal(
    partialAdmission.response.status,
    202,
    'automatic thumbnail job was not accepted without a renderer',
  );
  const partialEnvelope = await responseJson(
    partialAdmission.response,
    'automatic thumbnail admission without renderer',
  );
  const partial = await waitForTerminal(id, partialEnvelope.job.id, partialAdmission.token);
  equal(partial.status, 'partial', 'automatic thumbnail job without a renderer was not partial');
  equal(
    partial.error?.code,
    'THUMBNAIL_UNAVAILABLE',
    'partial job did not expose the renderer-unavailable code',
  );
  equal(
    partial.result?.thumbnail,
    'unavailable',
    'partial publication did not preserve the published result',
  );
  await assertPublishedRuntime(partial, 'Publication jobs E2E');

  const partialView = await browserPageForJob(partialEnvelope, partialAdmission.token);
  try {
    await partialView.page
      .getByRole('heading', { name: 'サムネイル生成を利用できません' })
      .waitFor({ state: 'visible' });
    const pageText = await partialView.page.locator('body').innerText();
    check(
      pageText.includes('THUMBNAIL_UNAVAILABLE'),
      'partial viewer omitted its validated public error code',
    );
    check(
      !pageText.includes(partial.error.message),
      'partial viewer rendered the backend error message',
    );
    check(
      pageText.includes('スライドは公開済みです'),
      'partial viewer did not explain that slides remain published',
    );
    check(
      pageText.includes(
        'hub jobs retry --id ' + id + ' --job ' + partial.id + ' --stage thumbnail',
      ),
      'partial viewer did not show the thumbnail retry recipe',
    );
    equal(
      await partialView.page.locator('.publication .slide-link').count(),
      1,
      'partial viewer hid its published slide link',
    );
    equal(
      await partialView.page.locator('button').count(),
      0,
      'partial viewer offered an unauthenticated retry button',
    );
    check(!/%\s*/u.test(pageText), 'partial viewer displayed a fabricated percentage');
    await assertNoCapabilityLeak(partialView.page, partialView.requests, partialAdmission.token);
    await capture(partialView.page, 'job-view-partial-thumbnail-unavailable.png');
    await verifyDesktopAndMobileLayout(
      partialView.page,
      'job-view-partial-thumbnail-unavailable-mobile.png',
    );
  } finally {
    await partialView.page.close();
  }

  const deniedRetry = await fetch(
    new URL('/api/jobs/' + partial.id + '/retry?deckId=' + encodeURIComponent(id), origin),
    {
      method: 'POST',
      headers: { ...publishHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: uuid(), stage: 'thumbnail', viewToken: viewToken() }),
    },
  );
  await expectError(
    deniedRetry,
    503,
    'THUMBNAIL_UNAVAILABLE',
    'thumbnail retry without a renderer',
  );

  const skipped = await submitNoThumbnail(deckId('no-thumbnail'), source);
  const skippedEnvelope = skipped.envelope;
  const skippedJob = await waitForTerminal(skipped.body.deckId, skipped.body.jobId, skipped.token);
  equal(skippedJob.status, 'succeeded', 'explicit thumbnail:none job did not succeed');
  equal(
    skippedJob.result?.thumbnail,
    'skipped',
    'explicit thumbnail:none job did not report a skipped thumbnail',
  );
  const skippedView = await browserPageForJob(skippedEnvelope, skipped.token);
  try {
    await skippedView.page
      .getByRole('heading', { name: '公開完了・サムネイル生成を省略' })
      .waitFor({ state: 'visible' });
    check(
      (await skippedView.page.locator('body').innerText()).includes(
        'サムネイル生成は省略されました',
      ),
      'explicit skip view did not state that thumbnail generation was skipped',
    );
    await capture(skippedView.page, 'job-view-thumbnail-skipped.png');
  } finally {
    await skippedView.page.close();
  }

  if (appInstance) {
    await stopWorker(workerProcess);
    workerProcess = undefined;
    await appInstance.close();
    appInstance = undefined;
  }
  await startApi('playwright');
  workerProcess = await startWorker(appInstance.env);

  const retryState = join(receiptStateDirectory, 'thumbnail-retry');
  await mkdir(retryState, { recursive: true, mode: 0o700 });
  await chmod(retryState, 0o700);
  const retryHeadersFile = await writeHeadersFile(retryState);
  const cliRetry = await runCli(
    [
      'jobs',
      'retry',
      '--origin',
      origin,
      '--headers-file',
      retryHeadersFile,
      '--id',
      id,
      '--job',
      partial.id,
      '--stage',
      'thumbnail',
      '--no-wait',
      '--json',
    ],
    retryState,
  );
  equal(cliRetry.code, 0, 'hub jobs retry --stage thumbnail did not accept a child job');
  const retryOutput = parseSingleJsonEnvelope(cliRetry.stdout, 'hub jobs retry --stage thumbnail');
  check(
    retryOutput.ok === true && retryOutput.command === 'hub jobs retry',
    'hub jobs retry returned an invalid JSON envelope',
  );
  check(
    retryOutput.data?.accepted === true && retryOutput.data?.complete === false,
    'hub jobs retry did not report an accepted thumbnail child',
  );
  const childId = retryOutput.data.jobId;
  const childReceipts = await findReceiptFiles(retryState);
  equal(childReceipts.length, 1, 'hub jobs retry did not save exactly one child receipt');
  const childReceiptStat = await stat(childReceipts[0]);
  check(
    (childReceiptStat.mode & 0o077) === 0,
    'thumbnail child receipt is readable by group or other users',
  );
  const childReceipt = JSON.parse(await readFile(childReceipts[0], 'utf8'));
  equal(
    childReceipt.parentJobId,
    partial.id,
    'thumbnail child receipt did not retain the parent identity',
  );
  equal(childReceipt.stage, 'thumbnail', 'thumbnail child receipt did not retain the retry stage');
  equal(childReceipt.jobId, childId, 'thumbnail child receipt id did not match CLI output');
  check(
    typeof childReceipt.viewToken === 'string' &&
      /^[A-Za-z0-9_-]{43}$/u.test(childReceipt.viewToken),
    'thumbnail child receipt did not retain a valid view capability',
  );
  secrets.add(childReceipt.viewToken);
  const childLinks = cliRetry.stderr.match(/https?:\/\/127\.0\.0\.1:\d+\/[^\s]+/gu) ?? [];
  equal(childLinks.length, 1, 'hub jobs retry did not emit one child status link');
  check(
    childLinks[0].includes('jobId=' + childId) &&
      childLinks[0].includes('view=' + childReceipt.viewToken),
    'hub jobs retry link did not identify its child job',
  );
  const childToken = childReceipt.viewToken;
  const childEnvelope = {
    job: { id: childId, deckId: id },
    viewPath: '/_hub/jobs?deckId=' + encodeURIComponent(id) + '&jobId=' + childId,
  };
  const child = await waitForTerminal(id, childId, childToken);
  equal(child.status, 'succeeded', 'thumbnail retry child did not succeed');
  equal(child.kind, 'thumbnail', 'thumbnail retry did not create a thumbnail child job');
  equal(
    child.result?.revision,
    partial.result.revision,
    'thumbnail child did not inherit the original published revision',
  );
  equal(child.result?.thumbnail, 'ready', 'thumbnail child did not persist its ready thumbnail');
  equal(child.parentJobId, partial.id, 'terminal thumbnail child lost its parent identity');
  const png = await readThumbnail(child);
  await writeFile(join(runDirectory, 'thumbnail-child.png'), png);

  const childView = await browserPageForJob(childEnvelope, childToken);
  try {
    await childView.page.getByRole('heading', { name: '完了' }).waitFor({ state: 'visible' });
    const stageText = await childView.page.locator('.steps').innerText();
    check(
      stageText.includes('元の公開で完了'),
      'thumbnail child did not distinguish inherited publication stages',
    );
    check(
      !stageText.includes('%') && !stageText.includes(' / '),
      'thumbnail child showed compile progress that does not belong to its phase',
    );
    const pinnedLink = childView.page.locator('.publication .slide-link');
    equal(
      await pinnedLink.getAttribute('href'),
      child.result.entry,
      'thumbnail child did not link to its inherited revision-pinned publication',
    );
    await assertNoCapabilityLeak(childView.page, childView.requests, childToken);
    await capture(childView.page, 'job-view-thumbnail-child-succeeded.png');
    await verifyDesktopAndMobileLayout(
      childView.page,
      'job-view-thumbnail-child-succeeded-mobile.png',
    );
  } finally {
    await childView.page.close();
  }
  return {
    partial: { job: partial, token: partialAdmission.token, viewPath: partialEnvelope.viewPath },
    child: { job: child, token: childToken, viewPath: childEnvelope.viewPath },
  };
}

async function waitForApi() {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/capabilities', origin), { cache: 'no-store' });
      if (response.status === 200) return;
      lastError = new Error('capability endpoint returned HTTP ' + response.status);
    } catch {
      lastError = new Error('capability endpoint is not ready');
    }
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw lastError ?? new Error('Node API did not become ready');
}

async function checkPreflight() {
  const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
  check(
    typeof databaseUrl === 'string' && databaseUrl.length > 0,
    'HUB_TEST_DATABASE_URL must point at the isolated local test database',
  );
  let parsedDatabaseUrl;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error('HUB_TEST_DATABASE_URL must be a valid isolated PostgreSQL URL');
  }
  check(
    ['127.0.0.1', 'localhost', '[::1]'].includes(parsedDatabaseUrl.hostname) &&
      parsedDatabaseUrl.port === '55461' &&
      parsedDatabaseUrl.pathname === '/hub_jobs',
    'E2E requires the isolated task database on local port 55461',
  );
  for (const path of [
    join(staticRoot, 'runtime-manifest.json'),
    join(staticRoot, 'jobs.html'),
    workerEntry,
    cliEntry,
    chromiumExecutable,
    fixture('basic.md'),
    fixture('revision-a.md'),
    fixture('revision-b.md'),
    fixture('retry-wait-compile.json'),
    fixture('retry-wait-thumbnail.json'),
    fixture('partial-sensitive-error.json'),
  ]) {
    try {
      await access(path);
    } catch {
      throw new Error('required built E2E input is missing: ' + relative(repositoryRoot, path));
    }
  }
  const cliSource = await readFile(cliEntry, 'utf8');
  check(cliSource.includes('runCli'), 'CLI dist entry does not appear to have been built');
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await chmod(runDirectory, 0o700);
  await mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
  await chmod(screenshotDirectory, 0o700);
  publishToken = randomBytes(32).toString('base64url');
  secrets.add(publishToken);
}

async function testCapabilities(rendererAvailable) {
  const response = await fetch(new URL('/api/capabilities', origin), { cache: 'no-store' });
  equal(response.status, 200, 'capabilities endpoint did not return HTTP 200');
  equal(response.headers.get('cache-control'), 'no-store', 'capabilities response was cacheable');
  const body = await responseJson(response, 'capabilities endpoint');
  check(body.schemaVersion === 1, 'capabilities endpoint returned an unsupported schema version');
  check(
    body.publicationJobs?.enabled === true && body.publicationJobs?.pollAfterMs === 2000,
    'publication job capabilities did not match the public contract',
  );
  equal(
    body.thumbnail?.available,
    rendererAvailable,
    'thumbnail capability did not match the configured renderer',
  );
  check(
    body.limits?.requestBytes === 524288 && body.limits?.maxSlides === 100,
    'job limits did not match the published contract',
  );
}

async function testAutoThumbnailAndIdempotency(id) {
  const markdown = await readFile(fixture('basic.md'), 'utf8');
  const submitted = await submitJob({ id, markdown, thumbnail: 'auto' });
  equal(
    submitted.response.status,
    202,
    'new automatic-thumbnail job was not accepted with HTTP 202',
  );
  equal(
    submitted.response.headers.get('cache-control'),
    'no-store',
    'job admission response was cacheable',
  );
  equal(
    submitted.response.headers.get('retry-after'),
    '2',
    'job admission response omitted polling guidance',
  );
  const envelope = await responseJson(submitted.response, 'job admission');
  check(
    envelope.schemaVersion === 1 && envelope.replayed === false,
    'job admission returned an invalid or replayed envelope',
  );
  equal(envelope.job.id, submitted.body.jobId, 'job admission changed the requested id');
  equal(envelope.job.deckId, id, 'job admission changed the requested deck id');
  check(
    envelope.job.status === 'queued' || envelope.job.status === 'running',
    'job admission did not return an active snapshot',
  );
  check(
    envelope.statusUrl.startsWith('/api/jobs/') && envelope.viewPath.startsWith('/_hub/jobs?'),
    'job admission returned non-relative API or view URLs',
  );
  equal(
    submitted.response.headers.get('location'),
    envelope.statusUrl,
    'job admission Location did not match its status URL',
  );
  check(
    !JSON.stringify(envelope).includes(submitted.token),
    'job admission echoed the view capability',
  );
  check(!JSON.stringify(envelope).includes(markdown), 'job admission echoed the source Markdown');
  const withEnvelope = { ...submitted, envelope };
  await testCapabilityBoundaries(withEnvelope);

  const replay = await submitJob({
    id,
    jobId: submitted.body.jobId,
    token: submitted.token,
    markdown,
    thumbnail: 'auto',
  });
  check([200, 202].includes(replay.response.status), 'same-id same-body replay was not accepted');
  const replayEnvelope = await responseJson(replay.response, 'idempotent replay');
  check(
    replayEnvelope.replayed === true,
    'same-id same-body request was not identified as a replay',
  );
  equal(replayEnvelope.job.id, envelope.job.id, 'idempotent replay created a second job');

  const conflict = await submitJob({
    id,
    jobId: submitted.body.jobId,
    token: submitted.token,
    markdown: markdown + '\nA different request.\n',
    thumbnail: 'auto',
  });
  await expectError(
    conflict.response,
    409,
    'IDEMPOTENCY_CONFLICT',
    'same-id changed-body submission',
  );

  const terminal = await waitForTerminal(id, submitted.body.jobId, submitted.token, 120_000);
  equal(terminal.status, 'succeeded', 'automatic-thumbnail publication did not succeed');
  equal(
    terminal.result?.thumbnail,
    'ready',
    'automatic-thumbnail publication did not produce a ready thumbnail',
  );
  equal(terminal.result?.pages, 2, 'fixture publication reported the wrong slide count');
  const png = await readThumbnail(terminal);
  await writeFile(join(runDirectory, 'thumbnail-auto.png'), png);
  const final = await getStatus(id, submitted.body.jobId, submitted.token);
  equal(
    final.status,
    'succeeded',
    'capability status endpoint did not return the terminal snapshot',
  );
  const listed = await fetch(new URL('/api/decks/' + encodeURIComponent(id) + '/jobs', origin), {
    headers: publishHeaders(),
  });
  equal(listed.status, 200, 'publish authorization could not list jobs');
  const listEnvelope = await responseJson(listed, 'authenticated job list');
  equal(listEnvelope.schemaVersion, 1, 'job list returned an unsupported schema version');
  equal(
    listEnvelope.items.filter((item) => item.id === submitted.body.jobId).length,
    1,
    'idempotent replay created duplicate list entries',
  );
  return { submitted: withEnvelope, job: terminal };
}

async function runCloudflareVerifier() {
  const verifier = join(scriptsDirectory, 'verify-jobs-do.mjs');
  try {
    await access(verifier);
  } catch {
    throw new Error(
      'Cloudflare Durable Object verifier was not present when the combined E2E suite ran',
    );
  }
  const result = await runNodeProcess(verifier, 180_000);
  equal(result.code, 0, 'Cloudflare Durable Object injected-binding verifier did not pass');
  const output = result.stdout
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  check(output.length > 0, 'Cloudflare verifier did not emit machine-readable evidence');
  let evidence;
  try {
    evidence = JSON.parse(output.at(-1));
  } catch {
    throw new Error('Cloudflare verifier did not end with a JSON evidence object');
  }
  check(
    evidence.ok === true && Number.isSafeInteger(evidence.passCount) && evidence.passCount > 0,
    'Cloudflare verifier did not report its passing checks',
  );
  return {
    cloudDeployed: false,
    passCount: evidence.passCount,
    evidence:
      typeof evidence.evidence === 'string'
        ? evidence.evidence
        : 'apps/hub-worker/artifacts/jobs-do-verification.json',
    checks: evidence.checks,
  };
}

async function runNodeProcess(script, timeoutMs) {
  const child = spawn(process.execPath, [script], {
    cwd: repositoryRoot,
    env: { ...process.env, HUB_TEST_DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [code, signal] = await once(child, 'close');
    return {
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function evidenceReport(status, error) {
  return {
    schemaVersion: 1,
    suite: 'publication-jobs-local-e2e',
    status,
    runId,
    node: process.version,
    persistence: 'isolated local PostgreSQL task database',
    adapter: 'Node adapter with standalone PostgreSQL worker process',
    browser: 'Playwright Chromium, loopback only',
    cloudDeployed: false,
    externalBrowserRequests: {
      attempted: externalBrowserRequestsAttempted,
      blocked: externalBrowserRequestsBlocked,
      responsesReceived: externalBrowserResponsesReceived,
    },
    cases: results,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    screenshots: screenshots.slice(),
    ...(error ? { error: sanitizedMessage(error), failedCase: activeCase } : {}),
  };
}

async function main() {
  let finalError;
  try {
    await scenario('local build, database and Chromium preflight', checkPreflight);
    await scenario('launch local Playwright Chromium', async () => {
      browser = await chromium.launch({ headless: true });
    });
    await scenario('Node API and PostgreSQL standalone worker startup', async () => {
      const api = await startApi('playwright');
      await waitForApi();
      workerProcess = await startWorker(api.env);
    });
    await scenario('capability contract with automatic thumbnail renderer', () =>
      testCapabilities(true),
    );

    const autoId = deckId('auto-thumbnail');
    const automatic = await scenario(
      'authenticated job admission, capabilities, idempotency and rendered 1200x675 thumbnail',
      () => testAutoThumbnailAndIdempotency(autoId),
    );
    await scenario(
      'job viewer capability handling, session reload, fragment removal and terminal snapshot',
      () => testBrowserCapabilityPage(automatic.submitted.envelope, automatic.submitted.token),
    );
    await scenario('expired or unknown viewer capability is denied generically', () =>
      testInvalidBrowserCapability(uuid(), deckId('unknown-view'), viewToken()),
    );
    const retryWaitEvidence = await scenario(
      'injected retry_wait fixtures align countdowns with the active phase and preserve revision links',
      () => testInjectedRetryWaitFixtures(deckId('injected-retry-wait')),
    );
    results.at(-1).evidence = retryWaitEvidence.evidence;
    const sensitiveErrorEvidence = await scenario(
      'injected partial error fixture renders only its public code and never executes message HTML',
      () => testInjectedSensitiveErrorFixture(deckId('injected-sensitive-error')),
    );
    results.at(-1).evidence = sensitiveErrorEvidence.evidence;

    const cliId = deckId('cli-no-wait');
    const cliJob = await scenario(
      'CLI publish --no-wait receipt, status, watch and authenticated list',
      () => testCliNoWaitAndWatch(cliId),
    );
    await scenario('CLI-issued capability opens the rendered status page', () =>
      testBrowserCapabilityPage(cliJob.envelope, cliJob.token),
    );

    await scenario(
      'same-deck updates preserve revision-pinned A while advancing current pointer to B',
      () => testPinnedRevisions(deckId('revision-pinning')),
    );
    const durableJob = await scenario(
      'disconnected viewer recovery and queued PostgreSQL job resumes after worker restart',
      () => testDisconnectedViewer(deckId('worker-restart'), appInstance.env),
    );
    await scenario(
      'restarted worker publication remains readable through revision-pinned runtime',
      () => assertPublishedRuntime(durableJob.job, 'Publication jobs E2E'),
    );

    const retryFlows = await scenario(
      'renderer-unavailable partial, skipped thumbnail, and successful persisted thumbnail child',
      () => testPartialAndThumbnailChild(deckId('thumbnail-retry')),
    );
    const cloudEvidence = await scenario(
      'Cloudflare Durable Object injected-binding verifier',
      () => runCloudflareVerifier(),
    );
    results[results.length - 1].evidence = {
      passCount: cloudEvidence.passCount,
      evidence: cloudEvidence.evidence,
      checks: cloudEvidence.checks,
      cloudDeployed: false,
    };
    check(
      retryFlows.partial.job.status === 'partial' && retryFlows.child.job.status === 'succeeded',
      'thumbnail retry evidence lost its terminal snapshots',
    );
    equal(
      externalBrowserResponsesReceived,
      0,
      'a browser page received a response from an external HTTP origin',
    );
    equal(
      externalBrowserRequestsAttempted,
      externalBrowserRequestsBlocked,
      'not every external browser request was blocked before receiving a response',
    );
  } catch (error) {
    finalError = error;
  } finally {
    await stopWorker(workerProcess).catch((error) => {
      if (!finalError) finalError = error;
    });
    workerProcess = undefined;
    if (appInstance) {
      await appInstance.close().catch((error) => {
        if (!finalError) finalError = error;
      });
      appInstance = undefined;
    }
    if (browser)
      await browser.close().catch((error) => {
        if (!finalError) finalError = error;
      });
    await rm(receiptStateDirectory, { recursive: true, force: true });
    const report = evidenceReport(finalError ? 'failed' : 'passed', finalError);
    await writeFile(join(runDirectory, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        evidence: relative(repositoryRoot, join(runDirectory, 'evidence.json'))
          .split('\\')
          .join('/'),
        status: report.status,
        passed: report.passed,
        failed: report.failed,
        cloudDeployed: false,
      }),
    );
  }
  if (finalError) {
    console.error('FAIL ' + activeCase + ': ' + sanitizedMessage(finalError));
    process.exitCode = 1;
  }
}

await main();
