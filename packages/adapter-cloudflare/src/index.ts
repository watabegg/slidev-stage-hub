import type { ArtifactMetadata, ArtifactStore, HubServerOptions } from '@slidock/server';
import { runtimeSnapshotFromManifest } from '@slidock/server';
import { captureThumbnail } from './thumbnail.js';
import type { BrowserRunBinding } from './types.js';
import { createDurableObjectPublicationJobStore } from './publication-jobs.js';
import type { DeckVersionsCoordinator } from './publication-jobs.js';

export type { BrowserRunBinding, ScreenshotOptions } from './types.js';
export {
  createDeckBoundDurableObjectPublicationJobStore,
  createDurableObjectPublicationJobStore,
  createDurableObjectPublicationStore,
  type DeckVersionsCoordinator,
  type DeckVersionsRpc,
} from './publication-jobs.js';

export interface CloudflareBindings {
  FILES: R2Bucket;
  VERSIONS: Pick<DurableObjectNamespace<DeckVersionsCoordinator>, 'getByName'>;
  STATIC: { fetch(request: Request): Promise<Response> };
  PROFILE_DIGEST: string;
  LOCAL_MUTATIONS?: string;
  PROFILE_THEME?: string;
  PROFILE_LAYOUTS?: string;
  PROFILE_COMPONENTS?: string;
  PUBLISH_TOKEN?: string;
  BROWSER?: BrowserRunBinding;
  HUB_JOBS_ENABLED?: string;
  PUBLIC_ORIGIN?: string;
}

function metadata(object: R2Object): ArtifactMetadata {
  return {
    ...(object.httpMetadata?.contentType ? { contentType: object.httpMetadata.contentType } : {}),
    etag: object.httpEtag,
    size: object.size,
  };
}

export function createR2ArtifactStore(bucket: R2Bucket): ArtifactStore {
  return {
    async delete(key) {
      await bucket.delete(key);
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return { ...metadata(object), body: object.body };
    },
    async head(key) {
      const object = await bucket.head(key);
      return object ? metadata(object) : null;
    },
    async put(key, body, options) {
      const stored = await bucket.put(key, body, {
        ...(options?.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
        ...(options?.ifAbsent ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
      });
      if (stored === null && !options?.ifAbsent) {
        throw new Error('R2 did not store the artifact');
      }
      return stored !== null;
    },
    async list(options) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
        throw new Error('Artifact list limit must be from 1 to 1000');
      }
      const listed = await bucket.list(options);
      if (listed.truncated && !listed.cursor) throw new Error('R2 omitted its continuation cursor');
      return {
        keys: listed.objects.map((object) => object.key),
        ...(listed.truncated ? { cursor: listed.cursor } : {}),
      };
    },
  };
}

export function createCloudflareOptions(env: CloudflareBindings): HubServerOptions {
  const jobs = createDurableObjectPublicationJobStore(env.VERSIONS);
  return {
    artifacts: createR2ArtifactStore(env.FILES),
    jobs,
    publications: jobs.publications,
    onJobEvent: (event) => console.log(JSON.stringify(event)),
    ...(env.HUB_JOBS_ENABLED === undefined ? {} : { jobsEnabled: env.HUB_JOBS_ENABLED === 'true' }),
    ...(env.PUBLIC_ORIGIN === undefined ? {} : { publicOrigin: env.PUBLIC_ORIGIN }),
    staticAssets: { fetch: (request) => env.STATIC.fetch(request) },
    loadRuntime: async () => {
      const response = await env.STATIC.fetch(
        new Request('https://hub.invalid/runtime-manifest.json'),
      );
      if (!response.ok) throw new Error('Built runtime manifest is unavailable');
      return runtimeSnapshotFromManifest(await response.json());
    },
    profile: {
      digest: env.PROFILE_DIGEST,
      ...(env.PROFILE_THEME === undefined ? {} : { theme: env.PROFILE_THEME }),
      ...(env.PROFILE_LAYOUTS === undefined ? {} : { layouts: env.PROFILE_LAYOUTS }),
      ...(env.PROFILE_COMPONENTS === undefined ? {} : { components: env.PROFILE_COMPONENTS }),
    },
    ...(env.PUBLISH_TOKEN === undefined ? {} : { publishToken: env.PUBLISH_TOKEN }),
    allowLocalMutations: String(env.LOCAL_MUTATIONS) === 'true',
    ...(env.BROWSER
      ? { renderThumbnail: (url) => captureThumbnail({ browser: env.BROWSER, url }) }
      : {}),
  };
}
