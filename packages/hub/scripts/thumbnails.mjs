import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve.mjs';

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 675;
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const DEFAULT_THEME = '/home/watabegg/slidev-watabegg';
const CHROME_PATH = '/usr/bin/google-chrome';
const SLIDE_SELECTOR = '.slidev-page[data-slidev-no="1"]';
const URL_RESERVED = new Set(":/?#[]@!$&'()*+,;=%");

function loadChromium() {
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire('playwright-chromium').chromium;
  } catch (localError) {
    try {
      const themeRequire = createRequire(resolve(process.env.SLIDEV_THEME_PATH || DEFAULT_THEME, 'package.json'));
      return themeRequire('playwright-chromium').chromium;
    } catch (themeError) {
      throw new Error(
        `Could not load playwright-chromium from this project or ${process.env.SLIDEV_THEME_PATH || DEFAULT_THEME}: ${themeError.message}`,
        { cause: localError },
      );
    }
  }
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function splitSafeDeckId(id) {
  if (typeof id !== 'string') return null;
  const segments = id.split('/');
  if (!segments.length || segments.some(segment => (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(segment)
    || [...segment].some(character => URL_RESERVED.has(character))
  ))) return null;
  return segments;
}

function encodePathSegments(segments) {
  return segments.map(segment => encodeURIComponent(segment)).join('/');
}

