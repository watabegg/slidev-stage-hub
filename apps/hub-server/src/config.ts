import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  createHubServer,
  runtimeSnapshotFromManifest,
  type ArtifactStore,
  type PublicationStore,
  type PublicationJobStore,
  type HubServerOptions,
} from '@slidev-stage-hub/server';
import {
  createFileArtifactStore,
  createMemoryPublicationStore,
  createMemoryPublicationJobStore,
  createStaticAssets,
} from '@slidev-stage-hub/adapter-node';
import { createS3ArtifactStore } from '@slidev-stage-hub/storage-s3';
import { createGcsArtifactStore } from '@slidev-stage-hub/storage-gcs';
import {
  createPostgresPublicationStore,
  initializePostgresPublicationStore,
  createPostgresPublicationJobStore,
  initializePostgresPublicationJobStore,
} from '@slidev-stage-hub/state-postgres';
import { startPublicationJobWorker } from './job-worker.js';

type Environment = Readonly<Record<string, string | undefined>>;
function required(env: Environment, key: string): string {
  const value = env[key];
  if (!value?.trim()) throw new Error(`${key} is required`);
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function names(value: unknown, label: string): string {
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string'))
    throw new Error(`Runtime manifest ${label} must be a list of strings`);
  return JSON.stringify(value);
}

/** Compose the reference application. Library users can inject their own drivers directly. */
export async function createConfiguredHub(env: Environment = process.env) {
  const staticRoot = resolve(
    env.HUB_STATIC_DIR ??
      fileURLToPath(new URL('../../hub-worker/artifacts/site/', import.meta.url)),
  );
  const manifest: unknown = JSON.parse(
    await readFile(resolve(staticRoot, 'runtime-manifest.json'), 'utf8'),
  );
  if (
    !record(manifest) ||
    typeof manifest.profileDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.profileDigest) ||
    !record(manifest.theme) ||
    typeof manifest.theme.name !== 'string'
  )
    throw new Error('A built Hub runtime-manifest.json is required');
  const profile = {
    digest: manifest.profileDigest,
    theme: manifest.theme.name,
    layouts: names(manifest.layouts, 'layouts'),
    components: names(manifest.components, 'components'),
  };
  const runtime = runtimeSnapshotFromManifest(manifest);
  const storage = env.HUB_STORAGE ?? 'filesystem';
  const state = env.HUB_PUBLICATIONS ?? 'memory';
  if (env.NODE_ENV === 'production' && (storage === 'filesystem' || state === 'memory'))
    throw new Error(
      'Production requires durable external storage and publications (s3/gcs and postgres)',
    );
  let artifacts: ArtifactStore;
  if (storage === 'filesystem')
    artifacts = createFileArtifactStore({
      root: resolve(env.HUB_ARTIFACT_DIR ?? 'artifacts/hub-server/objects'),
    });
  else if (storage === 's3')
    artifacts = createS3ArtifactStore({
      bucket: required(env, 'HUB_BUCKET'),
      ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
      ...(env.HUB_S3_ENDPOINT ? { endpoint: env.HUB_S3_ENDPOINT } : {}),
      forcePathStyle: env.HUB_S3_FORCE_PATH_STYLE === 'true',
    });
  else if (storage === 'gcs')
    artifacts = createGcsArtifactStore({
      bucket: required(env, 'HUB_BUCKET'),
      ...(env.GOOGLE_CLOUD_PROJECT ? { projectId: env.GOOGLE_CLOUD_PROJECT } : {}),
    });
  else throw new Error('HUB_STORAGE must be filesystem, s3 or gcs');
  let publications: PublicationStore;
  let pool: Pool | undefined;
  let jobs: PublicationJobStore | undefined;
  let renderer:
    | Awaited<
        ReturnType<
          typeof import('@slidev-stage-hub/renderer-playwright').createPlaywrightThumbnailRenderer
        >
      >
    | undefined;
  let worker: ReturnType<typeof startPublicationJobWorker> | undefined;
  const jobsConfigured = env.HUB_JOBS_ENABLED !== undefined;
  if (jobsConfigured && !['true', 'false'].includes(env.HUB_JOBS_ENABLED!))
    throw new Error('HUB_JOBS_ENABLED must be true or false');
  const rendererName = env.HUB_THUMBNAIL_RENDERER ?? 'none';
  if (!['none', 'playwright'].includes(rendererName))
    throw new Error('HUB_THUMBNAIL_RENDERER must be none or playwright');
  let publicOrigin: string | undefined;
  if (env.HUB_PUBLIC_ORIGIN) {
    const parsed = new URL(env.HUB_PUBLIC_ORIGIN);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('HUB_PUBLIC_ORIGIN must be an HTTP(S) origin');
    publicOrigin = parsed.origin;
  }
  try {
    if (state === 'memory') {
      jobs = jobsConfigured ? createMemoryPublicationJobStore() : undefined;
      publications = jobs?.publications ?? createMemoryPublicationStore();
    } else if (state === 'postgres') {
      pool = new Pool({ connectionString: required(env, 'HUB_DATABASE_URL'), max: 5 });
      if (env.HUB_DATABASE_INIT === 'true') {
        if (jobsConfigured) await initializePostgresPublicationJobStore(pool);
        else await initializePostgresPublicationStore(pool);
      }
      jobs = jobsConfigured ? createPostgresPublicationJobStore({ pool }) : undefined;
      publications = jobs?.publications ?? createPostgresPublicationStore({ pool });
    } else throw new Error('HUB_PUBLICATIONS must be memory or postgres');
    if (rendererName === 'playwright') {
      if (!publicOrigin) throw new Error('HUB_PUBLIC_ORIGIN is required for the renderer');
      const { createPlaywrightThumbnailRenderer } =
        await import('@slidev-stage-hub/renderer-playwright');
      renderer = createPlaywrightThumbnailRenderer({
        executablePath: required(env, 'HUB_CHROMIUM_EXECUTABLE'),
        publicOrigin,
      });
    }
    const options: HubServerOptions = {
      artifacts,
      publications,
      onJobEvent: (event) => console.log(JSON.stringify(event)),
      staticAssets: createStaticAssets({ root: staticRoot }),
      profile,
      loadRuntime: async () => runtime,
      publishToken: env.HUB_PUBLISH_TOKEN,
      allowLocalMutations: env.HUB_ALLOW_LOCAL_MUTATIONS === 'true',
      ...(jobs ? { jobs, jobsEnabled: env.HUB_JOBS_ENABLED === 'true' } : {}),
      ...(publicOrigin ? { publicOrigin } : {}),
      ...(renderer ? { renderThumbnail: renderer.renderThumbnail } : {}),
    };
    const server = createHubServer(options);
    let closing: Promise<void> | undefined;
    return {
      server,
      staticRoot,
      startWorker: () => {
        if (closing) throw new Error('The application is closing');
        if (worker) throw new Error('A job worker is already running');
        worker = startPublicationJobWorker(options, {
          onError: () => console.error(JSON.stringify({ event: 'hub.worker.attempt_failed' })),
        });
      },
      close: () =>
        (closing ??= (async () => {
          try {
            await worker?.close();
          } finally {
            try {
              await renderer?.close();
            } finally {
              await pool?.end();
            }
          }
        })()),
    };
  } catch (error) {
    await renderer?.close();
    await pool?.end();
    throw error;
  }
}
