import type {
  ArtifactMetadata,
  ArtifactStore,
  HubServerOptions,
  PublicationStore,
} from '@slidev-stage-hub/server';
import { runtimeSnapshotFromManifest } from '@slidev-stage-hub/server';
import { captureThumbnail } from './thumbnail.js';
import type { BrowserRunBinding } from './types.js';

export type { BrowserRunBinding, ScreenshotOptions } from './types.js';

/** The RPC surface used from the application's generated Durable Object namespace. */
export interface DeckVersionsCoordinator extends Rpc.DurableObjectBranded {
  begin(): number;
  current(): unknown | null;
  commit(generation: number, manifest: unknown): boolean;
}

export type DeckVersionsRpc = Pick<
  DurableObjectStub<DeckVersionsCoordinator>,
  'begin' | 'current' | 'commit'
>;

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

export function createDurableObjectPublicationStore(
  namespace: CloudflareBindings['VERSIONS'],
): PublicationStore {
  return {
    async begin(id) {
      const generation = await namespace.getByName(id).begin();
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error('Durable Object returned an invalid publication generation');
      }
      return String(generation);
    },
    current: (id) => namespace.getByName(id).current(),
    async commit(id, token, manifest) {
      // DO generations are numbers. Reject alternate encodings rather than letting
      // Number accept whitespace, exponents, signs, or unsafe rounded integers.
      if (!/^[1-9][0-9]*$/u.test(token)) return false;
      const generation = Number(token);
      if (!Number.isSafeInteger(generation)) return false;
      return namespace.getByName(id).commit(generation, manifest);
    },
  };
}

export function createCloudflareOptions(env: CloudflareBindings): HubServerOptions {
  return {
    artifacts: createR2ArtifactStore(env.FILES),
    publications: createDurableObjectPublicationStore(env.VERSIONS),
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
