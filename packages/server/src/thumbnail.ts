import type { HubServerOptions } from './ports.js';
const VIEWPORT_WIDTH = 1200;
const VIEWPORT_HEIGHT = 675;
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

export type ThumbnailErrorCode =
  | 'BROWSER_UNAVAILABLE'
  | 'BROWSER_LIMIT'
  | 'BROWSER_FAILED'
  | 'RENDER_AUTH_REQUIRED';

export class ThumbnailError extends Error {
  readonly code: ThumbnailErrorCode;

  constructor(
    code: ThumbnailErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ThumbnailError';
    this.code = code;
  }
}

function captureError(code: ThumbnailErrorCode, message: string): ThumbnailError {
  return new ThumbnailError(code, message);
}

export function validatePng(bytes: Uint8Array): void {
  if (bytes.byteLength > 4 * 1024 * 1024)
    throw captureError('BROWSER_FAILED', 'Browser screenshot exceeded the size limit.');
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
    throw captureError(
      'BROWSER_FAILED',
      `Browser screenshot dimensions ${width}×${height} did not match 1200×675.`,
    );
  }
}

export async function captureAndStoreThumbnail(
  env: HubServerOptions,
  deckId: string,
  revision: string,
  publicOrigin: string,
): Promise<{ status: 'cached' | 'created'; src: string; usedMs: number | null }> {
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(deckId) || !/^[a-f0-9]{64}$/u.test(revision))
    throw captureError('BROWSER_FAILED', 'Invalid thumbnail target.');
  const key = `releases/${deckId}/${revision}/thumbnail.png`;
  const existing = await env.artifacts.get(key);
  if (existing) {
    validatePng(new Uint8Array(await new Response(existing.body).arrayBuffer()));
    return { status: 'cached', src: `/${key}`, usedMs: null };
  }
  if (!env.renderThumbnail)
    throw captureError('BROWSER_UNAVAILABLE', 'Thumbnail renderer is unavailable.');
  const target = new URL(`/${deckId}/1`, publicOrigin);
  target.searchParams.set('revision', revision);
  target.searchParams.set('embedded', 'true');
  target.searchParams.set('labThumbnail', 'true');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const thumbnail = await Promise.race([
      env.renderThumbnail(target.href),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(captureError('BROWSER_FAILED', 'Thumbnail renderer timed out.')),
          90_000,
        );
      }),
    ]);
    validatePng(thumbnail.bytes);
    const inserted = await env.artifacts.put(key, thumbnail.bytes, {
      contentType: 'image/png',
      ifAbsent: true,
    });
    if (!inserted) {
      const winner = await env.artifacts.get(key);
      if (!winner) throw captureError('BROWSER_FAILED', 'Thumbnail storage is unavailable.');
      validatePng(new Uint8Array(await new Response(winner.body).arrayBuffer()));
    }
    return { status: inserted ? 'created' : 'cached', src: `/${key}`, usedMs: thumbnail.usedMs };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
