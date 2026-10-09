import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repositoryRoot } from './runtime-environment.mjs';

const require = createRequire(import.meta.url);
const hub = join(repositoryRoot, 'packages/hub');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('SLIDEV_')) delete env[key];
Object.assign(env, {
  SLIDEV_THEME_PATH: dirname(require.resolve('slidev-theme-watabegg/package.json')),
  SLIDEV_LAB_FIXTURES_ROOT: join(repositoryRoot, 'examples/watabegg'),
  SLIDEV_LAB_ARTIFACT_NAME: 'example-watabegg',
});
for (const args of [
  ['bundle-sharing/experiments/module-graph/build.mjs'],
  [
    'scripts/prepare-offline.mjs',
    'artifacts/example-watabegg/site',
    'artifacts/example-watabegg-offline/site',
  ],
]) {
  const result = spawnSync(process.execPath, args, { cwd: hub, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
