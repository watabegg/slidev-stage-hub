import { performance } from 'node:perf_hooks';
import { isAbsolute } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Frame } from 'playwright-core';
import {
  ThumbnailError,
  validatePng,
  type ThumbnailErrorCode,
} from '@slidev-stage-hub/server/thumbnail';

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 90_000;
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const VIEWPORT = { width: 1200, height: 675 } as const;
const READY_SELECTOR = '.slidev-page[data-slidev-no="1"] [data-lab-slide-ready="1"]';
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const DECK_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface PlaywrightThumbnailRendererOptions {
  executablePath: string;
  publicOrigin: string;
  timeoutMs?: number;
}

export interface PlaywrightThumbnailRenderer {
  renderThumbnail(url: string): Promise<{ bytes: Uint8Array; usedMs: number }>;
  close(): Promise<void>;
}

function captureError(code: ThumbnailErrorCode, message: string): ThumbnailError {
  return new ThumbnailError(code, message);
}

function validatePublicOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('publicOrigin must be an absolute HTTP or HTTPS origin.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin === 'null' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError(
      'publicOrigin must be an HTTP or HTTPS origin without a path or credentials.',
    );
  }
  return parsed.origin;
}

function validateSlideUrl(value: string, publicOrigin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw captureError('BROWSER_FAILED', 'Playwright thumbnail URL was invalid.');
  }

  const pathSegments = parsed.pathname.slice(1).split('/');
  const queryEntries = parsed.search.slice(1).split('&');
  let revision: string | undefined;
  let revisionCount = 0;
  let embeddedCount = 0;
  let labThumbnailCount = 0;
  let queryIsAllowed = queryEntries.length > 0;
  for (const entry of queryEntries) {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      queryIsAllowed = false;
      break;
    }
    const key = entry.slice(0, separator);
    const queryValue = entry.slice(separator + 1);
    if (key === 'revision') {
      revisionCount += 1;
      revision = queryValue;
    } else if (key === 'embedded' && queryValue === 'true') {
      embeddedCount += 1;
    } else if (key === 'labThumbnail' && queryValue === 'true') {
      labThumbnailCount += 1;
    } else {
      queryIsAllowed = false;
      break;
    }
  }
  queryIsAllowed &&= revisionCount === 1 && embeddedCount <= 1 && labThumbnailCount <= 1;
  const isSlidePath =
    pathSegments.length >= 2 &&
    pathSegments.at(-1) === '1' &&
    pathSegments.slice(0, -1).every((segment) => DECK_SEGMENT_PATTERN.test(segment));

  if (
    parsed.origin !== publicOrigin ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    value.includes('#') ||
    parsed.hash !== '' ||
    !isSlidePath ||
    !queryIsAllowed ||
    !REVISION_PATTERN.test(revision ?? '')
  ) {
    throw captureError(
      'BROWSER_FAILED',
      'Playwright thumbnail URL must be a same-origin first-slide URL pinned to a valid revision.',
    );
  }

  return parsed;
}

function remainingMs(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) {
    throw captureError('BROWSER_FAILED', 'Playwright thumbnail rendering timed out.');
  }
  return remaining;
}

function safeCloseContext(context: BrowserContext | null | undefined): Promise<void> {
  if (!context) return Promise.resolve();
  return context.close().catch(() => undefined);
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const delayMs = Number(trimmed) * 1000;
    return Number.isFinite(delayMs) ? Math.min(delayMs, MAX_RETRY_AFTER_MS) : MAX_RETRY_AFTER_MS;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  const delayMs = Math.max(0, timestamp - Date.now());
  return Math.min(delayMs, MAX_RETRY_AFTER_MS);
}

/**
 * Create an isolated Node.js Chromium renderer for immutable public slide URLs.
 * Chromium is launched lazily and only from the explicitly configured executable path.
 */
