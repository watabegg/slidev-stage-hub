const MAX_PNG_BYTES = 4 * 1024 * 1024;
const SLIDE_SELECTOR = '.slidev-page[data-slidev-no="1"]';
const READY_SELECTOR = `${SLIDE_SELECTOR} [data-lab-slide-ready="1"]`;
const VIEWPORT_WIDTH = 1200;
const VIEWPORT_HEIGHT = 675;
const WAIT_TIMEOUT_MS = 60_000;
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function captureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRateLimit(error) {
  return error?.status === 429 || error?.statusCode === 429;
}

async function cancelQuietly(resource) {
  try {
    await resource?.cancel?.();
  } catch {
    // Preserve the screenshot error while still stopping an unused response body.
  }
}

function readBrowserMsUsed(headers) {
  const value = headers?.get?.('X-Browser-Ms-Used');
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null;
  const usedMs = Number(value);
  return Number.isSafeInteger(usedMs) ? usedMs : null;
}

async function readBoundedBody(body) {
  const reader = body?.getReader?.();
  if (!reader) throw captureError('BROWSER_FAILED', 'Browser screenshot response had no PNG body.');

  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw captureError('BROWSER_FAILED', 'Browser screenshot response was not a byte stream.');
      }
      if (value.byteLength > MAX_PNG_BYTES - byteLength) {
        throw captureError('BROWSER_FAILED', 'Browser screenshot exceeded the 4 MiB limit.');
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } catch (error) {
    await cancelQuietly(reader);
    if (error?.code === 'BROWSER_FAILED') throw error;
    throw captureError('BROWSER_FAILED', 'Browser screenshot response could not be read.');
  } finally {
    try { reader.releaseLock(); }
    catch { /* A failed read may already have released the lock. */ }
  }

  if (byteLength === 0) throw captureError('BROWSER_FAILED', 'Browser screenshot response was empty.');
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function validatePng(bytes) {
  if (bytes.byteLength < 33) {
    throw captureError('BROWSER_FAILED', 'Browser response was not a complete PNG header.');
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw captureError('BROWSER_FAILED', 'Browser screenshot response was not a PNG.');
    }
  }
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') {
    throw captureError('BROWSER_FAILED', 'Browser screenshot response had no PNG IHDR.');
  }
  if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false) !== 13) {
    throw captureError('BROWSER_FAILED', 'Browser screenshot response had an invalid PNG IHDR.');
  }

  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint32(16, false);
  const height = header.getUint32(20, false);
  if (width !== VIEWPORT_WIDTH || height !== VIEWPORT_HEIGHT) {
    throw captureError('BROWSER_FAILED', `Browser screenshot dimensions ${width}×${height} did not match 1200×675.`);
  }
}

function makeScreenshotOptions(url) {
  return {
    url,
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 },
    waitForSelector: { selector: READY_SELECTOR, visible: true, timeout: WAIT_TIMEOUT_MS },
    gotoOptions: { waitUntil: 'networkidle0', timeout: WAIT_TIMEOUT_MS },
    actionTimeout: WAIT_TIMEOUT_MS,
    screenshotOptions: { type: 'png', encoding: 'binary', fullPage: false, captureBeyondViewport: false },
  };
}

/** Capture the first Slidev page through a Cloudflare Browser Run binding. */
export async function captureThumbnail({ browser, url } = {}) {
  if (!browser || typeof browser.quickAction !== 'function') {
    throw captureError('BROWSER_UNAVAILABLE', 'Cloudflare Browser Run is unavailable.');
  }
  if (typeof url !== 'string' || url.length === 0) {
    throw captureError('BROWSER_FAILED', 'A screenshot URL is required.');
  }

  let response;
  try {
    response = await browser.quickAction('screenshot', makeScreenshotOptions(url));
  } catch (error) {
    if (isRateLimit(error)) {
      throw captureError('BROWSER_LIMIT', 'Cloudflare Browser Run rate limit was reached.');
    }
    throw captureError('BROWSER_FAILED', 'Cloudflare Browser Run screenshot failed.');
  }

  if (response?.status === 429) {
    await cancelQuietly(response.body);
    throw captureError('BROWSER_LIMIT', 'Cloudflare Browser Run rate limit was reached.');
  }
  if (!response?.ok) {
    await cancelQuietly(response?.body);
    throw captureError('BROWSER_FAILED', 'Cloudflare Browser Run screenshot failed.');
  }

  const contentType = response.headers?.get?.('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'image/png') {
    await cancelQuietly(response.body);
    throw captureError('BROWSER_FAILED', 'Cloudflare Browser Run did not return a PNG.');
  }

  const contentLength = response.headers?.get?.('content-length');
  if (typeof contentLength === 'string' && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_PNG_BYTES) {
    await cancelQuietly(response.body);
    throw captureError('BROWSER_FAILED', 'Browser screenshot exceeded the 4 MiB limit.');
  }

  const usedMs = readBrowserMsUsed(response.headers);
  const bytes = await readBoundedBody(response.body);
  validatePng(bytes);
  return { bytes, contentType: 'image/png', usedMs };
}
