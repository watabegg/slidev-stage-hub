import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePng } from './thumbnail.mjs';

const DEFAULT_THEME = '/home/watabegg/slidev-watabegg';
const DEFAULT_CHROMIUM_PATH = '/usr/bin/google-chrome';
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const SLIDE_SELECTOR = '.slidev-page[data-slidev-no="1"]';
export const THUMBNAIL_READY_SELECTOR = `${SLIDE_SELECTOR} [data-lab-slide-ready="1"]`;
const VIEWPORT_WIDTH = 1200;
const VIEWPORT_HEIGHT = 675;
const WAIT_TIMEOUT_MS = 30_000;
const VALID_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;
const VALID_REVISION = /^[a-f0-9]{64}$/u;

function fail(message) {
  return new Error(message);
}

function parseOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw fail('origin must be a valid HTTP or HTTPS origin'); }

  if (!['http:', 'https:'].includes(url.protocol)
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.username
    || url.password) {
    throw fail('origin must be a valid HTTP or HTTPS origin without a path or credentials');
  }
  return url.origin;
}

function loadChromium() {
  const themePath = process.env.SLIDEV_THEME_PATH || DEFAULT_THEME;
  const themeRequire = createRequire(resolve(themePath, 'package.json'));
  try {
    return themeRequire('playwright-chromium').chromium;
  } catch {
    throw fail('Could not load playwright-chromium from the configured local Slidev theme');
  }
}

function deckEndpoint(origin, deckId, revision) {
  const endpoint = new URL(`/api/decks/${encodeURIComponent(deckId)}`, origin);
  if (revision) endpoint.searchParams.set('revision', revision);
  return endpoint;
}

async function fetchDeck(origin, deckId, revision) {
  let response;
  try { response = await fetch(deckEndpoint(origin, deckId, revision)); }
  catch { throw fail('Could not request deck metadata from the local Worker'); }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw fail(`Deck metadata request failed (HTTP ${response.status})`);
  }

  let manifest;
  try { manifest = await response.json(); }
  catch { throw fail('The local Worker returned invalid deck metadata'); }
  if (typeof manifest?.entry !== 'string' || !VALID_REVISION.test(manifest.revision || '')) {
    throw fail('The local Worker returned incomplete deck metadata');
  }
  if (revision && manifest.revision !== revision) {
    throw fail('The local Worker returned a different deck revision');
  }

  let entry;
  try { entry = new URL(manifest.entry, origin); }
  catch { throw fail('The local Worker returned an invalid deck entry'); }
  const expectedPath = `/${deckId.split('/').map(encodeURIComponent).join('/')}/1`;
  if (entry.origin !== origin
    || entry.pathname !== expectedPath
    || entry.searchParams.get('revision') !== manifest.revision) {
    throw fail('The local Worker returned an unexpected deck entry');
  }
  entry.searchParams.set('embedded', 'true');
  entry.searchParams.set('labThumbnail', 'true');
  return { entry, revision: manifest.revision };
}

export async function waitForRenderedSlide(page) {
  await page.locator(SLIDE_SELECTOR).waitFor({ state: 'visible', timeout: WAIT_TIMEOUT_MS });
  await page.locator(THUMBNAIL_READY_SELECTOR).waitFor({ state: 'visible', timeout: WAIT_TIMEOUT_MS });
  await page.waitForFunction(selector => {
    const renderedLayout = document.querySelector(selector);
    if (!renderedLayout) return false;
    const rect = renderedLayout.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, THUMBNAIL_READY_SELECTOR, { timeout: WAIT_TIMEOUT_MS });

  await page.waitForFunction(
    () => document.fonts.ready.then(() => document.fonts.status === 'loaded'),
    null,
    { timeout: WAIT_TIMEOUT_MS },
  );

  const imageResult = await page.locator(THUMBNAIL_READY_SELECTOR).evaluate(async (renderedLayout, timeoutMs) => {
    const images = [...renderedLayout.querySelectorAll('img')];
    let timer;
    try {
      return await Promise.race([
        Promise.all(images.map(image => image.decode()))
          .then(() => ({ failedImage: null }))
          .catch(() => {
            const failedImage = images.find(image => image.complete && image.naturalWidth === 0);
            return { failedImage: failedImage?.alt || failedImage?.currentSrc || 'unknown image' };
          }),
        new Promise(resolveTimeout => {
          timer = setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }, WAIT_TIMEOUT_MS);
  if (imageResult.timedOut)
    throw fail('Timed out waiting for slide images to decode');
  if (imageResult.failedImage)
    throw fail(`Slide image failed to decode: ${imageResult.failedImage}`);
}

async function captureLocalPng(chromium, entry) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE || DEFAULT_CHROMIUM_PATH,
    });
  } catch {
    throw fail('Could not launch local Chromium; check CHROMIUM_EXECUTABLE');
  }

  let context;
  try {
    context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
    const page = await context.newPage();
    let response;
    try { response = await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: WAIT_TIMEOUT_MS }); }
    catch { throw fail('Local Chromium could not open the deck entry'); }
    if (!response || response.status() >= 400) {
      throw fail(`Deck entry request failed${response ? ` (HTTP ${response.status()})` : ''}`);
    }

    await waitForRenderedSlide(page);
    const bytes = await page.locator(SLIDE_SELECTOR).screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
    if (bytes.byteLength > MAX_PNG_BYTES) throw fail('Thumbnail exceeded the 4 MiB limit');
    validatePng(bytes);
    return bytes;
  } finally {
    try { await context?.close(); }
    catch { /* Preserve the capture result or failure. */ }
    try { await browser.close(); }
    catch { /* Preserve the capture result or failure. */ }
  }
}

async function uploadThumbnail(origin, deckId, revision, bytes) {
  const endpoint = new URL(`/api/thumbnail/${encodeURIComponent(deckId)}`, origin);
  endpoint.searchParams.set('revision', revision);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
  } catch {
    throw fail('Could not upload the thumbnail to the local Worker');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw fail(`Thumbnail upload failed (HTTP ${response.status})`);
  }

  let result;
  try { result = await response.json(); }
  catch { throw fail('The local Worker returned an invalid thumbnail response'); }
  if (typeof result?.src !== 'string' || result.src.length === 0) {
    throw fail('The local Worker did not return a thumbnail URL');
  }
  return result.src;
}

async function main(args = process.argv.slice(2)) {
  const [originInput, deckId, revision, ...extra] = args;
  if (!originInput || !deckId || extra.length || args.length < 2 || args.length > 3) {
    throw fail('Usage: node local-thumbnail.mjs <origin> <deckId> [revision]');
  }
  if (!VALID_ID.test(deckId)) throw fail('deckId must contain only letters, digits, underscores, or hyphens in slash-separated segments');
  if (revision !== undefined && !VALID_REVISION.test(revision)) throw fail('revision must be a 64-character lowercase SHA-256 hex value');

  const startedAt = performance.now();
  const origin = parseOrigin(originInput);
  const deck = await fetchDeck(origin, deckId, revision);
  const bytes = await captureLocalPng(loadChromium(), deck.entry);
  const src = await uploadThumbnail(origin, deckId, deck.revision, bytes);
  console.log(JSON.stringify({
    src,
    revision: deck.revision,
    elapsedMs: Math.round(performance.now() - startedAt),
    backend: 'local-chromium',
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
