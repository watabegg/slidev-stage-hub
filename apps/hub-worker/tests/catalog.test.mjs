import assert from 'node:assert/strict';
import test from 'node:test';
import { readCatalogPage, readLegacyCatalogPage } from '@slidev-stage-hub/server/catalog';
import { readNativePlayerDocument } from '@slidev-stage-hub/server/native-player';
import { createMemoryBucket, createMemoryEnv, releaseManifest } from './support/memory-r2.mjs';

function indexDeck(bucket, manifest) {
  bucket.values.set(`index/${manifest.id}.json`, JSON.stringify({ id: manifest.id }));
}

test('catalog pagination returns public fields, current revisions, and a placeholder thumbnail', async () => {
  const bucket = createMemoryBucket({ pageSize: 1 });
  const env = createMemoryEnv({ bucket });
  const first = releaseManifest({
    id: 'group/alpha',
    frontmatter: {
      title: 'Alpha',
      description: 'Public description',
      author: { name: 'A', notes: 'private nested note' },
      notes: 'private note',
      hidden: 'not allowlisted',
    },
  });
  const second = releaseManifest({ id: 'group/beta', revision: 'b'.repeat(64) });
  env.current.set(first.id, first);
  env.current.set(second.id, second);
  indexDeck(bucket, first);
  indexDeck(bucket, second);

  const page1 = await readCatalogPage(env, new URL('https://hub.test/catalog.json?limit=1'));
  assert.equal(page1.schemaVersion, 1);
  assert.equal(page1.decks.length, 1);
  assert.equal(page1.decks[0].id, first.id);
  assert.equal(page1.decks[0].entry, `/${first.id}/1?revision=${first.revision}`);
  assert.deepEqual(page1.decks[0].categoryPath, ['group']);
  assert.deepEqual(page1.categories, [
    { id: 'group', name: 'group', path: ['group'], parentId: null },
  ]);
  assert.equal(page1.decks[0].thumbnail.src, '/thumbnail-placeholder.svg');
  assert.deepEqual(page1.decks[0].frontmatter, {
    title: 'Alpha',
    description: 'Public description',
    author: { name: 'A' },
  });
  assert.equal(page1.cursor, '1');

  const page2 = await readCatalogPage(
    env,
    new URL(`https://hub.test/catalog.json?limit=1&cursor=${page1.cursor}`),
  );
  assert.equal(page2.decks[0].id, second.id);
  assert.equal(page2.cursor, undefined);

  const legacy = await readLegacyCatalogPage(env, new URL('https://hub.test/api/catalog?limit=1'));
  assert.equal(legacy.decks.length, 1);
  assert.equal(legacy.truncated, true);
  assert.equal(legacy.cursor, '1');
});

test('native player walks R2 pages and keeps revision-query playback literal', async () => {
  const bucket = createMemoryBucket({ pageSize: 1 });
  const env = createMemoryEnv({ bucket });
  const supported = releaseManifest({
    id: 'group/native',
    revision: 'c'.repeat(64),
    native: { clickTotals: [2] },
  });
  const unsupported = releaseManifest({
    id: 'legacy/deck',
    revision: 'd'.repeat(64),
    native: undefined,
  });
  const explicitlyUnsupported = releaseManifest({
    id: 'other/dynamic',
    revision: 'e'.repeat(64),
    native: { unsupportedReason: 'PRIVATE source and notes must not be copied' },
  });
  for (const manifest of [supported, unsupported, explicitlyUnsupported]) {
    env.current.set(manifest.id, manifest);
    indexDeck(bucket, manifest);
  }

  const document = await readNativePlayerDocument(env);
  assert.deepEqual(document, {
    schemaVersion: 2,
    protocolVersion: 1,
    decks: [
      {
        id: supported.id,
        revision: supported.revision,
        entry: `/${supported.id}/1`,
        playback: { kind: 'revision-query', parameter: 'revision' },
        clickTotals: [2],
      },
    ],
    unsupportedDecks: [
      { id: unsupported.id, reason: 'This deck uses features the native player cannot render.' },
      {
        id: explicitlyUnsupported.id,
        reason: 'This deck uses features the native player cannot render.',
      },
    ],
  });
});

test('native discovery fails explicitly when more than 1000 index objects need visiting', async () => {
  const objects = Array.from({ length: 1000 }, (_, index) => ({ key: `index/deck-${index}.json` }));
  const bucket = {
    async list() {
      return { objects, truncated: true, cursor: 'next-page' };
    },
  };
  const env = createMemoryEnv({ bucket });
  await assert.rejects(
    readNativePlayerDocument(env),
    (error) => error.status === 503 && error.phase === 'discovery',
  );
});

test('native discovery fails rather than looping on a repeated R2 cursor', async () => {
  const cursors = ['first', 'second', 'first'];
  const bucket = {
    async list() {
      return { objects: [], truncated: true, cursor: cursors.shift() };
    },
  };
  const env = createMemoryEnv({ bucket });
  await assert.rejects(
    readNativePlayerDocument(env),
    (error) => error.status === 500 && error.phase === 'discovery',
  );
});

test('catalog rejects malformed pagination and fails when R2 withholds its continuation cursor', async () => {
  const env = createMemoryEnv();
  await assert.rejects(
    readCatalogPage(env, new URL('https://hub.test/catalog.json?limit=0')),
    (error) => error.status === 400 && error.phase === 'request',
  );
  env.FILES.list = async () => ({ objects: [], truncated: true });
  await assert.rejects(
    readCatalogPage(env, new URL('https://hub.test/catalog.json')),
    (error) => error.status === 500 && error.phase === 'catalog',
  );
});
