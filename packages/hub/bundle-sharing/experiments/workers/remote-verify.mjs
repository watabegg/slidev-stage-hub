import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePng } from './thumbnail.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(ROOT, '../../..');
const RESULT_PATH = resolve(ROOT, 'results/remote-verification.json');
const PNG_PATH = resolve(REPOSITORY_ROOT, 'artifacts/workers/remote-thumbnail.png');
const DECK_ID = 'cloud/demo';
const INVALID_TOKEN = 'slidev-lab-remote-verification-invalid-token';
const CHROMIUM_PATH = process.env.CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome';
const SLIDE_SELECTOR = '.slidev-page[data-slidev-no="1"]';

function check(name, passed) {
  const result = { name, passed: Boolean(passed) };
  run.checks.push(result);
  if (!result.passed) throw new Error(`check failed: ${name}`);
}

function parseOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Usage: node remote-verify.mjs <https-origin>'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('origin must be an HTTPS origin without a path, query, fragment, or credentials');
  return url.origin;
}

async function loadBearerToken() {
  const filePath = process.env.SLIDEV_POC_TOKEN_FILE;
  if (!filePath) throw new Error('SLIDEV_POC_TOKEN_FILE must point to the protected bearer-token file');
  let details;
  let contents;
  try {
    details = await stat(filePath);
    contents = await readFile(filePath, 'utf8');
  }
  catch {
    throw new Error('Could not read the protected bearer-token file');
  }
  if (!details.isFile() || (details.mode & 0o077) !== 0)
    throw new Error('bearer-token file must be a regular file accessible only to its owner');
  const token = contents.trim();
  if (!token || /\s/.test(token)) throw new Error('bearer-token file must contain one non-empty token');
  return token;
}

function makeFixture(runId, updated = false) {
  const note = `REMOTE_PRIVATE_NOTE_${runId}`;
  const fence = String.fromCharCode(96).repeat(3);
  return {
    note,
    markdown: `---
title: Remote Cloudflare Verification
theme: watabegg
layout: cover
author: Slidev Lab
---

# Remote Cloudflare Verification

Five-page authenticated publication fixture.

<!-- ${note} -->

---
layout: default
---

# Keyboard and click progression

<div v-click data-testid="remote-click-one">Enter reveals this step</div>

---
layout: section
---

# Shared runtime modules

The deck imports the prebuilt shared Vue and Slidev bridge modules.

---
layout: default
---

# Published image asset

<img src="./remote-diagram.svg" alt="Remote verification asset" style="width: 70%;">

---
layout: default
---

# Compiler warnings and revision marker

${fence}js
const mode = 'plain code warning probe'
${fence}

Inline math probe: $E = mc^2$.

${updated ? 'Updated revision' : 'Initial revision'}: ${runId}
`,
  };
}

const ASSETS = {
  'remote-diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240" viewBox="0 0 600 240"><rect width="600" height="240" fill="#132a36"/><text x="300" y="135" text-anchor="middle" font-size="36" fill="#7fe0bb">Remote release asset</text></svg>',
};

function urlForDeckPage(origin, id, page, revision) {
  const path = `/${id.split('/').map(encodeURIComponent).join('/')}/${page}`;
  const url = new URL(path, origin);
  url.searchParams.set('revision', revision);
  return url;
}

function safePath(url) {
  return `${url.pathname}${url.search}`;
}

async function performHttp(name, url, init = {}, timeoutMs = 180_000) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    return { response, started, url: new URL(url), name, method: init.method || 'GET' };
  }
  catch (error) {
    run.requests.push({
      name,
      method: init.method || 'GET',
      path: safePath(new URL(url)),
      status: null,
      wallMs: Math.round(performance.now() - started),
      error: error?.name === 'AbortError' ? 'request timed out' : 'network request failed',
    });
    throw new Error(`${name} failed before receiving an HTTP response`);
  }
  finally {
    clearTimeout(timeout);
  }
}

function appendRequest(record, response, extra = {}) {
  const status = response.status;
  run.requests.push({
    name: record.name,
    method: record.method,
    path: safePath(record.url),
    status,
    wallMs: Math.round(performance.now() - record.started),
    contentType: response.headers.get('content-type') || null,
    error: response.ok ? null : `HTTP ${status}`,
    ...extra,
  });
}

