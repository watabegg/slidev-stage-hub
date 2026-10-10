import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type ListObjectsV2CommandOutput,
  type PutObjectCommandOutput,
  type DeleteObjectCommandOutput,
} from '@aws-sdk/client-s3';
import type {
  ArtifactBody,
  ArtifactMetadata,
  ArtifactObject,
  ArtifactStore,
} from '@slidev-stage-hub/server';

export interface S3ArtifactClient {
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  send(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>;
  send(command: ListObjectsV2Command): Promise<ListObjectsV2CommandOutput>;
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
}

export interface S3ArtifactStoreOptions {
  bucket: string;
  client?: S3ArtifactClient;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return undefined;
  const metadata = error.$metadata;
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata))
    return undefined;
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('name' in error && typeof error.name === 'string') return error.name;
  if ('Code' in error && typeof error.Code === 'string') return error.Code;
  return undefined;
}

function metadataOf(value: {
  ContentType?: string;
  ETag?: string;
  ContentLength?: number;
}): ArtifactMetadata {
  return {
    ...(value.ContentType === undefined ? {} : { contentType: value.ContentType }),
    ...(value.ETag === undefined ? {} : { etag: value.ETag }),
    ...(value.ContentLength === undefined ? {} : { size: value.ContentLength }),
  };
}

async function toS3Body(body: ArtifactBody): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size))
      throw new RangeError('S3 artifact body is too large to buffer');
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Stream bodies are buffered in memory so PutObject can send an explicit Content-Length. */
export function createS3ArtifactStore(options: S3ArtifactStoreOptions): ArtifactStore {
  const client: S3ArtifactClient =
    options.client ??
    new S3Client({
      ...(options.region === undefined ? {} : { region: options.region }),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
    });
  const { bucket } = options;

  return {
    async delete(key): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async get(key): Promise<ArtifactObject | null> {
      let result: GetObjectCommandOutput;
      try {
        result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (errorName(error) === 'NoSuchBucket') throw error;
        if (
          errorStatus(error) === 404 ||
          errorName(error) === 'NoSuchKey' ||
          errorName(error) === 'NotFound'
        )
          return null;
        throw error;
      }
      if (result.Body === undefined) throw new Error('S3 GetObject returned no body');
      return { ...metadataOf(result), body: result.Body.transformToWebStream() };
    },

    async head(key): Promise<ArtifactMetadata | null> {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return metadataOf(result);
      } catch (error) {
        if (errorName(error) === 'NoSuchBucket') throw error;
        if (errorStatus(error) === 404 || errorName(error) === 'NotFound') return null;
        throw error;
      }
    },

    async put(key, body: ArtifactBody, putOptions): Promise<boolean> {
      try {
        const bytes = await toS3Body(body);
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentLength: bytes.byteLength,
            ...(putOptions?.contentType === undefined
              ? {}
              : { ContentType: putOptions.contentType }),
            ...(putOptions?.ifAbsent ? { IfNoneMatch: '*' } : {}),
          }),
        );
        return true;
      } catch (error) {
        if (
          putOptions?.ifAbsent &&
          (errorStatus(error) === 412 ||
            errorName(error) === 'PreconditionFailed' ||
            errorName(error) === 'ConditionalAlreadyExists')
        ) {
          return false;
        }
        throw error;
      }
    },

    async list({ prefix, limit, cursor }) {
      if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError('limit must be a positive integer');
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: Math.min(limit, 1000),
          ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
        }),
      );
      const keys =
        result.Contents?.flatMap((item) => (item.Key?.startsWith(prefix) ? [item.Key] : [])) ?? [];
      if (result.IsTruncated && !result.NextContinuationToken) {
        throw new Error('S3 list response is truncated but has no continuation token');
      }
      return {
        keys,
        ...(result.IsTruncated ? { cursor: result.NextContinuationToken } : {}),
      };
    },
  };
}
