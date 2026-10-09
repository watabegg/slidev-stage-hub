import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { promoteBuild, withBuildWorkspace } from '../dist/node/artifacts.js';
import { HubBuildError, normalizeHubConfig } from '../dist/node/config.js';

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slidev-hub-service-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createConfigWorkspace(directory) {
  const base = path.join(directory, 'config-root');
  const sourceRoot = path.join(base, 'source');
  const dependencyRoot = path.join(base, 'dependency');
  const theme = path.join(base, 'theme');
  const deckEntry = path.join(sourceRoot, 'course/topic.md');
  const configPath = path.join(base, 'hub.config.json');
  const config = {
    schemaVersion: 1,
    sourceRoot: 'source',
    outDir: 'output/site',
    dependencyRoot: 'dependency',
    theme: 'theme',
    decks: [{ id: 'course/topic', entry: 'source/course/topic.md' }],
    offline: false,
  };

  await mkdir(path.dirname(deckEntry), { recursive: true });
  await mkdir(dependencyRoot, { recursive: true });
  await mkdir(theme, { recursive: true });
  await writeFile(deckEntry, '# Topic\n');
  await writeFile(configPath, JSON.stringify(config));
  return { base, sourceRoot, dependencyRoot, theme, deckEntry, configPath, config };
}

function isConfigError(pattern) {
  return (error) =>
    error instanceof HubBuildError && error.code === 'CONFIG' && pattern.test(error.message);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('absolute config paths resolve their relative fields from the config file directory', async () => {
  await withTempDir(async (directory) => {
    const workspace = await createConfigWorkspace(directory);
    const normalized = await normalizeHubConfig({ configPath: workspace.configPath });

    assert.equal(normalized.sourceRoot, workspace.sourceRoot);
    assert.equal(normalized.outDir, path.join(workspace.base, 'output/site'));
    assert.equal(normalized.dependencyRoot, workspace.dependencyRoot);
    assert.equal(normalized.theme, workspace.theme);
    assert.equal(normalized.decks[0].entry, workspace.deckEntry);
    assert.deepEqual(normalized.decks[0].categoryPath, ['course']);
    assert.equal(normalized.offline, false);
  });
});

test('explicit options override file values and relative overrides stay file-relative', async () => {
  await withTempDir(async (directory) => {
    const workspace = await createConfigWorkspace(directory);
    const overrideTheme = path.join(workspace.base, 'override-theme');
    const alternateEntry = path.join(workspace.sourceRoot, 'course/alternate.md');
    await mkdir(overrideTheme, { recursive: true });
    await writeFile(alternateEntry, '# Alternate\n');

    const normalized = await normalizeHubConfig({
      configPath: workspace.configPath,
      outDir: 'override-output/site',
      theme: overrideTheme,
      offline: true,
      bootstrap: 'tla',
      isolateDecks: true,
      decks: [{ id: 'course/alternate', entry: 'source/course/alternate.md' }],
    });

    assert.equal(normalized.outDir, path.join(workspace.base, 'override-output/site'));
    assert.equal(normalized.theme, overrideTheme);
    assert.equal(normalized.offline, true);
    assert.equal(normalized.bootstrap, 'tla');
    assert.equal(normalized.isolateDecks, true);
    assert.equal(normalized.decks[0].id, 'course/alternate');
    assert.equal(normalized.decks[0].entry, alternateEntry);
  });
});

test('unknown keys, invalid profiles, overlapping roots, and invalid deck IDs fail as config errors', async () => {
  await withTempDir(async (directory) => {
    const workspace = await createConfigWorkspace(directory);
    const profile = { dependencyRoot: 'dependency', theme: 'theme' };

    await assert.rejects(
      normalizeHubConfig({ configPath: workspace.configPath, unexpected: true }),
      isConfigError(/options: unknown key unexpected/),
    );

    const unknownConfigPath = path.join(workspace.base, 'unknown.config.json');
    await writeFile(unknownConfigPath, JSON.stringify({ ...workspace.config, unrecognized: true }));
    await assert.rejects(
      normalizeHubConfig({ configPath: unknownConfigPath }),
      isConfigError(/config: unknown key unrecognized/),
    );

    await assert.rejects(
      normalizeHubConfig({
        configPath: workspace.configPath,
        profiles: { default: { ...profile, extra: true } },
      }),
      isConfigError(/profile default: unknown key extra/),
    );
    await assert.rejects(
      normalizeHubConfig({
        configPath: workspace.configPath,
        profiles: { 'team/default': profile },
      }),
      isConfigError(/invalid profile team\/default/),
    );
    await assert.rejects(
      normalizeHubConfig({
        configPath: workspace.configPath,
        profiles: { default: profile },
        decks: [{ id: 'course/topic', entry: 'source/course/topic.md', profile: 'missing' }],
      }),
      isConfigError(/requires a declared profile/),
    );

    await assert.rejects(
      normalizeHubConfig({
        configPath: workspace.configPath,
        outDir: path.join(workspace.sourceRoot, 'generated'),
      }),
      isConfigError(/sourceRoot and outDir must be separate trees/),
    );
    await assert.rejects(
      normalizeHubConfig({
        configPath: workspace.configPath,
        decks: [{ id: '../escape', entry: 'source/course/topic.md' }],
      }),
      isConfigError(/invalid deck id/),
    );
  });
});

test('a failed build workspace action leaves the existing output and receipt intact', async () => {
  await withTempDir(async (directory) => {
    const outDir = path.join(directory, 'published/site');
    const receiptPath = `${outDir}.receipt.json`;
    const lockPath = path.join(path.dirname(outDir), '.site.build-lock');
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'index.html'), 'old site');
    await writeFile(receiptPath, 'old receipt');
    let workDir;

    await assert.rejects(
      withBuildWorkspace(outDir, async (workspace) => {
        workDir = workspace;
        await writeFile(path.join(workspace, 'partial-output'), 'partial');
        throw new Error('build action failed');
      }),
      /build action failed/,
    );

    assert.equal(await readFile(path.join(outDir, 'index.html'), 'utf8'), 'old site');
    assert.equal(await readFile(receiptPath, 'utf8'), 'old receipt');
    assert.equal(await exists(workDir), false);
    assert.equal(await exists(lockPath), false);
  });
});

