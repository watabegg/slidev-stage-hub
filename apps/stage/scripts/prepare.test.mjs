import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  canonicalEntryForId,
  inspectDeckSource,
  loadSlidevParser,
  parseArgs,
  readManifestIfPresent,
  resolveManifestSources,
  validateManifest,
} from './prepare.mjs';

const revisionA = 'a'.repeat(64);
const revisionB = 'b'.repeat(64);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function manifestDeck(id, sourcePath, revision = revisionA, pages = 2) {
  return { id, sourcePath, entry: canonicalEntryForId(id), revision, pages };
}

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slidev-native-prepare-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('CLI accepts named options and the legacy positional site', () => {
  const cwd = '/tmp/prepare-cli';
  assert.deepEqual(
    parseArgs(['--fixtures-root', 'experiment/fixtures', '--site', 'experiment/site'], { cwd }),
    {
      site: path.join(cwd, 'experiment/site'),
      fixturesRoot: path.join(cwd, 'experiment/fixtures'),
    },
  );
  assert.deepEqual(parseArgs(['legacy/site'], { cwd }), {
    site: path.join(cwd, 'legacy/site'),
    fixturesRoot: path.join(repoRoot, 'examples/fixtures'),
  });
  assert.throws(
    () => parseArgs(['--site', 'one', 'two'], { cwd }),
    /either --site or a positional path/,
  );
  assert.throws(() => parseArgs(['--fixtures-root'], { cwd }), /requires a path/);
});

test('manifest validation preserves its deck order and rejects unsafe or inconsistent fields', () => {
  const manifest = {
    schemaVersion: 1,
    decks: [
      manifestDeck('theme-a/topic-one', 'fixtures/theme-a/topic-one/slides.md', revisionA),
      manifestDeck('theme-b/topic-two', 'fixtures/theme-b/topic-two/slides.md', revisionB, 5),
    ],
  };
  assert.deepEqual(
    validateManifest(manifest).decks.map((deck) => [deck.id, deck.entry, deck.revision]),
    [
      ['theme-a/topic-one', '/theme-a/topic-one/1', revisionA],
      ['theme-b/topic-two', '/theme-b/topic-two/1', revisionB],
    ],
  );
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        decks: [
          {
            id: '../outside',
            sourcePath: 'x.md',
            entry: '/../outside/1',
            revision: revisionA,
            pages: 1,
          },
        ],
      }),
    /unsupported native id/,
  );
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        decks: [
          {
            id: 'unicode/資料',
            sourcePath: 'x.md',
            entry: '/unicode/%E8%B3%87%E6%96%99/1',
            revision: revisionA,
            pages: 1,
          },
        ],
      }),
    /unsupported native id/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, decks: [{ ...manifest.decks[0], entry: '/wrong/1' }] }),
    /canonical route/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, decks: [{ ...manifest.decks[0], pages: 0 }] }),
    /positive integer/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, decks: [manifest.decks[0], manifest.decks[0]] }),
    /duplicate deck id/,
  );
  assert.throws(
    () => validateManifest({ schemaVersion: 2, decks: manifest.decks }),
    /schemaVersion must be 1/,
  );
});

test('an existing malformed public manifest is an error, while an absent one selects fallback mode', async () => {
  await withTempDir(async (directory) => {
    assert.equal(await readManifestIfPresent(directory), null);
    await writeFile(path.join(directory, 'manifest.json'), '{ invalid json');
    await assert.rejects(readManifestIfPresent(directory), /invalid public manifest JSON/);
    await writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, decks: [] }),
    );
    await assert.rejects(readManifestIfPresent(directory), /non-empty decks array/);
  });
});

test('source paths resolve from the Hub root and realpaths must remain inside the approved fixtures root', async () => {
  await withTempDir(async (directory) => {
    const hubRoot = path.join(directory, 'packages/hub');
    const fixturesRoot = path.join(directory, 'examples/fixtures');
    const deckDirectory = path.join(fixturesRoot, 'theme-a/topic-one');
    const outsideDirectory = path.join(directory, 'outside');
    await mkdir(deckDirectory, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(path.join(deckDirectory, 'slides.md'), '# Test\n');
    await writeFile(path.join(outsideDirectory, 'slides.md'), '# Outside\n');
    await symlink(path.join(outsideDirectory, 'slides.md'), path.join(deckDirectory, 'escape.md'));

    const valid = await resolveManifestSources(
      [manifestDeck('theme-a/topic-one', '../../examples/fixtures/theme-a/topic-one/slides.md')],
      hubRoot,
      fixturesRoot,
    );
    assert.equal(valid.approvedRoot, await realpath(fixturesRoot));
    assert.equal(valid.sources[0].source, await realpath(path.join(deckDirectory, 'slides.md')));

    await assert.rejects(
      resolveManifestSources(
        [manifestDeck('theme-a/topic-one', '../../examples/fixtures/theme-a/topic-one/escape.md')],
        hubRoot,
        fixturesRoot,
      ),
      /outside the approved fixtures root/,
    );
    await assert.rejects(
      resolveManifestSources(
        [manifestDeck('theme-a/topic-one', '../../examples/fixtures/theme-a/topic-one')],
        hubRoot,
        fixturesRoot,
      ),
      /is not a file/,
    );
  });
});

test('the installed Slidev parser supplies manifest-mode page, click, and note metadata', async () => {
  const { parseSync } = await loadSlidevParser();
  const text = [
    '# 一',
    '',
    '<div v-click>step one</div>',
    '',
    '<!-- presenter note 一 -->',
    '---',
    '# Two',
    '',
    '<p v-click>step two</p>',
    '',
    '<!-- presenter note two -->',
    '',
  ].join('\n');
  const inspected = inspectDeckSource({
    id: 'theme-a/topic-one',
    source: 'topic-one.md',
    text,
    parseSync,
  });
  assert.equal(inspected.pages, 2);
  assert.deepEqual(inspected.clickTotals, [1, 1]);
  assert.equal(
    Buffer.from(text).subarray(inspected.slots[0].start, inspected.slots[0].end).toString(),
    ' presenter note 一 ',
  );
  assert.equal(
    Buffer.from(text).subarray(inspected.slots[1].start, inspected.slots[1].end).toString(),
    ' presenter note two ',
  );
  assert.throws(
    () =>
      inspectDeckSource({
        id: 'theme-a/topic-one',
        source: 'topic-one.md',
        text: '<div v-click="2">step</div>',
        parseSync,
      }),
    /unsupported click syntax/,
  );
  for (const syntax of [
    '<div v-click.hide>step</div>',
    '<div v-after>step</div>',
    '<v-clicks>step</v-clicks>',
  ]) {
    assert.throws(
      () =>
        inspectDeckSource({
          id: 'theme-a/topic-one',
          source: 'topic-one.md',
          text: syntax,
          parseSync,
        }),
      /unsupported click syntax/,
    );
  }
});
