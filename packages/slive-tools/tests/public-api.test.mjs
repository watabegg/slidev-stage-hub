import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { connectStage, prepareStage, StageToolsError } from '../dist/index.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = 'a'.repeat(64);
const remoteDeck = {
  id: 'course/topic-1',
  revision: 'remote-revision',
  entry: '/course/topic-1/1',
  clickTotals: [0, 1],
};

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stage-tools-public-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createLocalInput(directory, { receiptName, sourceTarget } = {}) {
  const site = path.join(directory, 'hub', 'site');
  const fixturesRoot = path.join(directory, 'approved-fixtures');
  const sourceDirectory = path.join(fixturesRoot, 'course/topic-1');
  const source = path.join(sourceDirectory, 'slides.md');
  const configPath = path.join(directory, 'config', 'local-config.json');
  await mkdir(path.join(site, 'course/topic-1'), { recursive: true });
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(path.join(site, 'course/topic-1/index.html'), '<main>initial</main>\n');
  await writeFile(
    sourceTarget ?? source,
    '# First\n\n<!-- speaker note one -->\n---\n# Second\n\n<!-- speaker note two -->\n',
  );
  if (sourceTarget && sourceTarget !== source) await symlink(sourceTarget, source);

  const deck = { id: 'course/topic-1', entry: '/course/topic-1/1', revision, pages: 2 };
  const manifest = { schemaVersion: 1, decks: [deck] };
  await writeFile(path.join(site, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  const receipt = {
    schemaVersion: 1,
    output: path.resolve(site),
    sourceRoot: path.join(directory, 'untrusted-receipt-source-root'),
    decks: [
      {
        id: deck.id,
        sourcePath: source,
        revision: deck.revision,
        sourceRevision: createHash('sha256').update('older source snapshot').digest('hex'),
      },
    ],
  };
  const receiptPath = receiptName ? path.join(directory, receiptName) : `${site}.receipt.json`;
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, JSON.stringify(receipt));
  return { site, fixturesRoot, source, configPath, receiptPath };
}

test('public prepare API uses absolute inputs from an empty working directory', async () => {
  await withTempDir(async (directory) => {
    const emptyCwd = path.join(directory, 'empty-cwd');
    await mkdir(emptyCwd);
    const input = await createLocalInput(directory);
    const options = {
      site: input.site,
      fixturesRoot: input.fixturesRoot,
      configPath: input.configPath,
      receiptPath: input.receiptPath,
    };
    const serviceUrl = pathToFileURL(path.join(packageRoot, 'dist/index.js')).href;
    const source = [
      'const { prepareStage } = await import(process.argv[1]);',
      'const result = await prepareStage(JSON.parse(process.argv[2]));',
      'process.stdout.write(JSON.stringify({ config: result.config, configPath: result.configPath, siteRoot: result.siteRoot }));',
    ].join('\n');
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', source, serviceUrl, JSON.stringify(options)],
      { cwd: emptyCwd, encoding: 'utf8', env: {} },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.config.schemaVersion, 1);
    assert.equal(result.config.siteRoot, result.siteRoot);
    assert.equal(result.config.approvedSourceRoot, await realpath(input.fixturesRoot));
    assert.equal(path.dirname(result.configPath), path.dirname(input.configPath));
    assert.match(result.siteRoot, /\/versions\/[0-9a-f-]+\/site$/);
    assert.equal(
      await readFile(path.join(path.dirname(result.siteRoot), 'site-provenance.json'), 'utf8').then(
        (source) => JSON.parse(source).sourceSite,
      ),
      await realpath(input.site),
    );
    assert.equal(
      await readFile(path.join(result.siteRoot, 'course/topic-1/index.html'), 'utf8'),
      '<main>initial</main>\n',
    );
    assert.deepEqual(JSON.parse(await readFile(result.configPath, 'utf8')), result.config);
    assert.equal((await lstat(result.configPath)).mode & 0o777, 0o600);
    assert.equal(result.config.notes['course/topic-1'].source, await realpath(input.source));
    assert.equal(result.config.notes['course/topic-1'].slots.length, 2);
    assert.notEqual(result.config.notes['course/topic-1'].revision, revision);
  });
});

