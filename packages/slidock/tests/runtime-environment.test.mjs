import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  dependencyDirectory,
  repositoryRoot,
  slidevRequire,
  themeDirectory,
} from '../scripts/runtime-environment.mjs';

test('default theme and CLI resolve inside this checkout regardless of cwd', () => {
  const cwd = process.cwd();
  const elsewhere = mkdtempSync(join(tmpdir(), 'stage-hub-environment-'));
  try {
    process.chdir(elsewhere);
    assert.ok(themeDirectory({}).startsWith(repositoryRoot + '/'));
    assert.equal(slidevRequire(repositoryRoot)('@slidev/cli/package.json').version, '53.0.0');
    assert.equal(dependencyDirectory({}), join(repositoryRoot, 'packages/slidock'));
  } finally {
    process.chdir(cwd);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('theme overrides preserve aliases without changing the toolchain', () => {
  assert.equal(
    themeDirectory({ SLIDEV_THEME_PATH: './custom-theme', SLIDEV_LAB_THEME: './legacy' }),
    resolve('custom-theme'),
  );
  assert.equal(themeDirectory({ SLIDEV_LAB_THEME: './legacy' }), resolve('legacy'));
  assert.equal(themeDirectory({ SLIDEV_THEME_DIR: './stage-legacy' }), resolve('stage-legacy'));
  assert.equal(
    dependencyDirectory({ SLIDEV_THEME_PATH: './custom-theme' }),
    join(repositoryRoot, 'packages/slidock'),
  );
  assert.equal(
    dependencyDirectory({ SLIDEV_LAB_DEPENDENCY_ROOT: './examples/slidev52' }),
    resolve('examples/slidev52'),
  );
});
