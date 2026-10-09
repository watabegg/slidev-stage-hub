import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { captureThumbnail } from './thumbnail.mjs';
import { artifactRoot, startHarness } from './harness.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RESULT_PATH = resolve(ROOT, 'results/thumbnail-experiments.json');
const DEFAULT_THEME = '/home/watabegg/slidev-watabegg';
const CHROMIUM_PATH = process.env.CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome';
const SLIDE_SELECTOR = '.slidev-page[data-slidev-no="1"]';
const THEME_PATH = process.env.SLIDEV_THEME_PATH || DEFAULT_THEME;
const THEME_REQUIRE = createRequire(resolve(THEME_PATH, 'package.json'));
const chromium = THEME_REQUIRE('playwright-chromium').chromium;
const execFileAsync = promisify(execFile);

const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const requestedOrigin = process.argv[2] || null;
let origin = requestedOrigin;
let ownedHarness = null;
const records = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  command: `node thumbnail-experiments.mjs${requestedOrigin ? ` ${requestedOrigin}` : ''}`,
  environment: {
    node: process.version,
    chromiumPath: CHROMIUM_PATH,
    themePath: THEME_PATH,
    harness: requestedOrigin ? 'explicit-origin' : 'isolated-miniflare',
    origin: requestedOrigin,
  },
  experiments: [],
  browserRunAdapterMocks: [],
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function responseJson(response) {
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function publish(id, markdown, assets = {}) {
  const response = await fetch(new URL(`/api/decks/${encodeURIComponent(id)}`, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown, assets }),
  });
  const { status, body } = await responseJson(response);
  assert.equal(response.ok, true, `publish failed for ${id}: HTTP ${status} ${JSON.stringify(body)}`);
  return body;
}

async function getManifest(id, revision) {
  const endpoint = new URL(`/api/decks/${encodeURIComponent(id)}`, origin);
  if (revision) endpoint.searchParams.set('revision', revision);
  const response = await fetch(endpoint);
  const { status, body } = await responseJson(response);
  assert.equal(response.ok, true, `manifest fetch failed for ${id}: HTTP ${status}`);
  return body;
}

async function runLocalThumbnail(id, revision) {
  const cliPath = resolve(ROOT, 'local-thumbnail.mjs');
  const args = [cliPath, origin, id];
  if (revision) args.push(revision);
  let stdout = '';
  let stderr = '';
  let status = 0;
  let signal = null;
  let timedOut = false;
  try {
    const result = await execFileAsync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        SLIDEV_THEME_PATH: THEME_PATH,
        CHROMIUM_EXECUTABLE: CHROMIUM_PATH,
      },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = error.stdout || '';
    stderr = error.stderr || '';
    signal = error.signal || null;
    status = typeof error.code === 'number' ? error.code : null;
    timedOut = error.code === 'ETIMEDOUT';
  }
  let parsed = null;
  if (stdout.trim()) {
    try { parsed = JSON.parse(stdout.trim()); }
    catch { /* Preserve raw output as experimental evidence. */ }
  }
  return {
    command: `node local-thumbnail.mjs ${origin} ${id}${revision ? ` ${revision}` : ''}`,
    status,
    signal,
    timedOut,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    parsed,
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  type.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return output;
}

