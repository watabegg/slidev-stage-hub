import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium as testChromium } from 'playwright-chromium';
import { createPlaywrightThumbnailRenderer } from '../dist/index.js';

const revisionA = 'a'.repeat(64);
const revisionB = 'b'.repeat(64);
const revisionC = 'c'.repeat(64);
const revisionD = 'd'.repeat(64);
const revisionE = 'e'.repeat(64);
const revisionF = 'f'.repeat(64);
const revisionG = 'a'.repeat(63) + 'b';
const revisionH = '8'.repeat(64);
const revisionI = '9'.repeat(64);
const READY_HTML = `<!doctype html>
<html><head><style>
  html, body { margin: 0; width: 100%; height: 100%; background: #18324a; }
  .slidev-page { width: 100%; height: 100%; }
  [data-lab-slide-ready="1"] { width: 2px; height: 2px; }
</style></head><body>
  <div class="slidev-page" data-slidev-no="1"><div data-lab-slide-ready="1"></div></div>
</body></html>`;

let executablePath;
try {
  executablePath = testChromium.executablePath();
  await access(executablePath);
} catch {
  executablePath = undefined;
}

function startServer(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({
        origin,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

function slideUrl(origin, revision) {
  return `${origin}/demo/1?revision=${revision}&embedded=true&labThumbnail=true`;
}

function startSlideServer({
  redirectOrigin,
  hangRevision,
  delayMs = 0,
  seenHeaders = [],
  seenUrls = [],
  requestActivity,
} = {}) {
  return startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/demo/1') {
      response.writeHead(404).end();
      return;
    }
    const revision = url.searchParams.get('revision');
    seenUrls.push(request.url);
    seenHeaders.push({
      revision,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    if (revision === revisionB) {
      response.writeHead(403, { 'content-type': 'text/html' }).end('<p>private</p>');
      return;
    }
    if (revision === revisionH) {
      response.writeHead(401, { 'content-type': 'text/html' }).end('<p>private</p>');
      return;
    }
    if (revision === revisionC && redirectOrigin) {
      response.writeHead(302, { location: slideUrl(redirectOrigin, revisionC) }).end();
      return;
    }
    if (revision === revisionE) {
      response.writeHead(429, { 'retry-after': '12' }).end();
      return;
    }
    if (revision === revisionF) {
      response.writeHead(429, { 'retry-after': new Date(Date.now() + 10_000).toUTCString() }).end();
      return;
    }
    if (revision === revisionG) {
      response.writeHead(429, { 'retry-after': '301' }).end();
      return;
    }
    if (revision === revisionI) {
      response
        .writeHead(429, { 'retry-after': new Date(Date.now() + 600_000).toUTCString() })
        .end();
      return;
    }
    if (revision === hangRevision) return;
    if (requestActivity) {
      requestActivity.active += 1;
      requestActivity.max = Math.max(requestActivity.max, requestActivity.active);
    }
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(READY_HTML);
    } finally {
      if (requestActivity) requestActivity.active -= 1;
    }
  });
}

test(
  'Playwright captures the first pinned slide with a local Chromium executable',
  {
    skip: executablePath ? false : 'No installed playwright-chromium executable is available.',
    timeout: 30_000,
  },
  async () => {
    let otherRequests = 0;
    const requestActivity = { active: 0, max: 0 };
    const other = await startServer((_request, response) => {
      otherRequests += 1;
      response.writeHead(200).end(READY_HTML);
    });
    const seenHeaders = [];
    const seenUrls = [];
    const origin = await startSlideServer({
      redirectOrigin: other.origin,
      delayMs: 40,
      seenHeaders,
      seenUrls,
      requestActivity,
    });
    const renderer = createPlaywrightThumbnailRenderer({
      executablePath,
      publicOrigin: origin.origin,
      timeoutMs: 15_000,
    });

    try {
      await assert.rejects(
        renderer.renderThumbnail(slideUrl('https://outside.example.test', revisionA)),
        (error) => error.code === 'BROWSER_FAILED',
      );

      const [first, second] = await Promise.all([
        renderer.renderThumbnail(slideUrl(origin.origin, revisionA)),
        renderer.renderThumbnail(slideUrl(origin.origin, revisionA)),
      ]);
      assert.equal(requestActivity.max, 1);
      for (const result of [first, second]) {
        assert.ok(result.bytes instanceof Uint8Array);
        assert.ok(result.bytes.byteLength <= 4 * 1024 * 1024);
        assert.ok(result.usedMs >= 0);
        assert.deepEqual(
          Array.from(result.bytes.subarray(0, 8)),
          [137, 80, 78, 71, 13, 10, 26, 10],
        );
        assert.equal(
          new DataView(result.bytes.buffer, result.bytes.byteOffset).getUint32(16),
          1200,
        );
        assert.equal(new DataView(result.bytes.buffer, result.bytes.byteOffset).getUint32(20), 675);
      }
      assert.equal(seenHeaders.length, 2);
      assert.ok(
        seenUrls
          .slice(0, 2)
          .every(
            (seenUrl) =>
              seenUrl === `/demo/1?revision=${revisionA}&embedded=true&labThumbnail=true`,
          ),
      );
      assert.ok(
        seenHeaders.every(
          (headers) => headers.authorization === undefined && headers.cookie === undefined,
        ),
      );

      await assert.rejects(
        renderer.renderThumbnail(slideUrl(origin.origin, revisionB)),
        (error) => error.code === 'RENDER_AUTH_REQUIRED',
      );
      await assert.rejects(
        renderer.renderThumbnail(slideUrl(origin.origin, revisionH)),
        (error) => error.code === 'RENDER_AUTH_REQUIRED',
      );
      await assert.rejects(
        renderer.renderThumbnail(slideUrl(origin.origin, revisionE)),
        (error) => error.code === 'BROWSER_LIMIT' && error.retryAfterMs === 12_000,
      );
      await assert.rejects(
        renderer.renderThumbnail(slideUrl(origin.origin, revisionF)),
        (error) =>
          error.code === 'BROWSER_LIMIT' &&
          Number.isSafeInteger(error.retryAfterMs) &&
          error.retryAfterMs > 0 &&
          error.retryAfterMs <= 10_000,
      );
      await assert.rejects(
        renderer.renderThumbnail(slideUrl(origin.origin, revisionG)),
        (error) => error.code === 'BROWSER_LIMIT' && error.retryAfterMs === 300_000,
      );
      await assert.rejects(
        renderer.renderThumbnail(slideUrl(origin.origin, revisionI)),
        (error) => error.code === 'BROWSER_LIMIT' && error.retryAfterMs === 300_000,
      );
      const redirectError = await renderer.renderThumbnail(slideUrl(origin.origin, revisionC)).then(
        () => null,
        (error) => error,
      );
      assert.equal(otherRequests, 0);
      assert.equal(redirectError?.code, 'BROWSER_FAILED');

      await renderer.close();
      await renderer.close();
      await assert.rejects(
        renderer.renderThumbnail(slideUrl(origin.origin, revisionA)),
        (error) => error.code === 'BROWSER_UNAVAILABLE',
      );
    } finally {
      await renderer.close();
      await Promise.all([origin.close(), other.close()]);
    }
  },
);

test(
  'Playwright bounds a stalled local navigation by the configured wall timeout',
  {
    skip: executablePath ? false : 'No installed playwright-chromium executable is available.',
    timeout: 20_000,
  },
  async () => {
    const seenHeaders = [];
    const origin = await startSlideServer({ hangRevision: revisionD, seenHeaders });
    const renderer = createPlaywrightThumbnailRenderer({
      executablePath,
      publicOrigin: origin.origin,
      timeoutMs: 4_000,
    });

    try {
      await renderer.renderThumbnail(slideUrl(origin.origin, revisionA));
      const startedAt = Date.now();
      const activeTimeout = renderer.renderThumbnail(slideUrl(origin.origin, revisionD));
      const queuedTimeout = renderer.renderThumbnail(slideUrl(origin.origin, revisionA));
      const timedOut = (error) =>
        error.code === 'BROWSER_FAILED' && /timed out/u.test(error.message);
      await Promise.all([
        assert.rejects(activeTimeout, timedOut),
        assert.rejects(queuedTimeout, timedOut),
      ]);
      assert.equal(seenHeaders.filter((headers) => headers.revision === revisionA).length, 1);
      assert.ok(Date.now() - startedAt < 5_000);
    } finally {
      await renderer.close();
      await origin.close();
    }
  },
);

test('Playwright rejects malformed revisions and non-slide paths without launching Chromium', async () => {
  const renderer = createPlaywrightThumbnailRenderer({
    executablePath: '/missing/chromium',
    publicOrigin: 'https://slides.example.test',
  });

  await assert.rejects(
    renderer.renderThumbnail('https://slides.example.test/demo/1?revision=revision-A'),
    (error) => error.code === 'BROWSER_FAILED',
  );
  await assert.rejects(
    renderer.renderThumbnail(`https://slides.example.test/api/jobs?revision=${revisionA}`),
    (error) => error.code === 'BROWSER_FAILED',
  );
  await assert.rejects(
    renderer.renderThumbnail(
      `https://slides.example.test/demo/1?revision=${revisionA}&token=secret`,
    ),
    (error) => error.code === 'BROWSER_FAILED',
  );
  await assert.rejects(
    renderer.renderThumbnail(
      `https://slides.example.test/demo/1?revision=${revisionA}&embedded=false`,
    ),
    (error) => error.code === 'BROWSER_FAILED',
  );
  await assert.rejects(
    renderer.renderThumbnail(
      `https://slides.example.test/demo/1?revision=${revisionA}&embedded=true&embedded=true`,
    ),
    (error) => error.code === 'BROWSER_FAILED',
  );
  await assert.rejects(
    renderer.renderThumbnail(
      `https://slides.example.test/demo/1?revision=${revisionA}&revision=${revisionA}`,
    ),
    (error) => error.code === 'BROWSER_FAILED',
  );
  await renderer.close();
});