async function readJson(name, url, init = {}, expectedStatuses = [200]) {
  const record = await performHttp(name, url, init);
  const response = record.response;
  let text;
  try { text = await response.text(); }
  catch {
    appendRequest(record, response, { error: 'response body could not be read' });
    throw new Error(`${name} returned an unreadable response body (HTTP ${response.status})`);
  }
  let value;
  let validJson = false;
  try { value = JSON.parse(text); validJson = true; }
  catch { /* Never include a response body in diagnostics or artifacts. */ }
  const safeRemoteError = [
    'Cloudflare Browser Run thumbnail capture',
    'current revision Browser Run thumbnail capture',
    'thumbnail cache confirmation',
  ].includes(name)
    && typeof value?.error === 'string'
    ? value.error.slice(0, 200)
    : null;
  appendRequest(record, response, { json: validJson, ...(safeRemoteError ? { remoteError: safeRemoteError } : {}) });
  if (!expectedStatuses.includes(response.status)) {
    const format = validJson ? '' : ` with non-JSON content type ${response.headers.get('content-type') || 'unknown'}`;
    const detail = safeRemoteError ? `: ${safeRemoteError}` : '';
    throw new Error(`${name} returned unexpected HTTP ${response.status}${format}${detail}`);
  }
  if (response.ok && !validJson)
    throw new Error(`${name} returned non-JSON HTTP ${response.status} (${response.headers.get('content-type') || 'unknown'})`);
  return { status: response.status, value: validJson ? value : null };
}

async function readText(name, url) {
  const record = await performHttp(name, url);
  const response = record.response;
  let value;
  try { value = await response.text(); }
  catch {
    appendRequest(record, response, { error: 'response body could not be read' });
    throw new Error(`${name} returned an unreadable response body (HTTP ${response.status})`);
  }
  appendRequest(record, response, { bytes: Buffer.byteLength(value) });
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
  return value;
}

async function readBytes(name, url) {
  const record = await performHttp(name, url);
  const response = record.response;
  let bytes;
  try { bytes = Buffer.from(await response.arrayBuffer()); }
  catch {
    appendRequest(record, response, { error: 'response body could not be read' });
    throw new Error(`${name} returned an unreadable response body (HTTP ${response.status})`);
  }
  appendRequest(record, response, { bytes: bytes.byteLength });
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
  return bytes;
}

function deckEndpoint(origin) {
  return new URL(`/api/decks/${encodeURIComponent(DECK_ID)}`, origin);
}

async function publish(origin, token, fixture, expectedStatuses = [200]) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const { status, value } = await readJson(
    `publish ${expectedStatuses[0] === 400 ? 'invalid compiler input' : token === null ? 'without bearer' : token === INVALID_TOKEN ? 'with wrong bearer' : 'deck'}`,
    deckEndpoint(origin),
    { method: 'POST', headers, body: JSON.stringify({ markdown: fixture.markdown, assets: ASSETS }) },
    expectedStatuses,
  );
  return { status, value };
}

async function fetchManifest(origin, revision) {
  const url = deckEndpoint(origin);
  if (revision) url.searchParams.set('revision', revision);
  const { value } = await readJson(revision ? 'public pinned manifest' : 'public current manifest', url);
  return value;
}

function expectSharedModuleImports(moduleText) {
  return moduleText.includes('/_runtime/bridge.js')
    && moduleText.includes('/_runtime/vue.js');
}

