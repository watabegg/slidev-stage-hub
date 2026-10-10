import { WorkerError } from './errors.js';
import { isRecord, isReleaseManifest } from './manifest.js';
import type { ArtifactObject, ArtifactStore, HubServerOptions, RuntimeSnapshot } from './ports.js';
import { readJson } from './storage.js';

const HEX = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 128 * 1024 * 1024;

function publicPath(path: string): boolean {
  return (
    (path === 'index.html' || /^(?:assets|_runtime)\/.+/u.test(path)) &&
    !/[\\?#%\s\p{Cc}]/u.test(path) &&
    path.length <= 1024 &&
    path
      .split('/')
      .every(
        (part) =>
          part !== '' && !part.startsWith('.') && !/^(?:src|source|sources|private)$/iu.test(part),
      ) &&
    !/\.(?:map|ts|tsx|vue|md|markdown|scss|sass|less)$/iu.test(path)
  );
}

/** Old build manifests are accepted; a present descriptor must never silently downgrade. */
export function runtimeSnapshotFromManifest(value: unknown): RuntimeSnapshot | undefined {
  if (!isRecord(value)) throw new Error('Runtime manifest must be an object');
  if (!Object.hasOwn(value, 'runtime')) return undefined;
  return validateRuntimeSnapshot(value.runtime);
}

function validateRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    !HEX.test(value.id) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > 4096
  )
    throw new Error('Invalid runtime snapshot');
  let total = 0;
  const paths = new Set<string>();
  const files = value.files.map((file) => {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      !publicPath(file.path) ||
      paths.has(file.path) ||
      typeof file.sha256 !== 'string' ||
      !HEX.test(file.sha256) ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_BYTES ||
      typeof file.contentType !== 'string' ||
      /\p{Cc}/u.test(file.contentType) ||
      file.contentType.length > 256 ||
      !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;.*)?$/u.test(file.contentType)
    )
      throw new Error('Invalid runtime snapshot file');
    total += file.size;
    if (total > MAX_BYTES) throw new Error('Runtime snapshot is too large');
    paths.add(file.path);
    return { path: file.path, sha256: file.sha256, size: file.size, contentType: file.contentType };
  });
  if (!['index.html', '_runtime/vue.js', '_runtime/bridge.js'].every((path) => paths.has(path)))
    throw new Error('Runtime snapshot is incomplete');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { schemaVersion: 1, id: value.id, files };
}

function sameSnapshot(a: RuntimeSnapshot, b: RuntimeSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function verifiedBytes(
  body: ReadableStream<Uint8Array> | null,
  size: number,
  sha256: string,
) {
  if (!body) throw new Error('Missing runtime body');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > size) {
      await reader.cancel();
      throw new Error('Runtime size mismatch');
    }
    chunks.push(value);
  }
  if (length !== size) throw new Error('Runtime size mismatch');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if ([...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('') !== sha256)
    throw new Error('Runtime hash mismatch');
  return bytes;
}

export async function readReadyRuntime(
  artifacts: ArtifactStore,
  id: string,
): Promise<RuntimeSnapshot | null> {
  if (!HEX.test(id)) throw new Error('Invalid runtime id');
  const raw = await readJson(artifacts, `runtime-index/${id}.json`);
  if (raw === null) return null;
  const descriptor = validateRuntimeSnapshot(raw);
  if (descriptor.id !== id) throw new Error('Runtime index id mismatch');
  return descriptor;
}

