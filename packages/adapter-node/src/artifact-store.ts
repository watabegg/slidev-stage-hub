import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, link } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ArtifactBody,
  ArtifactMetadata,
  ArtifactObject,
  ArtifactStore,
} from '@slidev-stage-hub/server';

const magic = Buffer.from('SHART\u0001', 'binary');

function checkedSegments(key: string): string[] {
  if (
    !key ||
    key.includes('\0') ||
    key.includes('\\') ||
    isAbsolute(key) ||
    /^[A-Za-z]:/.test(key)
  ) {
    throw new TypeError('Invalid artifact key');
  }
  const segments = key.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError('Invalid artifact key');
  }
  return segments;
}

function decodeEnvelope(buffer: Buffer): { metadata: ArtifactMetadata; bytes: Buffer } {
  if (buffer.length < magic.length + 4 || !buffer.subarray(0, magic.length).equals(magic)) {
    throw new Error('Invalid artifact object');
  }
  const metadataLength = buffer.readUInt32BE(magic.length);
  const metadataEnd = magic.length + 4 + metadataLength;
  if (metadataEnd > buffer.length) throw new Error('Invalid artifact object');
  const metadata = JSON.parse(
    buffer.toString('utf8', magic.length + 4, metadataEnd),
  ) as ArtifactMetadata;
  return { metadata, bytes: buffer.subarray(metadataEnd) };
}

async function bodyBytes(body: ArtifactBody): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const chunks: Buffer[] = [];
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function envelope(metadata: ArtifactMetadata, bytes: Buffer): Buffer {
  const encodedMetadata = Buffer.from(JSON.stringify(metadata));
  const header = Buffer.allocUnsafe(magic.length + 4);
  magic.copy(header, 0);
  header.writeUInt32BE(encodedMetadata.length, magic.length);
  return Buffer.concat([header, encodedMetadata, bytes]);
}

export function createFileArtifactStore({ root }: { root: string }): ArtifactStore {
  const rootPromise = mkdir(resolve(root), { recursive: true }).then(() => realpath(resolve(root)));

  async function objectPath(key: string, createParents: boolean): Promise<string> {
    const segments = checkedSegments(key);
    const canonicalRoot = await rootPromise;
    let directory = canonicalRoot;
    for (const part of segments.slice(0, -1)) {
      directory = join(directory, part);
      if (createParents)
        await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Artifact path contains a non-directory');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !createParents)
          return join(directory, segments.at(-1)! + '.obj');
        throw error;
      }
    }
    return join(directory, `${segments.at(-1)}.obj`);
  }

  async function readObject(
    path: string,
  ): Promise<{ metadata: ArtifactMetadata; bytes: Buffer } | null> {
    try {
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Artifact object is not a regular file');
        return decodeEnvelope(await handle.readFile());
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  return {
    async get(key): Promise<ArtifactObject | null> {
      const found = await readObject(await objectPath(key, false));
      if (!found) return null;
      return {
        ...found.metadata,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(found.bytes));
            controller.close();
          },
        }),
      };
    },
    async head(key): Promise<ArtifactMetadata | null> {
      const found = await readObject(await objectPath(key, false));
      if (!found) return null;
      return found.metadata;
    },
    async put(key, body, options = {}): Promise<boolean> {
      const path = await objectPath(key, true);
      const bytes = await bodyBytes(body);
      const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
      const value = envelope(
        { contentType: options.contentType, etag, size: bytes.byteLength },
        bytes,
      );
      const temporary = join(dirname(path), `.hub-artifact-${randomUUID()}.tmp`);
      await writeExclusive(temporary, value);
      try {
        if (options.ifAbsent) {
          try {
            await link(temporary, path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              const stat = await lstat(path);
              if (stat.isSymbolicLink() || !stat.isFile())
                throw new Error('Artifact path is not a regular file');
              return false;
            }
            throw error;
          }
          return true;
        }
        await rename(temporary, path);
        return true;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
    async list({ prefix, limit, cursor }) {
      if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError('limit must be a positive integer');
      if (prefix) checkedSegments(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
      let after = '';
      if (cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
            prefix: string;
            after: string;
          };
          if (parsed.prefix !== prefix || typeof parsed.after !== 'string') throw new Error();
          after = parsed.after;
        } catch {
          throw new TypeError('Invalid artifact cursor');
        }
      }
      const canonicalRoot = await rootPromise;
      const keys: string[] = [];
      async function walk(directory: string): Promise<void> {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries) {
          const path = join(directory, entry.name);
          if (entry.isSymbolicLink()) throw new Error('Artifact storage contains a symbolic link');
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && entry.name.endsWith('.obj')) {
            const key = relative(canonicalRoot, path)
              .split(sep)
              .join('/')
              .replace(/\.obj$/, '');
            if (key.startsWith(prefix) && key > after) keys.push(key);
          }
        }
      }
      await walk(canonicalRoot);
      keys.sort();
      const page = keys.slice(0, limit);
      const next =
        keys.length > limit
          ? Buffer.from(JSON.stringify({ prefix, after: page.at(-1) })).toString('base64url')
          : undefined;
      return { keys: page, ...(next ? { cursor: next } : {}) };
    },
  };
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
