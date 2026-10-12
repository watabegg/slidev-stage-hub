import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureThumbnail, validatePng } from '@slidock/adapter-cloudflare/thumbnail';
import { THUMBNAIL_READY_SELECTOR, waitForRenderedSlide } from '../scripts/local-thumbnail.mjs';

const SLIDE_SELECTOR = '.slidev-page[data-slidev-no="1"]';
const READY_SELECTOR = `${SLIDE_SELECTOR} [data-lab-slide-ready="1"]`;
const MAX_PNG_BYTES = 4 * 1024 * 1024;

function pngHeader(width = 1200, height = 675) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const header = new DataView(bytes.buffer);
  header.setUint32(8, 13, false);
  bytes.set([73, 72, 68, 82], 12);
  header.setUint32(16, width, false);
  header.setUint32(20, height, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

function pngResponse(bytes = pngHeader(), headers = {}) {
  return new Response(bytes, {
    headers: { 'content-type': 'image/png', 'x-browser-ms-used': '42', ...headers },
  });
}

function binding(response) {
  return { quickAction: async () => response };
}

function assertCode(code) {
  return (error) => error?.code === code;
}

function thumbnailPage(imageResult) {
  const locators = [];
  const evaluations = [];
  const pageFunctionCalls = [];
  return {
    locators,
    evaluations,
    pageFunctionCalls,
    locator(selector) {
      locators.push(selector);
      return {
        waitFor: async () => {},
        evaluate: async (_callback, timeoutMs) => {
          evaluations.push({ selector, timeoutMs });
          return imageResult;
        },
      };
    },
    waitForFunction: async (...args) => {
      pageFunctionCalls.push(args);
    },
  };
}

test('waits for the loaded layout marker before checking images once', async () => {
  const page = thumbnailPage({ failedImage: null });

  await waitForRenderedSlide(page);

  assert.equal(THUMBNAIL_READY_SELECTOR, READY_SELECTOR);
  assert.deepEqual(page.locators, [SLIDE_SELECTOR, READY_SELECTOR, READY_SELECTOR]);
  assert.equal(page.pageFunctionCalls[0][1], READY_SELECTOR);
  assert.equal(page.evaluations.length, 1);
  assert.equal(page.evaluations[0].timeoutMs, 30_000);
});

test('fails promptly with the image alt text when decoding rejects', async () => {
  const page = thumbnailPage({ failedImage: 'broken' });

  await assert.rejects(waitForRenderedSlide(page), /Slide image failed to decode: broken/u);

  assert.equal(page.evaluations.length, 1);
  assert.equal(page.pageFunctionCalls.length, 2);
});

test('requests a first-slide PNG at 1200×675 and returns usage metadata', async () => {
  let requestedAction;
  let requestedOptions;
  const browser = {
    async quickAction(action, options) {
      requestedAction = action;
      requestedOptions = options;
      return pngResponse();
    },
  };

  const result = await captureThumbnail({
    browser,
    url: 'https://slides.example/deck/1?embedded=true',
  });

  assert.equal(requestedAction, 'screenshot');
  assert.equal(requestedOptions.selector, undefined);
  assert.deepEqual(requestedOptions.viewport, { width: 1200, height: 675, deviceScaleFactor: 1 });
  assert.deepEqual(requestedOptions.waitForSelector, {
    selector: READY_SELECTOR,
    visible: true,
    timeout: 60_000,
  });
  assert.deepEqual(requestedOptions.gotoOptions, { waitUntil: 'networkidle0', timeout: 60_000 });
  assert.deepEqual(requestedOptions.screenshotOptions, {
    type: 'png',
    encoding: 'binary',
    fullPage: false,
    captureBeyondViewport: false,
  });
  assert.equal(requestedOptions.actionTimeout, 60_000);
  assert.deepEqual(result, { bytes: pngHeader(), contentType: 'image/png', usedMs: 42 });
  assert.ok(result.bytes instanceof Uint8Array);
});

test('returns null usage metadata when the response header is missing or invalid', async () => {
  for (const value of [undefined, '42ms', '-1', '9007199254740992']) {
    const headers = { 'content-type': 'image/png' };
    if (value !== undefined) headers['x-browser-ms-used'] = value;
    const response = new Response(pngHeader(), { headers });
    const result = await captureThumbnail({
      browser: binding(response),
      url: 'https://slides.example/deck/1',
    });
    assert.equal(result.usedMs, null);
  }
});

test('reports an unavailable binding with its stable error code', async () => {
  await assert.rejects(
    captureThumbnail({ browser: null, url: 'https://slides.example/deck/1' }),
    assertCode('BROWSER_UNAVAILABLE'),
  );
});

test('maps HTTP 429 to BROWSER_LIMIT without exposing the response body', async () => {
  const secretBody = 'private upstream rate-limit details';
  const response = new Response(secretBody, {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });

  await assert.rejects(
    captureThumbnail({ browser: binding(response), url: 'https://private.example/token=secret' }),
    (error) =>
      error?.code === 'BROWSER_LIMIT' &&
      !error.message.includes(secretBody) &&
      !error.message.includes('private.example'),
  );
});

test('maps a thrown rate-limit error to BROWSER_LIMIT and sanitizes other failures', async () => {
  const limitedBrowser = {
    quickAction: async () => {
      throw Object.assign(new Error('secret upstream message'), { status: 429 });
    },
  };
  await assert.rejects(
    captureThumbnail({ browser: limitedBrowser, url: 'https://slides.example/deck/1' }),
    assertCode('BROWSER_LIMIT'),
  );

  const failedBrowser = {
    quickAction: async () => {
      throw new Error('failed for https://private.example/token=secret');
    },
  };
  await assert.rejects(
    captureThumbnail({ browser: failedBrowser, url: 'https://private.example/token=secret' }),
    (error) =>
      error?.code === 'BROWSER_FAILED' &&
      !error.message.includes('private.example') &&
      !error.message.includes('secret'),
  );
});

test('rejects non-PNG responses without reading or exposing their body', async () => {
  const response = new Response('upstream HTML contains private details', {
    headers: { 'content-type': 'text/html' },
  });

  await assert.rejects(
    captureThumbnail({ browser: binding(response), url: 'https://private.example/token=secret' }),
    (error) =>
      error?.code === 'BROWSER_FAILED' &&
      !error.message.includes('private details') &&
      !error.message.includes('private.example'),
  );
});

test('bounds streamed response reads to 4 MiB and cancels overflow', async () => {
  let canceled = false;
  let nextChunk = 0;
  let enqueuedBytes = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (nextChunk === 0) {
          controller.enqueue(new Uint8Array(3 * 1024 * 1024));
          enqueuedBytes += 3 * 1024 * 1024;
        } else if (nextChunk === 1) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024));
          enqueuedBytes += 2 * 1024 * 1024;
        }
        nextChunk += 1;
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(body, { headers: { 'content-type': 'image/png' } });

  await assert.rejects(
    captureThumbnail({ browser: binding(response), url: 'https://slides.example/deck/1' }),
    assertCode('BROWSER_FAILED'),
  );
  assert.equal(enqueuedBytes, 5 * 1024 * 1024);
  assert.equal(canceled, true);
});