test('promotion rolls both existing outputs back when the staged receipt is missing', async () => {
  await withTempDir(async (directory) => {
    const outDir = path.join(directory, 'published/site');
    const receiptPath = `${outDir}.receipt.json`;
    const workDir = path.join(directory, 'work');
    const stagedSite = path.join(workDir, 'site');
    const stagedReceipt = path.join(workDir, 'receipt.json');
    await mkdir(outDir, { recursive: true });
    await mkdir(stagedSite, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(path.join(outDir, 'index.html'), 'old site');
    await writeFile(receiptPath, 'old receipt');
    await writeFile(path.join(stagedSite, 'index.html'), 'new site');

    await assert.rejects(
      promoteBuild(stagedSite, stagedReceipt, outDir, workDir),
      (error) => error instanceof HubBuildError && error.code === 'OUTPUT',
    );

    assert.equal(await readFile(path.join(outDir, 'index.html'), 'utf8'), 'old site');
    assert.equal(await readFile(receiptPath, 'utf8'), 'old receipt');
  });
});

test('concurrent builds targeting the same output are rejected by the output lock', async () => {
  await withTempDir(async (directory) => {
    const outDir = path.join(directory, 'published/site');
    let markEntered;
    let releaseFirst;
    const entered = new Promise((resolve) => {
      markEntered = resolve;
    });
    const held = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let secondActionRan = false;
    const first = withBuildWorkspace(outDir, async () => {
      markEntered();
      await held;
      return 'first build completed';
    });

    try {
      await entered;
      await assert.rejects(
        withBuildWorkspace(outDir, async () => {
          secondActionRan = true;
        }),
        (error) => error instanceof HubBuildError && error.code === 'OUTPUT_BUSY',
      );
      assert.equal(secondActionRan, false);
    } finally {
      releaseFirst();
    }

    assert.equal(await first, 'first build completed');
  });
});

test('legacy environment conflicts warn without exposing values', async () => {
  const { legacyOptions } = await import('../scripts/legacy-options.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-legacy-warning-'));
  try {
    const configPath = path.join(directory, 'hub.json');
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sourceRoot: './slides',
        outDir: './site',
        theme: './configured-theme',
      }),
    );
    const warnings = [];
    const options = await legacyOptions(
      { SLIDEV_LAB_CONFIG: configPath, SLIDEV_LAB_THEME: '/private-override' },
      (message) => warnings.push(message),
    );
    assert.equal(options.theme, '/private-override');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /theme/);
    assert.ok(!warnings[0].includes('/private-override'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