/** Write immutable objects first and the readiness marker last, making interrupted writes retryable. */
export async function archiveRuntime(
  options: HubServerOptions,
  input: RuntimeSnapshot,
): Promise<RuntimeSnapshot> {
  try {
    const snapshot = validateRuntimeSnapshot(input);
    const ready = await readReadyRuntime(options.artifacts, snapshot.id);
    if (ready) {
      if (!sameSnapshot(ready, snapshot)) throw new Error('Runtime descriptor collision');
      for (const file of snapshot.files) {
        const object = await options.artifacts.get(`runtimes/${snapshot.id}/${file.path}`);
        if (!object) throw new Error('Missing archived runtime object');
        await verifiedBytes(object.body, file.size, file.sha256);
      }
      return snapshot;
    }
    for (const file of snapshot.files) {
      const key = `runtimes/${snapshot.id}/${file.path}`;
      const existing = await options.artifacts.get(key);
      if (existing) {
        await verifiedBytes(existing.body, file.size, file.sha256);
        continue;
      }
      const response = await options.staticAssets.fetch(
        new Request(`https://runtime.invalid/${key}`),
      );
      if (!response.ok) throw new Error('Runtime source unavailable');
      const bytes = await verifiedBytes(response.body, file.size, file.sha256);
      if (
        !(await options.artifacts.put(key, bytes, {
          contentType: file.contentType,
          ifAbsent: true,
        }))
      ) {
        const raced = await options.artifacts.get(key);
        if (!raced) throw new Error('Runtime object disappeared');
        await verifiedBytes(raced.body, file.size, file.sha256);
      }
    }
    if (
      !(await options.artifacts.put(`runtime-index/${snapshot.id}.json`, JSON.stringify(snapshot), {
        contentType: 'application/json',
        ifAbsent: true,
      }))
    ) {
      const raced = await readReadyRuntime(options.artifacts, snapshot.id);
      if (!raced || !sameSnapshot(raced, snapshot)) throw new Error('Runtime descriptor collision');
    }
    return snapshot;
  } catch {
    throw new WorkerError(500, 'storage', 'Could not preserve the publication runtime');
  }
}

export async function readRuntimeFile(
  artifacts: ArtifactStore,
  id: string,
  path: string,
): Promise<ArtifactObject | null> {
  try {
    const snapshot = await readReadyRuntime(artifacts, id);
    const file = snapshot?.files.find((item) => item.path === path);
    if (!file) return null;
    const object = await artifacts.get(`runtimes/${id}/${path}`);
    if (!object) throw new Error('Missing archived runtime object');
    return { ...object, contentType: file.contentType };
  } catch {
    throw new WorkerError(503, 'storage', 'Pinned runtime is unavailable');
  }
}

async function listAll(artifacts: ArtifactStore, prefix: string): Promise<string[]> {
  const keys = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await artifacts.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.keys) || page.keys.length > 1000)
      throw new Error('Invalid storage page');
    for (const key of page.keys) {
      if (typeof key !== 'string' || !key.startsWith(prefix) || keys.has(key))
        throw new Error('Invalid storage listing');
      keys.add(key);
    }
    if (page.cursor === undefined) break;
    if (typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor))
      throw new Error('Invalid storage cursor');
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
  return [...keys].sort();
}

export async function auditRuntimeRetention({ artifacts }: { artifacts: ArtifactStore }): Promise<{
  runtimes: Array<{
    id: string;
    status: 'referenced' | 'unreferenced';
    releaseReferences: string[];
  }>;
  legacyReleases: string[];
  missingRuntimes: string[];
}> {
  const references = new Map<string, string[]>();
  const legacyReleases: string[] = [];
  for (const key of await listAll(artifacts, 'releases/')) {
    if (!key.endsWith('/manifest.json')) continue;
    const manifest = await readJson(artifacts, key);
    if (
      !isReleaseManifest(manifest) ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(manifest.id) ||
      !HEX.test(manifest.revision) ||
      key !== `releases/${manifest.id}/${manifest.revision}/manifest.json`
    )
      throw new Error('Invalid release manifest during runtime audit');
    if (manifest.runtimeId === undefined) legacyReleases.push(key);
    else {
      const refs = references.get(manifest.runtimeId) ?? [];
      refs.push(key);
      references.set(manifest.runtimeId, refs);
    }
  }
  const runtimes = [];
  const present = new Set<string>();
  for (const key of await listAll(artifacts, 'runtime-index/')) {
    const match = /^runtime-index\/([a-f0-9]{64})\.json$/u.exec(key);
    if (!match || !(await readReadyRuntime(artifacts, match[1])))
      throw new Error('Invalid runtime index during runtime audit');
    const id = match[1];
    present.add(id);
    runtimes.push({
      id,
      status: references.has(id) ? ('referenced' as const) : ('unreferenced' as const),
      releaseReferences: references.get(id) ?? [],
    });
  }
  return {
    runtimes,
    legacyReleases,
    missingRuntimes: [...references.keys()].filter((id) => !present.has(id)).sort(),
  };
}