test('rejects a known oversized response before reading it', async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(pngHeader());
    },
    cancel() {
      canceled = true;
    },
  });
  const response = new Response(body, {
    headers: { 'content-type': 'image/png', 'content-length': String(MAX_PNG_BYTES + 1) },
  });

  await assert.rejects(
    captureThumbnail({ browser: binding(response), url: 'https://slides.example/deck/1' }),
    assertCode('BROWSER_FAILED'),
  );
  assert.equal(canceled, true);
});

test('rejects a PNG with unexpected dimensions', async () => {
  await assert.rejects(
    captureThumbnail({
      browser: binding(pngResponse(pngHeader(980, 551))),
      url: 'https://slides.example/deck/1',
    }),
    assertCode('BROWSER_FAILED'),
  );
});

test('exports PNG validation for the worker upload route', () => {
  assert.doesNotThrow(() => validatePng(pngHeader()));
  assert.throws(() => validatePng(pngHeader(980, 551)), assertCode('BROWSER_FAILED'));
  assert.throws(() => validatePng(new Uint8Array()), assertCode('BROWSER_FAILED'));
});

test('local thumbnail CLI prints usage before attempting external work', () => {
  const script = fileURLToPath(new URL('../scripts/local-thumbnail.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node local-thumbnail\.mjs <origin> <deckId> \[revision\]/u);
});

test('local thumbnail CLI rejects an invalid revision before contacting its origin', () => {
  const script = fileURLToPath(new URL('../scripts/local-thumbnail.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'http://127.0.0.1:1', 'demo/deck', 'bad'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /revision must be/u);
});