test('explicit receipt paths are honored and receipt sourceRoot never grants access', async () => {
  await withTempDir(async (directory) => {
    const input = await createLocalInput(directory, { receiptName: 'private/build-receipt.json' });
    await rm(`${input.site}.receipt.json`, { force: true });
    const result = await prepareStage({
      site: input.site,
      fixturesRoot: input.fixturesRoot,
      configPath: input.configPath,
      receiptPath: input.receiptPath,
    });
    assert.equal(result.config.notes['course/topic-1'].source, await realpath(input.source));
  });
});

test('source symlinks resolving outside the approved root fail before publication', async () => {
  await withTempDir(async (directory) => {
    const outside = path.join(directory, 'outside', 'slides.md');
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, '# First\n---\n# Second\n');
    const input = await createLocalInput(directory, { sourceTarget: outside });
    await assert.rejects(
      prepareStage({
        site: input.site,
        fixturesRoot: input.fixturesRoot,
        configPath: input.configPath,
        receiptPath: input.receiptPath,
      }),
      (error) =>
        error instanceof StageToolsError &&
        /outside the approved fixtures root/.test(error.message),
    );
    await assert.rejects(readFile(input.configPath), { code: 'ENOENT' });
    await assert.rejects(readdir(path.join(path.dirname(input.configPath), 'versions')), {
      code: 'ENOENT',
    });
  });
});

test('config outputs nested in the source site are rejected before recursive copy', async () => {
  await withTempDir(async (directory) => {
    const input = await createLocalInput(directory);
    const configPath = path.join(input.site, 'local-config.json');
    await assert.rejects(
      prepareStage({
        site: input.site,
        fixturesRoot: input.fixturesRoot,
        configPath,
        receiptPath: input.receiptPath,
      }),
      (error) => error instanceof StageToolsError && /must not overlap/.test(error.message),
    );
    await assert.rejects(readFile(configPath), { code: 'ENOENT' });
    await assert.rejects(readdir(path.join(input.site, 'versions')), { code: 'ENOENT' });
  });
});

test('a promote failure preserves the prior config and site and removes unpublished versions', async () => {
  await withTempDir(async (directory) => {
    const input = await createLocalInput(directory);
    const first = await prepareStage({
      site: input.site,
      fixturesRoot: input.fixturesRoot,
      configPath: input.configPath,
      receiptPath: input.receiptPath,
    });
    const originalConfig = await readFile(input.configPath, 'utf8');
    const originalSite = await readFile(
      path.join(first.siteRoot, 'course/topic-1/index.html'),
      'utf8',
    );
    await writeFile(path.join(input.site, 'course/topic-1/index.html'), '<main>updated</main>\n');

    await assert.rejects(
      prepareStage({
        site: input.site,
        fixturesRoot: input.fixturesRoot,
        configPath: input.configPath,
        receiptPath: input.receiptPath,
        onProgress({ phase }) {
          if (phase === 'promote') throw new Error('injected promote failure');
        },
      }),
      /injected promote failure/,
    );
    assert.equal(await readFile(input.configPath, 'utf8'), originalConfig);
    assert.equal(
      await readFile(path.join(first.siteRoot, 'course/topic-1/index.html'), 'utf8'),
      originalSite,
    );
    assert.deepEqual(await readdir(path.join(path.dirname(input.configPath), 'versions')), [
      path.basename(path.dirname(first.siteRoot)),
    ]);
  });
});

