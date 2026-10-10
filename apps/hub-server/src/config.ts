import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  createHubServer,
  runtimeSnapshotFromManifest,
  type ArtifactStore,
  type PublicationStore,
} from '@slidev-stage-hub/server';
import {
  createFileArtifactStore,
  createMemoryPublicationStore,
  createStaticAssets,
} from '@slidev-stage-hub/adapter-node';
import { createS3ArtifactStore } from '@slidev-stage-hub/storage-s3';
import { createGcsArtifactStore } from '@slidev-stage-hub/storage-gcs';
import {
  createPostgresPublicationStore,
  initializePostgresPublicationStore,
} from '@slidev-stage-hub/state-postgres';

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
  try {
    if (state === 'memory') publications = createMemoryPublicationStore();
    else if (state === 'postgres') {
      pool = new Pool({ connectionString: required(env, 'HUB_DATABASE_URL'), max: 5 });
      if (env.HUB_DATABASE_INIT === 'true') await initializePostgresPublicationStore(pool);
      publications = createPostgresPublicationStore({ pool });
    } else throw new Error('HUB_PUBLICATIONS must be memory or postgres');
    const server = createHubServer({
      artifacts,
      publications,
      staticAssets: createStaticAssets({ root: staticRoot }),
      profile,
      loadRuntime: async () => runtime,
      publishToken: env.HUB_PUBLISH_TOKEN,
      allowLocalMutations: env.HUB_ALLOW_LOCAL_MUTATIONS === 'true',
    });
    return {
      server,
      staticRoot,
      close: async () => {
        await pool?.end();
      },
    };
  } catch (error) {
    await pool?.end();
    throw error;
  }
}
