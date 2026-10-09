import { WorkerError } from './errors.ts';

export const MAX_PUBLISH_BODY_BYTES = 512 * 1024;
export const MAX_THUMBNAIL_BODY_BYTES = 4 * 1024 * 1024;

export interface ArtifactWrite {
  key: string;
  body: string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob;
  options?: R2PutOptions;
}

export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.byteLength > limit - size) {
      await reader.cancel();
      throw new WorkerError(400, 'request', 'Request body is too large');
    }
    size += value.byteLength;
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function putArtifacts(
  bucket: R2Bucket,
  objects: readonly ArtifactWrite[],
): Promise<void> {
  // R2 round trips dominate publication time; keep a bounded number in flight.
  for (let offset = 0; offset < objects.length; offset += 6) {
    const batch = await Promise.allSettled(
      objects
        .slice(offset, offset + 6)
        .map(({ key, body, options }) => bucket.put(key, body, options)),
    );
    if (batch.some((result) => result.status === 'rejected')) {
      throw new WorkerError(500, 'storage', 'Could not store publication artifacts');
    }
  }
}

export async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  try {
    await bucket.put(key, JSON.stringify(value), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch {
    throw new WorkerError(500, 'storage', 'Could not store publication metadata');
  }
}

export async function readJson(bucket: R2Bucket, key: string): Promise<unknown | null> {
  try {
    const object = await bucket.get(key);
    return object ? await object.json<unknown>() : null;
  } catch {
    throw new WorkerError(500, 'storage', 'Could not read publication metadata');
  }
}

export async function markDeckIndexed(bucket: R2Bucket, id: string): Promise<void> {
  try {
    await bucket.put(`index/${id}.json`, JSON.stringify({ id }));
  } catch {
    throw new WorkerError(500, 'storage', 'Could not update the deck index');
  }
}
