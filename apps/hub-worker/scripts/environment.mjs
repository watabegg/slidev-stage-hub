import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export function themeDirectory(env = process.env) {
  const configured = env.SLIDEV_THEME_PATH || env.SLIDEV_LAB_THEME || env.SLIDEV_THEME_DIR;
  return configured
    ? resolve(configured)
    : dirname(require.resolve('@slidev/theme-default/package.json'));
}
export function dependencyDirectory(env = process.env) {
  return env.SLIDEV_LAB_DEPENDENCY_ROOT ? resolve(env.SLIDEV_LAB_DEPENDENCY_ROOT) : workerRoot;
}
