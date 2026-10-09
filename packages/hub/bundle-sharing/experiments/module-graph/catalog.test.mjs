import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  categoriesForDecks,
  discoverDecks,
  encodeDeckPath,
  publicFrontmatter,
} from './catalog.mjs';

async function fixtures(t, paths) {
  const root = await mkdtemp(join(tmpdir(), 'slidev-lab-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of paths) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '# Fixture\n');
  }
  return root;
}

test('discovers flat and folder decks in deterministic id order and excludes auxiliary trees', async (t) => {
  const root = await fixtures(t, [
    'z/slides.md',
    'aaa/aaa1/slides.md',
    'aaa/aaa2.md',
    'slides.md',
    'README.md',
    'AGENTS.md',
    'aaa/README.md',
    '.git/slides.md',
    'aaa/.drafts/slides.md',
    'aaa/assets/image.md',
    'public/slides.md',
    'node_modules/slides.md',
  ]);
  const decks = await discoverDecks(root);
  assert.deepEqual(
    decks.map(({ id, categoryPath }) => ({ id, categoryPath })),
    [
      { id: 'aaa/aaa1', categoryPath: ['aaa'] },
      { id: 'aaa/aaa2', categoryPath: ['aaa'] },
      { id: 'slides', categoryPath: [] },
      { id: 'z', categoryPath: [] },
    ],
  );
  assert(decks.every((deck) => deck.entry.startsWith(root)));
});

test('rejects a flat deck colliding with a slides.md folder deck', async (t) => {
  const root = await fixtures(t, ['aaa/aaa1.md', 'aaa/aaa1/slides.md']);
  await assert.rejects(discoverDecks(root), /Duplicate deck id "aaa\/aaa1"/);
});

test('rejects an empty discovery with a useful error', async (t) => {
  const root = await fixtures(t, ['README.md', 'assets/slides.md']);
  await assert.rejects(discoverDecks(root), /No Slidev decks found/);
});

test('supports dots, spaces and Japanese names with encoded public URLs', async (t) => {
  const root = await fixtures(t, ['講演/最初の 資料.v1.md']);
  const [deck] = await discoverDecks(root);
  assert.equal(deck.id, '講演/最初の 資料.v1');
  assert.deepEqual(deck.categoryPath, ['講演']);
  assert.equal(
    encodeDeckPath(deck.id),
    '%E8%AC%9B%E6%BC%94/%E6%9C%80%E5%88%9D%E3%81%AE%20%E8%B3%87%E6%96%99.v1',
  );
});

test('rejects names that would be ambiguous in module and public URLs', async (t) => {
  const root = await fixtures(t, ['talk#private.md']);
  await assert.rejects(discoverDecks(root), /Invalid deck id/);
});

test('categories include every ancestor exactly once and its parent', () => {
  assert.deepEqual(
    categoriesForDecks([
      { categoryPath: ['aaa', 'nested'] },
      { categoryPath: ['aaa'] },
      { categoryPath: ['bbb'] },
      { categoryPath: [] },
    ]),
    [
      { id: 'aaa', name: 'aaa', path: ['aaa'], parentId: null },
      { id: 'aaa/nested', name: 'nested', path: ['aaa', 'nested'], parentId: 'aaa' },
      { id: 'bbb', name: 'bbb', path: ['bbb'], parentId: null },
    ],
  );
});

test('public frontmatter omits private and non-plain fields without sharing references', () => {
  const tags = ['runtime', 'theme'];
  const authors = ['Alice', 'Bob'];
  const headmatter = {
    title: 'Talk',
    subtitle: 'Summary',
    author: authors,
    date: '2026-10-08',
    description: 'Public description',
    tags,
    note: 'PRIVATE_NOTE_hidden',
    themeConfig: { token: 'SECRET' },
    remote: 'SECRET',
    info: 'SECRET',
    unsupported: 1,
  };
  assert.deepEqual(publicFrontmatter(headmatter), {
    title: 'Talk',
    subtitle: 'Summary',
    author: ['Alice', 'Bob'],
    date: '2026-10-08',
    description: 'Public description',
    tags: ['runtime', 'theme'],
  });
  const publicData = publicFrontmatter(headmatter);
  tags.push('changed');
  authors.push('changed');
  assert.equal(publicData.tags.length, 2);
  assert.equal(publicData.author.length, 2);
  assert(!JSON.stringify(publicData).includes('SECRET'));
  assert(!JSON.stringify(publicData).includes('PRIVATE_NOTE_'));
  assert.deepEqual(
    publicFrontmatter({
      title: undefined,
      subtitle: () => 1,
      author: new Date(),
      date: Infinity,
      description: 1n,
      tags: ['valid', undefined],
    }),
    { tags: ['valid'] },
  );
});
