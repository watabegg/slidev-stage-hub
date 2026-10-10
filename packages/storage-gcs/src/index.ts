import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Storage, type File, type GetFilesOptions } from '@google-cloud/storage';
import type {
  ArtifactBody,
  ArtifactMetadata,
  ArtifactObject,
  ArtifactStore,
} from '@slidev-stage-hub/server';

export interface GcsArtifactStoreOptions {
  bucket: string;
  client?: Storage;
  projectId?: string;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/u.test(code)) return Number(code);
  return undefined;
}

function httpEntityTag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const quoted = /^"[\x21\x23-\x7e\x80-\xff]*"$/u;
  const unquoted = /^[\x21\x23-\x7e\x80-\xff]*$/u;
  if (quoted.test(value)) return value;
  return unquoted.test(value) ? `"${value}"` : undefined;
}

function metadataOf(metadata: File['metadata']): ArtifactMetadata {
  const size = typeof metadata.size === 'string' ? Number(metadata.size) : metadata.size;
  const etag = typeof metadata.etag === 'string' ? httpEntityTag(metadata.etag) : undefined;
  return {
    ...(typeof metadata.contentType === 'string' ? { contentType: metadata.contentType } : {}),
    ...(etag === undefined ? {} : { etag }),
    ...(typeof size === 'number' && Number.isFinite(size) ? { size } : {}),
  };
}

function toNodeReadable(body: ArtifactBody): Readable {
  if (typeof body === 'string') return Readable.from([body]);
  if (body instanceof Uint8Array) return Readable.from([body]);
  return Readable.from(body as AsyncIterable<Uint8Array>);
}

export function createGcsArtifactStore(options: GcsArtifactStoreOptions): ArtifactStore {
  const storage =
    options.client ??
    new Storage(options.projectId === undefined ? {} : { projectId: options.projectId });
  const bucket = storage.bucket(options.bucket);

  return {
    async delete(key): Promise<void> {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },
    async get(key): Promise<ArtifactObject | null> {
      const file = bucket.file(key);
      let metadata: File['metadata'];
      try {
        [metadata] = await file.getMetadata();
      } catch (error) {
        if (statusCode(error) === 404) return null;
        throw error;
      }
      if (metadata.generation === undefined) {
        throw new Error('GCS getMetadata returned no generation; cannot pin artifact body');
      }
      const nodeStream = bucket.file(key, { generation: metadata.generation }).createReadStream();
      return {
        ...metadataOf(metadata),
        body: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      };
    },

    async head(key): Promise<ArtifactMetadata | null> {
      try {
        const [metadata] = await bucket.file(key).getMetadata();
        return metadataOf(metadata);
      } catch (error) {
        if (statusCode(error) === 404) return null;
        throw error;
      }
    },

    async put(key, body, putOptions): Promise<boolean> {
      const file = bucket.file(key);
      const metadata =
        putOptions?.contentType === undefined ? undefined : { contentType: putOptions.contentType };
      const stream = toNodeReadable(body);
      const destination = file.createWriteStream({
        resumable: false,
        ...(metadata === undefined ? {} : { metadata }),
        ...(putOptions?.ifAbsent ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}),
      });
      try {
        await pipeline(stream, destination);
        return true;
      } catch (error) {
        const name =
          typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
        if (
          putOptions?.ifAbsent &&
          (statusCode(error) === 412 ||
            name === 'PreconditionFailed' ||
            name === 'ConditionalAlreadyExists')
        ) {
          return false;
        }
        throw error;
      }
    },

    async list({ prefix, limit, cursor }) {
      if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError('limit must be a positive integer');
      const query: GetFilesOptions = {
        prefix,
        maxResults: Math.min(limit, 1000),
        autoPaginate: false,
        ...(cursor === undefined ? {} : { pageToken: cursor }),
      };
      const [files, nextQuery] = await bucket.getFiles(query);
      const keys = files.flatMap((file) => (file.name.startsWith(prefix) ? [file.name] : []));
      return {
        keys,
        ...(nextQuery?.pageToken ? { cursor: nextQuery.pageToken } : {}),
      };
    },
  };
}
