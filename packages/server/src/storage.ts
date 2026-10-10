import type { ArtifactBody, ArtifactStore } from './ports.js';
import { WorkerError } from './errors.js';

export const MAX_PUBLISH_BODY_BYTES = 512 * 1024;
export const MAX_THUMBNAIL_BODY_BYTES = 4 * 1024 * 1024;

export interface ArtifactWrite {
  key: string;
  body: ArtifactBody;
  options?: { contentType?: string; ifAbsent?: boolean };
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
  bucket: ArtifactStore,
  objects: readonly ArtifactWrite[],
): Promise<void> {
  // Storage round trips dominate publication time; keep a bounded number in flight.
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

export async function putJson(bucket: ArtifactStore, key: string, value: unknown): Promise<void> {
  try {
    await bucket.put(key, JSON.stringify(value), {
      contentType: 'application/json',
    });
  } catch {
    throw new WorkerError(500, 'storage', 'Could not store publication metadata');
  }
}

export async function readJson(bucket: ArtifactStore, key: string): Promise<unknown | null> {
  try {
    const object = await bucket.get(key);
    return object ? (JSON.parse(await new Response(object.body).text()) as unknown) : null;
  } catch {
    throw new WorkerError(500, 'storage', 'Could not read publication metadata');
  }
}

export async function markDeckIndexed(bucket: ArtifactStore, id: string): Promise<void> {
  try {
    await bucket.put(`index/${id}.json`, JSON.stringify({ id }));
  } catch {
    throw new WorkerError(500, 'storage', 'Could not update the deck index');
  }
}

export async function sha256(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(input)));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export class ImmutableArtifactConflict extends WorkerError {
  constructor() {
    super(500, 'storage', 'Immutable publication content does not match');
  }
}

/** A replay may reuse immutable content only after verifying its exact hash. */
export async function putImmutableArtifacts(
  bucket: ArtifactStore,
  objects: readonly ArtifactWrite[],
  progress?: (completed: number, total: number, unit: 'objects') => Promise<void>,
): Promise<void> {
  for (let index = 0; index < objects.length; index++) {
    const object = objects[index]!;
    const bytes = new Uint8Array(
      await new Response(
        object.body instanceof Uint8Array ? new Uint8Array(object.body) : object.body,
      ).arrayBuffer(),
    );
    try {
      const inserted = await bucket.put(object.key, bytes, { ...object.options, ifAbsent: true });
      if (!inserted) {
        const stored = await bucket.get(object.key);
        if (
          !stored ||
          (await sha256(new Uint8Array(await new Response(stored.body).arrayBuffer()))) !==
            (await sha256(bytes))
        ) {
          throw new ImmutableArtifactConflict();
        }
      }
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(500, 'storage', 'Could not store publication artifacts');
    }
    await progress?.(index + 1, objects.length, 'objects');
  }
}
