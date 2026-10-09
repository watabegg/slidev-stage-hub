import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Theme source and toolchain are independent. A theme need not install the CLI.
export function themeDirectory(env = process.env) {
  const configured = env.SLIDEV_THEME_PATH || env.SLIDEV_LAB_THEME || env.SLIDEV_THEME_DIR;
  return configured
    ? resolve(configured)
    : dirname(require.resolve('@slidev/theme-default/package.json'));
}

export function dependencyDirectory(env = process.env) {
  return resolve(env.SLIDEV_LAB_DEPENDENCY_ROOT || repositoryRoot);
}

export function slidevRequire(directory = dependencyDirectory()) {
  const dependencies = createRequire(resolve(directory, 'package.json'));
  return createRequire(dependencies.resolve('@slidev/cli/package.json'));
}
