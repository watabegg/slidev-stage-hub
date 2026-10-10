const VIEWPORT_WIDTH = 1200;
const VIEWPORT_HEIGHT = 675;
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

export type ThumbnailErrorCode = 'BROWSER_UNAVAILABLE' | 'BROWSER_LIMIT' | 'BROWSER_FAILED';

export class ThumbnailError extends Error {
  readonly code: ThumbnailErrorCode;

  constructor(code: ThumbnailErrorCode, message: string) {
    super(message);
    this.name = 'ThumbnailError';
    this.code = code;
  }
}

function captureError(code: ThumbnailErrorCode, message: string): ThumbnailError {
  return new ThumbnailError(code, message);
}

export function validatePng(bytes: Uint8Array): void {
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