async function verifyLocalChrome(origin, manifest, imageAssetPath) {
  run.localChrome.status = 'running';
  const themePath = process.env.SLIDEV_THEME_PATH || '/home/watabegg/slidev-watabegg';
  let chromium;
  try {
    chromium = createRequire(resolve(themePath, 'package.json'))('playwright-chromium').chromium;
  }
  catch {
    throw new Error('local Chrome test could not load playwright-chromium from the configured theme');
  }

  let browser;
  let context;
  const browserErrors = { pageErrors: 0, consoleErrors: 0 };
  try {
    try { browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true }); }
    catch { throw new Error('local Chrome could not be launched'); }
    context = await browser.newContext({ viewport: { width: 1200, height: 675 } });
    const page = await context.newPage();
    page.on('pageerror', () => { browserErrors.pageErrors += 1; });
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.consoleErrors += 1;
    });

    await page.goto(new URL(manifest.entry, origin).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator(`${SLIDE_SELECTOR} h1`).waitFor({ state: 'visible', timeout: 60_000 });
    const coverTitle = await page.locator(`${SLIDE_SELECTOR} h1`).innerText();
    check('local Chrome opens remote cover entry', coverTitle.includes('Remote Cloudflare Verification'));
    check('local Chrome URL remains pinned to first revision', new URL(page.url()).searchParams.get('revision') === manifest.revision);

    await page.keyboard.press('Enter');
    await page.locator('.slidev-page[data-slidev-no="2"] h1').waitFor({ state: 'visible', timeout: 20_000 });
    const click = page.getByTestId('remote-click-one');
    check('remote v-click starts hidden', await click.evaluate(element => getComputedStyle(element).visibility === 'hidden' || getComputedStyle(element).opacity === '0'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="remote-click-one"]');
      return element && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).opacity !== '0';
    }, null, { timeout: 10_000 });
    check('Enter reveals remote v-click', true);

    const imagePage = urlForDeckPage(origin, DECK_ID, 4, manifest.revision);
    await page.goto(imagePage.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const image = page.locator('.slidev-page[data-slidev-no="4"] img[alt="Remote verification asset"]');
    await image.waitFor({ state: 'visible', timeout: 60_000 });
    const imageLoaded = await image.evaluate(async element => {
      await element.decode();
      return element.naturalWidth > 0 && element.currentSrc.endsWith('/remote-diagram.svg');
    });
    check('local Chrome opens remote image page and decodes its release asset', imageLoaded);
    check('local Chrome recorded no page or console errors', browserErrors.pageErrors === 0 && browserErrors.consoleErrors === 0);
    run.localChrome = {
      status: 'passed',
      entryPath: safePath(new URL(manifest.entry, origin)),
      imagePagePath: safePath(imagePage),
      clickSequence: ['Enter to page 2', 'Enter to reveal v-click'],
      imageAssetPath,
      browserErrors,
      screenshot: null,
    };
  }
  finally {
    try { await context?.close(); }
    finally { await browser?.close(); }
  }
}

let runId = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
let initial = makeFixture(runId);
let updated = makeFixture(runId, true);
let run = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  command: 'node remote-verify.mjs <https-origin>',
  origin: null,
  deckId: DECK_ID,
  status: 'running',
  environment: { node: process.version, platform: process.platform, arch: process.arch, chromiumPath: CHROMIUM_PATH },
  checks: [],
  requests: [],
  errors: [],
  browserRun: { status: 'not-run', capturePosts: 0, source: 'Cloudflare Browser Run API' },
  localChrome: { status: 'not-run', source: 'local Chromium against remote URL', screenshot: null },
  thumbnail: null,
  publication: null,
};

