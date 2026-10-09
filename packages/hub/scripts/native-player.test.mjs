import { slidevRequire } from '../../../scripts/runtime-environment.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePlayerManifest } from './native-player.mjs';

const cliRequire = slidevRequire();
const parserPath = cliRequire.resolve('@slidev/parser');

test('public discovery has page/click bounds without sources or private notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slidev-player-'));
  try {
    const { parseSync } = await import(parserPath);
    await writeFile(
      join(root, 'deck.md'),
      '# Title\n\n<!-- PRIVATE_NOTE_NEVER_PUBLISH -->\n\n---\n\n# Next\n\n<div v-click>one</div>\n<div v-click>two</div>\n',
    );
    const result = await nativePlayerManifest(
      [{ id: 'a/deck', sourcePath: 'deck.md', revision: 'rev', entry: '/a/deck/1', pages: 2 }],
      root,
      parseSync,
    );
    assert.deepEqual(result, {
      schemaVersion: 1,
      protocolVersion: 1,
      decks: [{ id: 'a/deck', revision: 'rev', entry: '/a/deck/1', clickTotals: [0, 2] }],
      unsupportedDecks: [],
    });
    assert.ok(!JSON.stringify(result).includes(root));
    assert.ok(!JSON.stringify(result).includes('PRIVATE_NOTE'));
    await writeFile(join(root, 'deck.md'), '# Title\n<div v-click="3">advanced</div>\n');
    const unsupported = await nativePlayerManifest(
      [{ id: 'a/deck', sourcePath: 'deck.md', pages: 1 }],
      root,
      parseSync,
    );
    assert.equal(unsupported.decks.length, 0);
    assert.equal(unsupported.unsupportedDecks.length, 1);
    const missing = await nativePlayerManifest(
      [{ id: 'a/missing', sourcePath: 'private-source-name.md', pages: 1 }],
      root,
      parseSync,
    );
    assert.ok(!JSON.stringify(missing).includes('private-source-name'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
