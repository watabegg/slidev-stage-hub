import assert from 'node:assert/strict';
import test from 'node:test';
import { captureThumbnail, ThumbnailError } from '../dist/thumbnail.js';

function rateLimitedBrowser(retryAfter) {
  return {
    async quickAction() {
      return {
        status: 429,
        ok: false,
        headers: new Headers(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
        body: null,
      };
    },
  };
}

test('Browser Run rate limits preserve Retry-After delay seconds', async () => {
  await assert.rejects(
    captureThumbnail({ browser: rateLimitedBrowser('12'), url: 'https://hub.test/deck' }),
    (error) => error instanceof ThumbnailError && error.retryAfterMs === 12_000,
  );
});

test('Browser Run rate limits parse HTTP dates and ignore invalid Retry-After values', async () => {
  const retryAt = new Date(Date.now() + 20_000).toUTCString();
  await assert.rejects(
    captureThumbnail({ browser: rateLimitedBrowser(retryAt), url: 'https://hub.test/deck' }),
    (error) => {
      return (
        error instanceof ThumbnailError &&
        error.retryAfterMs !== undefined &&
        error.retryAfterMs > 0 &&
        error.retryAfterMs <= 20_000
      );
    },
  );

  await assert.rejects(
    captureThumbnail({ browser: rateLimitedBrowser('soon'), url: 'https://hub.test/deck' }),
    (error) => error instanceof ThumbnailError && error.retryAfterMs === undefined,
  );
});