export function createPlaywrightThumbnailRenderer({
  executablePath,
  publicOrigin,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: PlaywrightThumbnailRendererOptions): PlaywrightThumbnailRenderer {
  if (
    typeof executablePath !== 'string' ||
    executablePath.trim() === '' ||
    !isAbsolute(executablePath)
  ) {
    throw new TypeError('executablePath must be an absolute Chromium executable path.');
  }
  const allowedOrigin = validatePublicOrigin(publicOrigin);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('timeoutMs must be an integer between 1 and 90000.');
  }

  let browser: Browser | null = null;
  let launchPromise: Promise<Browser> | null = null;
  let activeContext: BrowserContext | null = null;
  let activeRequestController: AbortController | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function getBrowser(deadline: number): Promise<Browser> {
    if (closed) {
      throw captureError('BROWSER_UNAVAILABLE', 'Playwright thumbnail renderer is closed.');
    }
    if (browser?.isConnected()) return browser;
    browser = null;
    if (!launchPromise) {
      const timeout = remainingMs(deadline);
      launchPromise = chromium
        .launch({ executablePath, headless: true, timeout })
        .then(async (launched) => {
          if (closed || performance.now() >= deadline) {
            await launched.close().catch(() => undefined);
            throw captureError('BROWSER_FAILED', 'Playwright thumbnail rendering timed out.');
          }
          browser = launched;
          return launched;
        })
        .catch((error: unknown) => {
          if (error instanceof ThumbnailError) throw error;
          throw captureError(
            'BROWSER_UNAVAILABLE',
            'Configured Chromium executable could not be launched.',
          );
        })
        .finally(() => {
          launchPromise = null;
        });
    }
    return launchPromise;
  }

  async function renderOne(
    url: URL,
    deadline: number,
    startedAt: number,
  ): Promise<{
    bytes: Uint8Array;
    usedMs: number;
  }> {
    let context: BrowserContext | null = null;
    let requestController: AbortController | null = null;
    let authRequired = false;
    let rateLimited = false;
    let retryAfterMs: number | undefined;
    let timedOut = false;
    try {
      const launchedBrowser = await getBrowser(deadline);
      remainingMs(deadline);
      context = await launchedBrowser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        serviceWorkers: 'block',
      });
      activeContext = context;
      remainingMs(deadline);
      const page = await context.newPage();
      remainingMs(deadline);
      const controller = new AbortController();
      requestController = controller;
      activeRequestController = controller;

      await page.route('**/*', async (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          let frame: Frame;
          try {
            frame = request.frame();
          } catch {
            await route.abort();
            return;
          }
          if (frame === page.mainFrame()) {
            if (request.url() !== url.href) {
              await route.abort();
              return;
            }
            let response;
            try {
              response = await route.fetch({
                maxRedirects: 0,
                signal: controller.signal,
                timeout: remainingMs(deadline),
              });
            } catch (error) {
              if (isPlaywrightTimeout(error) || performance.now() >= deadline) timedOut = true;
              controller.abort();
              await route.abort().catch(() => undefined);
              return;
            }
            if (response.status() >= 300 && response.status() < 400) {
              await route.abort().catch(() => undefined);
              return;
            }
            if (response.status() === 401 || response.status() === 403) {
              authRequired = true;
              await route.abort().catch(() => undefined);
              return;
            }
            if (response.status() === 429) {
              rateLimited = true;
              retryAfterMs = parseRetryAfter(response.headers()['retry-after']);
            }
            await route.fulfill({ response });
            return;
          }
        }
        await route.continue();
      });

      page.on('response', (response) => {
        const request = response.request();
        if (!request.isNavigationRequest()) return;
        try {
          if (
            request.frame() === page.mainFrame() &&
            (response.status() === 401 || response.status() === 403)
          ) {
            authRequired = true;
          }
        } catch {
          // Detached frames cannot be the protected main document response.
        }
      });

      const response = await page.goto(url.href, {
        waitUntil: 'domcontentloaded',
        timeout: remainingMs(deadline),
      });
      if (authRequired || response?.status() === 401 || response?.status() === 403) {
        throw captureError('RENDER_AUTH_REQUIRED', 'The published slide requires authentication.');
      }
      if (rateLimited || response?.status() === 429) {
        throw new ThumbnailError(
          'BROWSER_LIMIT',
          'The published slide origin rate limit was reached.',
          retryAfterMs,
        );
      }
      remainingMs(deadline);

      await page.locator(READY_SELECTOR).waitFor({
        state: 'visible',
        timeout: remainingMs(deadline),
      });
      const screenshot = await page.screenshot({
        type: 'png',
        fullPage: false,
        animations: 'disabled',
        timeout: remainingMs(deadline),
      });
      remainingMs(deadline);

      if (screenshot.byteLength > MAX_PNG_BYTES) {
        throw captureError('BROWSER_FAILED', 'Playwright screenshot exceeded the 4 MiB limit.');
      }
      try {
        validatePng(screenshot);
      } catch (error) {
        if (error instanceof ThumbnailError) throw error;
        throw captureError('BROWSER_FAILED', 'Playwright screenshot failed PNG validation.');
      }

      return {
        bytes: new Uint8Array(screenshot),
        usedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch (error) {
      if (authRequired) {
        throw captureError('RENDER_AUTH_REQUIRED', 'The published slide requires authentication.');
      }
      if (rateLimited) {
        throw new ThumbnailError(
          'BROWSER_LIMIT',
          'The published slide origin rate limit was reached.',
          retryAfterMs,
        );
      }
      if (error instanceof ThumbnailError) throw error;
      if (timedOut || isPlaywrightTimeout(error) || performance.now() >= deadline) {
        throw captureError('BROWSER_FAILED', 'Playwright thumbnail rendering timed out.');
      }
      throw captureError('BROWSER_FAILED', 'Playwright thumbnail rendering failed.');
    } finally {
      await safeCloseContext(context);
      if (activeRequestController === requestController) activeRequestController = null;
      if (activeContext === context) activeContext = null;
    }
  }

  function renderThumbnail(value: string): Promise<{ bytes: Uint8Array; usedMs: number }> {
    const startedAt = performance.now();
    let url: URL;
    try {
      if (closed) {
        throw captureError('BROWSER_UNAVAILABLE', 'Playwright thumbnail renderer is closed.');
      }
      url = validateSlideUrl(value, allowedOrigin);
    } catch (error) {
      return Promise.reject(error);
    }

    const deadline = startedAt + timeoutMs;
    let operationCleanup: Promise<void> | undefined;
    const result = queue.then(async () => {
      if (closed) {
        throw captureError('BROWSER_UNAVAILABLE', 'Playwright thumbnail renderer is closed.');
      }
      remainingMs(deadline);

      const operation = renderOne(url, deadline, startedAt);
      operationCleanup = operation.then(
        () => undefined,
        () => undefined,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          activeRequestController?.abort();
          void safeCloseContext(activeContext);
          reject(captureError('BROWSER_FAILED', 'Playwright thumbnail rendering timed out.'));
        }, remainingMs(deadline));
      });
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
    queue = result
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => operationCleanup);
    return result;
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      activeRequestController?.abort();
      await safeCloseContext(activeContext);
      await queue;
      if (launchPromise) await launchPromise.catch(() => undefined);
      const runningBrowser = browser;
      browser = null;
      if (runningBrowser) await runningBrowser.close();
    })();
    return closePromise;
  }

  return { renderThumbnail, close };
}