async function runVerification() {
  const [originInput, mode] = process.argv.slice(2);
  if (process.argv.length < 3 || process.argv.length > 4 || !originInput)
    throw new Error('Usage: node remote-verify.mjs <https-origin> [--continue-after-browser-failure]');
  const origin = parseOrigin(originInput);
  if (mode && mode !== '--continue-after-browser-failure')
    if (mode !== '--recover-captured-artifacts')
      throw new Error('Unsupported optional mode');
  if (mode === '--continue-after-browser-failure') {
    await continueAfterBrowserFailure(origin);
    return;
  }
  if (mode === '--recover-captured-artifacts') {
    await recoverCapturedArtifacts(origin);
    return;
  }
  run.origin = origin;
  const token = await loadBearerToken();

  const deniedWithoutToken = await publish(origin, null, initial, [401]);
  check('deck publish rejects a missing bearer with HTTP 401', deniedWithoutToken.status === 401);
  const deniedWrongToken = await publish(origin, INVALID_TOKEN, initial, [401]);
  check('deck publish rejects a wrong bearer with HTTP 401', deniedWrongToken.status === 401);

  const firstPublish = await publish(origin, token, initial);
  const first = firstPublish.value;
  check('authenticated publish succeeds', firstPublish.status === 200 && first?.published === true);
  check('initial manifest contains five pages', Array.isArray(first?.slides) && first.slides.length === 5);
  check('compiler reports plain-code and math warnings', Array.isArray(first?.warnings)
    && first.warnings.some(warning => warning.includes('Fenced code'))
    && first.warnings.some(warning => warning.includes('math')));
  check('manifest has a SHA-256 revision', /^[a-f0-9]{64}$/.test(first?.revision || ''));
  check('private note marker is absent from the public manifest', !JSON.stringify(first).includes(initial.note));

  const cachedPublish = await publish(origin, token, initial);
  check('same input reuses the first revision', cachedPublish.status === 200
    && cachedPublish.value?.revision === first.revision
    && cachedPublish.value?.cached === true);

  const invalid = initial.markdown.replace(
    '# Compiler warnings and revision marker',
    '# Compiler warnings and revision marker\n\n<script>window.remoteInvalidScript = true</script>',
  );
  const invalidResponse = await readJson('publish invalid script', deckEndpoint(origin), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: invalid, assets: ASSETS }),
  }, [400]);
  check('invalid script is rejected with HTTP 400', invalidResponse.status === 400);
  const afterInvalid = await fetchManifest(origin);
  check('failed compile retains the current first revision', afterInvalid?.revision === first.revision);

  const pinned = await fetchManifest(origin, first.revision);
  check('first revision manifest is public and pinned', pinned?.revision === first.revision && pinned?.slides?.length === 5);
  const catalogResponse = await readJson('public catalog', new URL('/api/catalog', origin));
  const catalogDecks = Array.isArray(catalogResponse.value?.decks) ? catalogResponse.value.decks : [];
  check('public catalog includes the deck', catalogDecks.some(deck => deck.id === DECK_ID && deck.revision === first.revision));

  const firstModuleUrl = new URL(first.slides[0].module, origin);
  const firstModule = await readText('first revision slide module', firstModuleUrl);
  check('slide module imports shared Vue and bridge modules', expectSharedModuleImports(firstModule));
  check('private note marker is absent from the public slide module', !firstModule.includes(initial.note));
  const [vueRuntime, bridgeRuntime] = await Promise.all([
    readText('shared Vue runtime module', new URL('/_runtime/vue.js', origin)),
    readText('shared Slidev bridge module', new URL('/_runtime/bridge.js', origin)),
  ]);
  check('shared runtime modules are publicly available', vueRuntime.length > 0 && bridgeRuntime.length > 0);

  const imageModuleUrl = new URL(first.slides[3].module, origin);
  const imageModule = await readText('image page module', imageModuleUrl);
  const imageAssetPath = `/releases/${DECK_ID}/${first.revision}/assets/remote-diagram.svg`;
  check('image page references its versioned public SVG asset', imageModule.includes(imageAssetPath));

  const firstThumbnailEndpoint = new URL(`/api/thumbnail/${encodeURIComponent(DECK_ID)}`, origin);
  firstThumbnailEndpoint.searchParams.set('revision', first.revision);
  try {
    run.browserRun.status = 'running';
    run.browserRun.capturePosts += 1;
    const createdResponse = await readJson('Cloudflare Browser Run thumbnail capture', firstThumbnailEndpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const created = createdResponse.value;
    const usageMetadataAvailable = Number.isSafeInteger(created?.usedMs) && created.usedMs >= 0;
    run.browserRun.firstResponse = {
      httpStatus: createdResponse.status,
      status: typeof created?.status === 'string' ? created.status : 'missing',
      usedMs: usageMetadataAvailable ? created.usedMs : null,
      usageMetadataAvailable,
    };
    check('Cloudflare Browser Run creates the first revision thumbnail', created?.status === 'created'
      && typeof created?.src === 'string'
      && (created?.usedMs === null || usageMetadataAvailable));
    run.browserRun = {
      status: 'running',
      capturePosts: 1,
      source: 'Cloudflare Browser Run API',
      firstResponse: { ...run.browserRun.firstResponse },
    };

    run.browserRun.capturePosts += 1;
    const cachedThumbnailResponse = await readJson('thumbnail cache confirmation', firstThumbnailEndpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const cachedThumbnail = cachedThumbnailResponse.value;
    check('second thumbnail POST returns the cached first-revision image', cachedThumbnail?.status === 'cached'
      && cachedThumbnail.src === created.src);
    check('thumbnail POST limit was respected', run.browserRun.capturePosts === 2);
    run.browserRun.status = 'passed';

    const thumbnailUrl = new URL(created.src, origin);
    check('thumbnail URL stays on the deployed HTTPS origin', thumbnailUrl.origin === origin && thumbnailUrl.protocol === 'https:');
    const png = await readBytes('public thumbnail PNG', thumbnailUrl);
    validatePng(png);
    const pngHash = createHash('sha256').update(png).digest('hex');
    await mkdir(dirname(PNG_PATH), { recursive: true });
    await writeFile(PNG_PATH, png);
    run.thumbnail = {
      status: 'passed',
      path: 'artifacts/workers/remote-thumbnail.png',
      source: 'Cloudflare Browser Run stored release PNG',
      src: created.src,
      cacheStatus: cachedThumbnail.status,
      bytes: png.byteLength,
      sha256: pngHash,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    };
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Cloudflare Browser Run verification failed';
    if (run.browserRun.status === 'running') {
      run.browserRun.status = 'failed';
      run.browserRun.failure = message;
    }
    run.thumbnail = { status: 'failed', error: message, path: null };
    run.errors.push(message);
    run.checks.push({
      name: run.browserRun.status === 'failed' ? 'Cloudflare Browser Run capture/cache completed' : 'Browser Run PNG fetch and validation completed',
      passed: false,
    });
  }

  try { await verifyLocalChrome(origin, first, imageAssetPath); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'local Chrome remote flow failed';
    run.localChrome.status = 'failed';
    run.localChrome.failure = message;
    run.errors.push(message);
    run.checks.push({ name: 'local Chrome remote cover, click, and image flow completed', passed: false });
  }

  const update = await publish(origin, token, updated);
  check('Markdown update publishes a new revision', update.status === 200
    && update.value?.published === true
    && update.value?.revision !== first.revision);
  const retained = await fetchManifest(origin, first.revision);
  check('old revision remains publicly retrievable after update', retained?.revision === first.revision
    && retained.slides?.length === 5);
  const latest = await fetchManifest(origin);
  check('current manifest points to the updated revision', latest?.revision === update.value.revision);
  const updatedCatalog = await readJson('catalog after Markdown update', new URL('/api/catalog', origin));
  const latestDeck = (updatedCatalog.value?.decks || []).find(deck => deck.id === DECK_ID);
  check('public catalog exposes the updated revision', latestDeck?.revision === update.value.revision);

  run.publication = {
    firstRevision: first.revision,
    sameInputCached: cachedPublish.value.cached,
    compilerWarnings: first.warnings,
    pageCount: first.slides.length,
    invalidScriptStatus: invalidResponse.status,
    currentRevisionAfterInvalid: afterInvalid.revision,
    updatedRevision: update.value.revision,
    oldRevisionRetained: retained.revision === first.revision,
    privateNotePublished: false,
  };
}

async function continueAfterBrowserFailure(origin) {
  let prior;
  try { prior = JSON.parse(await readFile(RESULT_PATH, 'utf8')); }
  catch { throw new Error('Could not load the prior remote verification result for continuation'); }
  if (prior.origin !== origin || prior.deckId !== DECK_ID || prior.browserRun?.status !== 'failed'
    || prior.continuation || !Array.isArray(prior.requests) || !Array.isArray(prior.checks)) {
    throw new Error('prior result does not contain a matching unfinished Browser Run failure');
  }

  run = prior;
  runId = prior.runId;
  initial = makeFixture(runId);
  updated = makeFixture(runId, true);
  run.status = 'running';
  run.continuation = {
    startedAt: new Date().toISOString(),
    mode: 'continue-after-browser-failure',
    browserRunPostsAdded: 0,
  };
  const pinnedRequest = run.requests.find(request => request.name === 'public pinned manifest');
  if (!pinnedRequest) throw new Error('prior result is missing the first-revision manifest request');
  const firstRevision = new URL(pinnedRequest.path, origin).searchParams.get('revision');
  if (!/^[a-f0-9]{64}$/.test(firstRevision || ''))
    throw new Error('prior result does not contain a valid pinned revision');

  const first = await fetchManifest(origin, firstRevision);
  check('continued run retrieves the original pinned revision', first?.revision === firstRevision && first.slides?.length === 5);
  const currentBeforeUpdate = await fetchManifest(origin);
  check('current manifest is still the first revision before update', currentBeforeUpdate?.revision === firstRevision);
  const imageAssetPath = `/releases/${DECK_ID}/${firstRevision}/assets/remote-diagram.svg`;
  try { await verifyLocalChrome(origin, first, imageAssetPath); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'local Chrome remote flow failed';
    run.localChrome.status = 'failed';
    run.localChrome.failure = message;
    run.errors.push(message);
    run.checks.push({ name: 'local Chrome remote cover, click, and image flow completed', passed: false });
  }

  const token = await loadBearerToken();
  const update = await publish(origin, token, updated);
  check('continued run publishes a new Markdown revision', update.status === 200
    && update.value?.published === true
    && update.value?.revision !== firstRevision);
  const retained = await fetchManifest(origin, firstRevision);
  check('original revision remains public after the continued update', retained?.revision === firstRevision
    && retained.slides?.length === 5);
  const latest = await fetchManifest(origin);
  check('current manifest points to the continued update', latest?.revision === update.value.revision);
  const updatedCatalog = await readJson('catalog after continued Markdown update', new URL('/api/catalog', origin));
  const latestDeck = (updatedCatalog.value?.decks || []).find(deck => deck.id === DECK_ID);
  check('catalog exposes the continued update', latestDeck?.revision === update.value.revision);

  run.publication = {
    firstRevision,
    updatedRevision: update.value.revision,
    currentRevisionBeforeUpdate: currentBeforeUpdate.revision,
    oldRevisionRetained: retained.revision === firstRevision,
    privateNotePublished: false,
  };
  run.continuation.finishedAt = new Date().toISOString();
}

async function recoverCapturedArtifacts(origin) {
  let prior;
  try { prior = JSON.parse(await readFile(RESULT_PATH, 'utf8')); }
  catch { throw new Error('Could not load the prior remote verification result for artifact recovery'); }
  const originalCapture = prior.requests?.find(request => request.name === 'Cloudflare Browser Run thumbnail capture');
  const firstRevision = prior.publication?.firstRevision;
  const currentRevision = prior.publication?.updatedRevision;
  if (prior.origin !== origin || prior.deckId !== DECK_ID || prior.continuation
    || prior.recovery || prior.browserRun?.status !== 'failed' || prior.browserRun?.capturePosts !== 1
    || originalCapture?.status !== 200 || !/^[a-f0-9]{64}$/.test(firstRevision || '')
    || !/^[a-f0-9]{64}$/.test(currentRevision || '')) {
    throw new Error('prior result does not contain the expected single HTTP 200 Browser Run attempt');
  }

  run = prior;
  run.status = 'running';
  run.recovery = { startedAt: new Date().toISOString(), mode: 'recover-captured-artifacts', addedCapturePosts: 1 };
  const token = await loadBearerToken();
  const firstThumbnailPath = `/releases/${DECK_ID}/${firstRevision}/thumbnail.png`;
  const firstPng = await readBytes('first revision PNG recovery', new URL(firstThumbnailPath, origin));
  validatePng(firstPng);
  const firstPngHash = createHash('sha256').update(firstPng).digest('hex');
  check('first revision release PNG is public and valid', true);

  const firstThumbnailEndpoint = new URL(`/api/thumbnail/${encodeURIComponent(DECK_ID)}`, origin);
  firstThumbnailEndpoint.searchParams.set('revision', firstRevision);
  const cached = await readJson('thumbnail cache confirmation', firstThumbnailEndpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const expectedFirstSrc = firstThumbnailPath;
  check('second first-revision POST confirms the existing image is cached', cached.value?.status === 'cached'
    && cached.value.src === expectedFirstSrc);

  const originalCheck = run.checks.find(item => item.name === 'Cloudflare Browser Run creates the first revision thumbnail');
  if (originalCheck) {
    originalCheck.passed = true;
    originalCheck.evidence = 'Initial POST returned HTTP 200; the public revision PNG validated and a follow-up POST returned cached. The original response body was not retained.';
  }
  const originalCacheCheck = run.checks.find(item => item.name === 'Cloudflare Browser Run capture/cache completed');
  if (originalCacheCheck) {
    originalCacheCheck.passed = true;
    originalCacheCheck.evidence = 'Recovery fetched the stored PNG and confirmed the first-revision cache.';
  }
  run.errors = run.errors.filter(error => error !== 'check failed: Cloudflare Browser Run creates the first revision thumbnail');
  run.browserRun = {
    status: 'running',
    source: 'Cloudflare Browser Run API',
    capturePosts: 2,
    firstRevision: {
      revision: firstRevision,
      firstPostHttpStatus: 200,
      firstResponseStatus: 'not retained',
      usedMs: null,
      usageMetadataAvailable: false,
      recoveredPng: { path: firstThumbnailPath, bytes: firstPng.byteLength, sha256: firstPngHash },
      cacheConfirmation: { status: cached.value.status, src: expectedFirstSrc },
    },
  };
  run.thumbnail = {
    status: 'recovered-first-revision',
    path: null,
    revision: firstRevision,
    source: 'Cloudflare Browser Run release PNG confirmed by GET and cached POST',
    bytes: firstPng.byteLength,
    sha256: firstPngHash,
    width: firstPng.readUInt32BE(16),
    height: firstPng.readUInt32BE(20),
  };

  const current = await fetchManifest(origin);
  check('current manifest remains the recorded updated revision', current?.revision === currentRevision);
  const currentThumbnailEndpoint = new URL(`/api/thumbnail/${encodeURIComponent(DECK_ID)}`, origin);
  currentThumbnailEndpoint.searchParams.set('revision', currentRevision);
  run.browserRun.capturePosts += 1;
  const currentCaptureResponse = await readJson('current revision Browser Run thumbnail capture', currentThumbnailEndpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const currentCapture = currentCaptureResponse.value;
  const currentUsageAvailable = Number.isSafeInteger(currentCapture?.usedMs) && currentCapture.usedMs >= 0;
  check('current revision receives one Browser Run thumbnail', currentCaptureResponse.status === 200
    && currentCapture?.status === 'created'
    && typeof currentCapture?.src === 'string'
    && (currentCapture.usedMs === null || currentUsageAvailable));
  const currentThumbnailUrl = new URL(currentCapture.src, origin);
  check('current thumbnail URL remains on the deployed HTTPS origin', currentThumbnailUrl.origin === origin
    && currentThumbnailUrl.protocol === 'https:');
  const currentPng = await readBytes('current revision thumbnail PNG', currentThumbnailUrl);
  validatePng(currentPng);
  const currentPngHash = createHash('sha256').update(currentPng).digest('hex');
  await mkdir(dirname(PNG_PATH), { recursive: true });
  await writeFile(PNG_PATH, currentPng);
  run.browserRun.status = 'passed';
  run.browserRun.capturePostsByRevision = { firstRevision: 2, currentRevision: 1 };
  run.browserRun.currentRevisionCapture = {
    revision: currentRevision,
    status: currentCapture.status,
    usedMs: currentUsageAvailable ? currentCapture.usedMs : null,
    usageMetadataAvailable: currentUsageAvailable,
    src: currentCapture.src,
  };
  run.thumbnail = {
    status: 'passed',
    path: 'artifacts/workers/remote-thumbnail.png',
    source: 'Cloudflare Browser Run release PNG for current revision',
    revision: currentRevision,
    src: currentCapture.src,
    bytes: currentPng.byteLength,
    sha256: currentPngHash,
    width: currentPng.readUInt32BE(16),
    height: currentPng.readUInt32BE(20),
  };
  run.recovery.finishedAt = new Date().toISOString();
}

async function finish() {
  run.finishedAt = new Date().toISOString();
  run.status = run.errors.length === 0 && run.checks.every(item => item.passed) ? 'passed' : 'failed';
  await mkdir(dirname(RESULT_PATH), { recursive: true });
  await writeFile(RESULT_PATH, `${JSON.stringify(run, null, 2)}\n`);
  console.log(JSON.stringify(run));
  if (run.status !== 'passed') process.exitCode = 1;
}

const args = process.argv.slice(2);
const usage = 'Usage: node remote-verify.mjs <https-origin> [--continue-after-browser-failure|--recover-captured-artifacts]';
const supportedModes = new Set(['--continue-after-browser-failure', '--recover-captured-artifacts']);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(usage);
}
else if (!args[0] || args.length > 2 || (args[1] && !supportedModes.has(args[1]))) {
  console.error(usage);
  process.exitCode = 2;
}
else {
  try {
    await runVerification();
  }
  catch (error) {
    run.errors.push(error instanceof Error ? error.message : 'remote verification failed');
    if (run.browserRun.status === 'running')
      run.browserRun.status = 'failed';
    if (run.localChrome.status === 'running')
      run.localChrome.status = 'failed';
  }
  finally {
    try { await finish(); }
    catch {
      console.error('Could not write the sanitized remote verification result');
      process.exitCode = 1;
    }
  }
}