function solidPng(width, height, [red, green, blue, alpha]) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      scanlines[pixel] = red;
      scanlines[pixel + 1] = green;
      scanlines[pixel + 2] = blue;
      scanlines[pixel + 3] = alpha;
    }
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function parsePngDimensions(bytes) {
  if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function fetchBytes(url) {
  const response = await fetch(new URL(url, origin));
  assert.equal(response.ok, true, `thumbnail fetch failed: HTTP ${response.status}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), cacheControl: response.headers.get('cache-control') };
}

async function browserProbe(entry, { routeModulePath, routeDelayMs = 0, imagePath, expectedHeading } = {}) {
  let browser;
  let context;
  const result = { routeModulePath: null, routeDelayMs: 0, imageDecode: null };
  try {
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH });
    context = await browser.newContext({ viewport: { width: 1200, height: 675 } });
    const page = await context.newPage();
    const moduleObservations = [];
    if (routeModulePath) {
      await page.route(url => new URL(url).pathname === routeModulePath, async route => {
        const started = performance.now();
        await delay(routeDelayMs);
        await route.continue();
        moduleObservations.push(Math.round(performance.now() - started));
      });
    }
    await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator(SLIDE_SELECTOR).waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator(`${SLIDE_SELECTOR} .slidev-layout`).waitFor({ state: 'visible', timeout: 30_000 });
    if (expectedHeading)
      await page.getByText(expectedHeading, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    if (imagePath) {
      const image = page.locator(`${SLIDE_SELECTOR} img`).first();
      await image.waitFor({ state: 'attached', timeout: 10_000 });
      result.imageDecode = await image.evaluate(async element => {
        try {
          await element.decode();
          return {
            resolved: true,
            naturalWidth: element.naturalWidth,
            naturalHeight: element.naturalHeight,
            currentSrc: element.currentSrc,
          };
        } catch (error) {
          return { resolved: false, errorName: error?.name || 'Error' };
        }
      });
    }
    if (routeModulePath) {
      await page.getByText('Thumbnail experiment heading', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      result.routeModulePath = routeModulePath;
      result.routeDelayMs = moduleObservations.at(-1) ?? 0;
      result.headingVisible = true;
    }
    return result;
  } finally {
    try { await context?.close(); } catch { /* Keep the browser evidence. */ }
    try { await browser?.close(); } catch { /* Keep the browser evidence. */ }
  }
}

async function runBrowserRunMocks() {
  const cases = [
    {
      name: 'unbound',
      browser: null,
      expectedCode: 'BROWSER_UNAVAILABLE',
    },
    {
      name: 'upstream-http-429',
      browser: { quickAction: async () => new Response('private limit response', { status: 429 }) },
      expectedCode: 'BROWSER_LIMIT',
    },
    {
      name: 'upstream-thrown-failure',
      browser: { quickAction: async () => { throw new Error('private upstream error'); } },
      expectedCode: 'BROWSER_FAILED',
    },
  ];
  for (const item of cases) {
    let observedCode = null;
    let message = '';
    try {
      await captureThumbnail({ browser: item.browser, url: 'https://mock.invalid/deck/1' });
    } catch (error) {
      observedCode = error?.code || null;
      message = error?.message || String(error);
    }
    records.browserRunAdapterMocks.push({
      name: item.name,
      expectedCode: item.expectedCode,
      observedCode,
      message,
      matched: observedCode === item.expectedCode,
    });
  }
}

async function main() {
  if (!origin) {
    ownedHarness = await startHarness({
      port: 0,
      persist: false,
      workerPath: resolve(artifactRoot, `thumbnail-worker-${process.pid}.mjs`),
    });
    origin = ownedHarness.origin;
  }
  records.environment.origin = origin;

  const health = await fetch(origin);
  records.environment.serverStatus = health.status;
  assert.equal(health.ok, true, `local server unavailable at ${origin}`);

  const mainId = `experiments/thumb-cover-${runId}`;
  const heading = 'Thumbnail experiment heading';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" rx="16" fill="#163a2c"/><circle cx="120" cy="60" r="34" fill="#7fe0bb"/></svg>';
  const coverMarkdown = `---\ntitle: Thumbnail experiment heading\ntheme: watabegg\nlayout: default\n---\n\n# ${heading}\n\n![SVG cover](./cover.svg)\n\n---\n\n# Delayed module slide\n`;
  const coverManifest = await publish(mainId, coverMarkdown, { 'cover.svg': svg });
  const coverCli = await runLocalThumbnail(mainId);
  const coverObservation = {
    id: 'real-cli-heading-svg-cover',
    deckId: mainId,
    revision: coverManifest.revision,
    command: coverCli.command,
    cliStatus: coverCli.status,
    cliTimedOut: coverCli.timedOut,
    cliStderr: coverCli.stderr,
    cliOutput: coverCli.parsed,
    expectedHeading: heading,
    svgAsset: 'cover.svg',
    cliSucceeded: coverCli.status === 0 && coverCli.parsed?.backend === 'local-chromium',
  };
  records.experiments.push(coverObservation);
  assert.equal(coverObservation.cliSucceeded, true, `local-thumbnail failed: ${coverCli.stderr}`);

  const firstThumb = await fetchBytes(coverCli.parsed.src);
  const firstThumbHash = sha256(firstThumb.bytes);
  coverObservation.png = {
    dimensions: parsePngDimensions(firstThumb.bytes),
    bytes: firstThumb.bytes.length,
    sha256: firstThumbHash,
    cacheControl: firstThumb.cacheControl,
  };
  const modulePath = `/releases/${mainId}/${coverManifest.revision}/1.js`;
  const routedEntry = new URL(coverManifest.entry, origin);
  routedEntry.searchParams.set('embedded', 'true');
  routedEntry.searchParams.set('labThumbnail', 'true');
  const routedProbe = await browserProbe(routedEntry.href, {
    routeModulePath: modulePath,
    routeDelayMs: 650,
    imagePath: 'cover.svg',
  });
  coverObservation.renderProbe = {
    headingRendered: routedProbe.headingVisible,
    svgDecoded: routedProbe.imageDecode?.resolved === true,
    svgNaturalDimensions: routedProbe.imageDecode
      ? { width: routedProbe.imageDecode.naturalWidth, height: routedProbe.imageDecode.naturalHeight }
      : null,
  };
  const dynamicLoadObservation = {
    id: 'playwright-delayed-dynamic-slide-module',
    deckId: mainId,
    revision: coverManifest.revision,
    routePath: routedProbe.routeModulePath,
    requestedDelayMs: 650,
    observedDelayMs: routedProbe.routeDelayMs,
    headingRenderedAfterRoute: routedProbe.headingVisible,
    delayApplied: routedProbe.routeDelayMs >= 600,
  };
  records.experiments.push(dynamicLoadObservation);

  const invalidId = `experiments/thumb-invalid-png-${runId}`;
  const invalidManifest = await publish(invalidId, `---\ntitle: Invalid upload\ntheme: watabegg\nlayout: cover\n---\n\n# Invalid upload\n`);
  const invalidEndpoint = new URL(`/api/thumbnail/${encodeURIComponent(invalidId)}`, origin);
  invalidEndpoint.searchParams.set('revision', invalidManifest.revision);
  const invalidResponse = await fetch(invalidEndpoint, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('not a PNG'),
  });
  const invalidBody = await invalidResponse.json().catch(() => null);
  const invalidStored = await fetch(new URL(`/releases/${invalidId}/${invalidManifest.revision}/thumbnail.png`, origin));
  records.experiments.push({
    id: 'png-invalid-upload-rejected',
    deckId: invalidId,
    revision: invalidManifest.revision,
    uploadStatus: invalidResponse.status,
    response: invalidBody,
    thumbnailAfterRejectStatus: invalidStored.status,
    rejectedWithoutStore: !invalidResponse.ok && invalidStored.status === 404,
  });

  const wrongDimensionId = `experiments/thumb-wrong-dim-${runId}`;
  const wrongDimensionManifest = await publish(wrongDimensionId, `---\ntitle: Wrong dimension\ntheme: watabegg\nlayout: cover\n---\n\n# Wrong dimension\n`);
  const wrongDimensionEndpoint = new URL(`/api/thumbnail/${encodeURIComponent(wrongDimensionId)}`, origin);
  wrongDimensionEndpoint.searchParams.set('revision', wrongDimensionManifest.revision);
  const wrongDimensionPng = solidPng(980, 551, [10, 20, 30, 255]);
  const wrongDimensionResponse = await fetch(wrongDimensionEndpoint, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: wrongDimensionPng,
  });
  const wrongDimensionBody = await wrongDimensionResponse.json().catch(() => null);
  const wrongDimensionStored = await fetch(new URL(`/releases/${wrongDimensionId}/${wrongDimensionManifest.revision}/thumbnail.png`, origin));
  records.experiments.push({
    id: 'valid-png-wrong-dimensions-rejected',
    deckId: wrongDimensionId,
    revision: wrongDimensionManifest.revision,
    attemptedDimensions: parsePngDimensions(wrongDimensionPng),
    uploadStatus: wrongDimensionResponse.status,
    response: wrongDimensionBody,
    thumbnailAfterRejectStatus: wrongDimensionStored.status,
    rejectedWithoutStore: !wrongDimensionResponse.ok && wrongDimensionStored.status === 404,
  });

  const badImageId = `experiments/thumb-bad-image-${runId}`;
  const badImageSvg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100">';
  const badImageMarkdown = `---\ntitle: Broken image decode\ntheme: watabegg\nlayout: default\n---\n\n# Broken image decode\n\n![broken](./broken.svg)\n`;
  const badImageManifest = await publish(badImageId, badImageMarkdown, { 'broken.svg': badImageSvg });
  const badEntry = new URL(badImageManifest.entry, origin);
  badEntry.searchParams.set('embedded', 'true');
  badEntry.searchParams.set('labThumbnail', 'true');
  const decodeProbe = await browserProbe(badEntry.href, {
    imagePath: 'broken.svg',
    expectedHeading: 'Broken image decode',
  });
  const badImageCli = await runLocalThumbnail(badImageId);
  const badImageThumbnail = await fetch(
    new URL(`/releases/${badImageId}/${badImageManifest.revision}/thumbnail.png`, origin),
  );
  records.experiments.push({
    id: 'real-cli-image-decode-failure',
    deckId: badImageId,
    revision: badImageManifest.revision,
    decodeProbe,
    command: badImageCli.command,
    cliStatus: badImageCli.status,
    cliTimedOut: badImageCli.timedOut,
    cliStderr: badImageCli.stderr,
    cliOutput: badImageCli.parsed,
    decodeRejected: decodeProbe.imageDecode?.resolved === false,
    cliRejectedCapture: badImageCli.status !== 0,
    cliErrorIsClear: badImageCli.stderr.includes('Slide image failed to decode'),
    thumbnailAfterFailureStatus: badImageThumbnail.status,
    rejectedWithoutUpload: badImageCli.status !== 0 && badImageThumbnail.status === 404,
  });

  const updatedMarkdown = `---\ntitle: Thumbnail experiment updated\ntheme: watabegg\nlayout: cover\n---\n\n# Updated markdown revision\n`;
  const updatedManifest = await publish(mainId, updatedMarkdown, {});
  const pinnedManifest = await getManifest(mainId, coverManifest.revision);
  const latestManifest = await getManifest(mainId);
  const oldThumbAfterUpdate = await fetchBytes(coverCli.parsed.src);
  const pinnedCli = await runLocalThumbnail(mainId, coverManifest.revision);
  const pinnedCliThumb = pinnedCli.parsed?.src ? await fetchBytes(pinnedCli.parsed.src) : null;
  const alternatePng = solidPng(1200, 675, [250, 0, 180, 255]);
  const repeatEndpoint = new URL(`/api/thumbnail/${encodeURIComponent(mainId)}`, origin);
  repeatEndpoint.searchParams.set('revision', coverManifest.revision);
  const repeatedUpload = await fetch(repeatEndpoint, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: alternatePng,
  });
  const repeatedBody = await repeatedUpload.json().catch(() => null);
  const thumbAfterRepeat = await fetchBytes(coverCli.parsed.src);
  const revisionObservation = {
    id: 'revision-pinning-and-immutable-thumbnail-cache',
    deckId: mainId,
    originalRevision: coverManifest.revision,
    updatedRevision: updatedManifest.revision,
    pinnedManifestRevision: pinnedManifest.revision,
    latestManifestRevision: latestManifest.revision,
    originalThumbnailHash: firstThumbHash,
    oldThumbnailHashAfterMarkdownUpdate: sha256(oldThumbAfterUpdate.bytes),
    pinnedCli: {
      status: pinnedCli.status,
      revision: pinnedCli.parsed?.revision || null,
      src: pinnedCli.parsed?.src || null,
      thumbnailHash: pinnedCliThumb ? sha256(pinnedCliThumb.bytes) : null,
    },
    alternateUpload: {
      status: repeatedUpload.status,
      response: repeatedBody,
      attemptedHash: sha256(alternatePng),
      cachedThumbnailHashAfterUpload: sha256(thumbAfterRepeat.bytes),
    },
    oldRevisionRemainsPinned: pinnedManifest.revision === coverManifest.revision
      && pinnedCli.parsed?.revision === coverManifest.revision,
    newCurrentRevisionPublished: latestManifest.revision === updatedManifest.revision
      && updatedManifest.revision !== coverManifest.revision,
    oldThumbnailSurvivedUpdate: sha256(oldThumbAfterUpdate.bytes) === firstThumbHash,
    repeatedUploadDidNotOverwrite: repeatedBody?.status === 'cached'
      && sha256(thumbAfterRepeat.bytes) === firstThumbHash
      && sha256(alternatePng) !== firstThumbHash,
    immutableCacheControl: firstThumb.cacheControl,
  };
  records.experiments.push(revisionObservation);

  await runBrowserRunMocks();
  records.finishedAt = new Date().toISOString();
  records.status = 'completed';
}

try {
  await main();
} catch (error) {
  records.finishedAt = new Date().toISOString();
  records.status = 'blocked';
  records.error = error?.stack || String(error);
  process.exitCode = 1;
} finally {
  if (ownedHarness) {
    try {
      await ownedHarness.mf.dispose();
      records.environment.harnessDisposed = true;
    } catch (error) {
      records.environment.harnessDisposeError = error?.message || String(error);
      if (records.status === 'completed') records.status = 'failed';
    }
  }
  await mkdir(dirname(RESULT_PATH), { recursive: true });
  await writeFile(RESULT_PATH, `${JSON.stringify(records, null, 2)}\n`);
  console.log(JSON.stringify({ resultPath: RESULT_PATH, status: records.status, runId }));
}
