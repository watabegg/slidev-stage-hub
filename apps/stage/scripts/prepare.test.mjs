import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

function publicDeck(id = 'course/topic-one', revision = revisionA, pages = 2) {
  return { id, entry: canonicalEntryForId(id), revision, pages };
}

function receiptDeck(deck, sourcePath, sourceRevision = revisionA) {
  return { id: deck.id, sourcePath, revision: deck.revision, sourceRevision };
}

function publicManifest(decks) {
  return { schemaVersion: 1, decks };
}

function privateReceipt(site, sourceRoot, decks) {
  return { schemaVersion: 1, output: path.resolve(site), sourceRoot, decks };
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

test('joins a private source receipt in memory and leaves the public manifest unchanged', async () => {
  await withTempDir(async (directory) => {
    const site = path.join(directory, 'site');
    const fixturesRoot = path.join(directory, 'approved-fixtures');
    const source = path.join(fixturesRoot, 'course/topic-one/slides.md');
    const hubRoot = path.join(directory, 'packages/hub');
    const deck = publicDeck();
    const oldSource = Buffer.from('# prior source\n');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, '# edited source\n');
    await mkdir(site, { recursive: true });

    const publicBytes = `${JSON.stringify(publicManifest([deck]), null, 2)}\n`;
    await writeFile(path.join(site, 'manifest.json'), publicBytes);
    await writeFile(
      `${site}.receipt.json`,
      JSON.stringify(
        privateReceipt(site, path.join(directory, 'untrusted-receipt-root'), [
          receiptDeck(deck, source, createHash('sha256').update(oldSource).digest('hex')),
        ]),
      ),
    );

    const manifest = await readManifestIfPresent(site);
    assert.deepEqual(manifest.decks, [{ ...deck, sourcePath: source }]);
    assert.equal(await readFile(path.join(site, 'manifest.json'), 'utf8'), publicBytes);

    const resolved = await resolveManifestSources(manifest.decks, hubRoot, fixturesRoot);
    assert.equal(resolved.sources[0].source, await realpath(source));
  });
});

test('legacy manifests with sourcePath do not require an adjacent receipt', async () => {
  await withTempDir(async (directory) => {
    const site = path.join(directory, 'legacy-site');
    const manifest = publicManifest([
      manifestDeck('course/legacy', '../../examples/fixtures/course/legacy/slides.md'),
    ]);
    await mkdir(site, { recursive: true });
    await writeFile(path.join(site, 'manifest.json'), JSON.stringify(manifest));

    assert.deepEqual(await readManifestIfPresent(site), manifest);
  });
});

test('missing or invalid private receipts reject before modifying either input file', async () => {
  const cases = [
    {
      name: 'missing receipt',
      receipt: null,
      error: /private source receipt is required but missing/,
    },
    {
      name: 'output mismatch',
      receipt: (site, root, decks) => ({
        ...privateReceipt(site, root, decks),
        output: `${site}-other`,
      }),
      error: /output must match the resolved site path/,
    },
    {
      name: 'stale public deck revision',
      receipt: (site, root, decks) =>
        privateReceipt(site, root, [{ ...decks[0], revision: revisionB }]),
      error: /revision is stale/,
    },
    {
      name: 'duplicate receipt deck id',
      receipt: (site, root, decks) => privateReceipt(site, root, [...decks, decks[0]]),
      error: /duplicate deck id/,
    },
    {
      name: 'receipt omits a public deck',
      receipt: (site, root) => privateReceipt(site, root, []),
      error: /missing public deck/,
    },
    {
      name: 'receipt contains an unlisted deck',
      receipt: (site, root, decks) =>
        privateReceipt(site, root, [
          ...decks,
          {
            ...decks[0],
            id: 'course/unlisted',
            sourcePath: path.join(root, 'unlisted.md'),
          },
        ]),
      error: /deck list does not match/,
    },
    {
      name: 'receipt sourcePath is not absolute',
      receipt: (site, root, decks) =>
        privateReceipt(site, root, [{ ...decks[0], sourcePath: 'relative/slides.md' }]),
      error: /sourcePath must be a non-empty absolute path/,
    },
  ];

  for (const item of cases) {
    await withTempDir(async (directory) => {
      const site = path.join(directory, 'site');
      const sourceRoot = path.join(directory, 'source-root');
      const deck = publicDeck();
      const decks = [receiptDeck(deck, path.join(sourceRoot, 'slides.md'))];
      const publicBytes = `${JSON.stringify(publicManifest([deck]), null, 2)}\n`;
      const receipt = item.receipt?.(site, sourceRoot, decks);
      await mkdir(site, { recursive: true });
      await writeFile(path.join(site, 'manifest.json'), publicBytes);
      if (receipt) await writeFile(`${site}.receipt.json`, JSON.stringify(receipt));
      const receiptBytes = receipt && (await readFile(`${site}.receipt.json`, 'utf8'));

      await assert.rejects(readManifestIfPresent(site), item.error, item.name);
      assert.equal(await readFile(path.join(site, 'manifest.json'), 'utf8'), publicBytes);
      if (receiptBytes) assert.equal(await readFile(`${site}.receipt.json`, 'utf8'), receiptBytes);
    });
  }
});

test('a receipt source outside --fixtures-root is still rejected even when its sourceRoot names it', async () => {
  await withTempDir(async (directory) => {
    const site = path.join(directory, 'site');
    const fixturesRoot = path.join(directory, 'approved-fixtures');
    const outsideRoot = path.join(directory, 'outside-fixtures');
    const source = path.join(outsideRoot, 'course/topic-one/slides.md');
    const deck = publicDeck();
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(fixturesRoot, { recursive: true });
    await mkdir(site, { recursive: true });
    await writeFile(source, '# Outside\n');
    await writeFile(path.join(site, 'manifest.json'), JSON.stringify(publicManifest([deck])));
    await writeFile(
      `${site}.receipt.json`,
      JSON.stringify(
        privateReceipt(site, outsideRoot, [
          receiptDeck(deck, source, createHash('sha256').update('# Outside\n').digest('hex')),
        ]),
      ),
    );

    const manifest = await readManifestIfPresent(site);
    await assert.rejects(
      resolveManifestSources(manifest.decks, path.join(directory, 'packages/hub'), fixturesRoot),
      /outside the approved fixtures root/,
    );
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