function decodePathSegments(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  try {
    return pathname.slice(1).split('/').map(segment => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function sameSegments(actual, expected) {
  return actual !== null
    && actual.length === expected.length
    && actual.every((segment, index) => segment === expected[index]);
}

function validateDecks(manifest) {
  if (!Array.isArray(manifest?.decks) || manifest.decks.length === 0) {
    throw new Error('manifest.json must contain a non-empty decks array');
  }

  const ids = new Set();
  return manifest.decks.map((deck, index) => {
    const id = deck?.id;
    const segments = splitSafeDeckId(id);
    if (!segments) {
      throw new Error(`manifest.json deck ${index + 1} has an invalid id`);
    }
    if (ids.has(id)) throw new Error(`manifest.json contains duplicate deck id: ${id}`);
    ids.add(id);

    if (typeof deck.entry !== 'string' || !Number.isInteger(deck.pages) || deck.pages < 1) {
      throw new Error(`manifest.json deck ${id} must include an entry and a positive pages count`);
    }
    const expectedEntry = `/${encodePathSegments(segments)}/1`;
    let entry;
    try {
      entry = new URL(deck.entry, 'http://slidev-lab.invalid');
    } catch (error) {
      throw new Error(`manifest.json deck ${id} has an invalid entry: ${error.message}`);
    }
    if (entry.origin !== 'http://slidev-lab.invalid'
      || !sameSegments(decodePathSegments(entry.pathname), [...segments, '1'])) {
      throw new Error(`manifest.json deck ${id} entry must be ${expectedEntry}`);
    }

    const src = `/thumbnails/${encodePathSegments(segments)}.png`;
    if (deck.thumbnail?.src !== undefined && deck.thumbnail.src !== src) {
      throw new Error(`manifest.json deck ${id} thumbnail src must be ${src}`);
    }
    return { id, segments, src };
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
    server.closeAllConnections?.();
  });
}

async function closeQuietly(resource) {
  try { await resource?.close(); }
  catch { /* Preserve the generation error while still attempting cleanup. */ }
}

async function waitForRenderedSlide(page, id) {
  await page.locator(SLIDE_SELECTOR).waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(selector => {
    const slide = document.querySelector(selector);
    if (!slide) return false;
    const rect = slide.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, SLIDE_SELECTOR, { timeout: 30_000 });

  await page.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 30_000 });
  await page.waitForFunction(() => [...document.images].every(image => image.complete), null, { timeout: 30_000 });

  const state = await page.evaluate(selector => {
    const slide = document.querySelector(selector);
    return {
      images: [...document.images].map(image => ({
        src: image.currentSrc || image.src,
        complete: image.complete,
        width: image.naturalWidth,
      })),
      slideVisible: Boolean(slide && getComputedStyle(slide).display !== 'none'),
    };
  }, SLIDE_SELECTOR);

  if (!state.slideVisible) throw new Error(`deck ${id} first slide is not visible`);
  const brokenImages = state.images.filter(image => !image.complete || image.width === 0);
  if (brokenImages.length) {
    throw new Error(`deck ${id} has image load errors: ${brokenImages.map(image => image.src).join(', ')}`);
  }
}

async function generateDeckThumbnail({ browser, origin, root, deck, outputWidth, outputHeight }) {
  const context = await browser.newContext({ viewport: { width: outputWidth, height: outputHeight } });
  try {
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', error => failures.push(`page error: ${error.message}`));
    page.on('requestfailed', request => {
      failures.push(`request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText || 'unknown error'})`);
    });
    page.on('response', response => {
      if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`);
    });

    const routeSegments = [...deck.segments, '1'];
    const routePath = `/${encodePathSegments(routeSegments)}`;
    const route = new URL(routePath, origin);
    route.searchParams.set('embedded', 'true');
    route.searchParams.set('labThumbnail', 'true');
    const response = await page.goto(route.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response || response.status() >= 400) {
      throw new Error(`deck ${deck.id} first slide request failed${response ? ` with HTTP ${response.status()}` : ''}`);
    }
    if (!sameSegments(decodePathSegments(new URL(page.url()).pathname), routeSegments)) {
      throw new Error(`deck ${deck.id} navigated to an unexpected route: ${page.url()}`);
    }

    await waitForRenderedSlide(page, deck.id);
    if (failures.length) throw new Error(`deck ${deck.id} has browser request errors: ${failures.join('; ')}`);

    const screenshot = await page.locator(SLIDE_SELECTOR).screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
    if (screenshot.length > MAX_PNG_BYTES) {
      throw new Error(`deck ${deck.id} thumbnail exceeds ${MAX_PNG_BYTES} bytes`);
    }
    if (!screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`deck ${deck.id} did not produce a PNG thumbnail`);
    }
    const actualWidth = screenshot.readUInt32BE(16);
    const actualHeight = screenshot.readUInt32BE(20);
    if (actualWidth !== outputWidth || actualHeight !== outputHeight) {
      throw new Error(`deck ${deck.id} thumbnail is ${actualWidth}x${actualHeight}; expected ${outputWidth}x${outputHeight}`);
    }

    const src = deck.src;
    const filename = `${deck.segments.at(-1)}.png`;
    const destination = resolve(root, 'thumbnails', ...deck.segments.slice(0, -1), filename);
    if (!isInside(root, destination)) throw new Error(`deck ${deck.id} thumbnail path escapes the site root`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, screenshot);
    const file = await stat(destination);
    if (file.size !== screenshot.length) throw new Error(`deck ${deck.id} thumbnail was not fully written`);
    return { id: deck.id, src, width: outputWidth, height: outputHeight };
  } catch (error) {
    throw new Error(`thumbnail generation failed for deck ${deck.id}: ${error.message}`, { cause: error });
  } finally {
    await closeQuietly(context);
  }
}

export async function generateThumbnails({ siteRoot, outputWidth = DEFAULT_WIDTH, outputHeight = DEFAULT_HEIGHT } = {}) {
  if (!siteRoot) throw new Error('siteRoot is required');
  if (!Number.isInteger(outputWidth) || outputWidth < 1 || !Number.isInteger(outputHeight) || outputHeight < 1) {
    throw new Error('outputWidth and outputHeight must be positive integers');
  }

  const root = resolve(siteRoot);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${resolve(root, 'manifest.json')}: ${error.message}`, { cause: error });
  }
  const decks = validateDecks(manifest);
  const server = createServer(root);
  let browser;
  const results = [];

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', rejectListen);
        resolveListen();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('temporary thumbnail server did not expose a TCP port');
    const origin = `http://127.0.0.1:${address.port}`;
    const chromium = loadChromium();
    const executablePath = process.env.CHROMIUM_EXECUTABLE || (existsSync(CHROME_PATH) ? CHROME_PATH : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

    for (const deck of decks) {
      results.push(await generateDeckThumbnail({ browser, origin, root, deck, outputWidth, outputHeight }));
    }
    return results;
  } finally {
    await closeQuietly(browser);
    await closeServer(server);
  }
}

async function main() {
  const [siteRoot, ...extraArguments] = process.argv.slice(2);
  if (!siteRoot || extraArguments.length) throw new Error('usage: node scripts/thumbnails.mjs <site-root>');
  const thumbnails = await generateThumbnails({ siteRoot });
  console.log(JSON.stringify(thumbnails, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