test('a manifest rebuild during copy fails closed and preserves the previous version pointer', async () => {
  await withTempDir(async (directory) => {
    const input = await createLocalInput(directory);
    const first = await prepareStage({
      site: input.site,
      fixturesRoot: input.fixturesRoot,
      configPath: input.configPath,
      receiptPath: input.receiptPath,
    });
    const originalConfig = await readFile(input.configPath, 'utf8');
    const originalManifest = JSON.parse(
      await readFile(path.join(input.site, 'manifest.json'), 'utf8'),
    );
    await assert.rejects(
      prepareStage({
        site: input.site,
        fixturesRoot: input.fixturesRoot,
        configPath: input.configPath,
        receiptPath: input.receiptPath,
        async onProgress({ phase }) {
          if (phase === 'copy')
            await writeFile(
              path.join(input.site, 'manifest.json'),
              JSON.stringify({ ...originalManifest, rebuild: 2 }),
            );
        },
      }),
      /manifest changed while the site was being prepared/,
    );
    assert.equal(await readFile(input.configPath, 'utf8'), originalConfig);
    assert.equal(
      await readFile(path.join(first.siteRoot, 'course/topic-1/index.html'), 'utf8'),
      '<main>initial</main>\n',
    );
    assert.deepEqual(await readdir(path.join(path.dirname(input.configPath), 'versions')), [
      path.basename(path.dirname(first.siteRoot)),
    ]);
  });
});

test('connect writes schema v1 mode 0600 and a failed fetch leaves the config unchanged', async () => {
  await withTempDir(async (directory) => {
    const configPath = path.join(directory, 'config', 'local-config.json');
    const response = {
      schemaVersion: 1,
      protocolVersion: 1,
      decks: [remoteDeck],
      unsupportedDecks: [{ id: 'course/ignored', reason: 'unsupported' }],
    };
    const connected = await connectStage({
      origin: 'http://127.0.0.1:4173',
      configPath,
      fetchImpl: async (url, init) => {
        assert.equal(url, 'http://127.0.0.1:4173/native-player.json');
        assert.equal(init.redirect, 'manual');
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.deepEqual(connected.config, {
      schemaVersion: 1,
      decks: [remoteDeck],
      notes: {},
      approvedSourceRoot: path.dirname(configPath),
      viewerOrigin: 'http://127.0.0.1:4173',
    });
    assert.deepEqual(connected.unsupportedDecks, [{ id: 'course/ignored', reason: 'unsupported' }]);
    assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
    const original = await readFile(configPath, 'utf8');
    await assert.rejects(
      connectStage({
        origin: 'http://127.0.0.1:4173',
        configPath,
        fetchImpl: async () => new Response('invalid manifest', { status: 200 }),
      }),
      /did not return valid JSON/,
    );
    assert.equal(await readFile(configPath, 'utf8'), original);
  });
});

test('connect persists validated v2 playback metadata in schema v1 local config', async () => {
  await withTempDir(async (directory) => {
    const configPath = path.join(directory, 'config', 'local-config.json');
    const v2Deck = {
      ...remoteDeck,
      playback: { kind: 'revision-query', parameter: 'revision' },
    };
    const result = await connectStage({
      origin: 'http://127.0.0.1:4173',
      configPath,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 2,
            protocolVersion: 1,
            decks: [v2Deck],
            unsupportedDecks: [],
          }),
          { status: 200 },
        ),
    });
    assert.deepEqual(result.config.decks, [v2Deck]);
    assert.equal(result.config.schemaVersion, 1);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).decks, [v2Deck]);
  });
});

test('connect stores only the absolute auth file path and never writes header values', async () => {
  await withTempDir(async (directory) => {
    const origin = 'https://slides.example.com';
    const configPath = path.join(directory, 'config', 'local-config.json');
    const headersFile = path.join(directory, 'auth.json');
    const secret = 'Bearer STAGE_TOOLS_CANARY';
    await writeFile(headersFile, JSON.stringify({ origin, headers: { Authorization: secret } }), {
      mode: 0o600,
    });
    await chmod(headersFile, 0o600);
    const result = await connectStage({
      origin,
      configPath,
      headersFile,
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Authorization, secret);
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            protocolVersion: 1,
            decks: [remoteDeck],
            unsupportedDecks: [],
          }),
          { status: 200 },
        );
      },
    });
    const serialized = await readFile(configPath, 'utf8');
    assert.equal(result.config.authHeadersFile, headersFile);
    assert.equal(serialized.includes(secret), false);
  });
});

test('connect reports a typed error for invalid JavaScript options', async () => {
  await assert.rejects(
    connectStage(undefined),
    (error) => error instanceof StageToolsError && error.code === 'CONNECT_FAILED',
  );
});
