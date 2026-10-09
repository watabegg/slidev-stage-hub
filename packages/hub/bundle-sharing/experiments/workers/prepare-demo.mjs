import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { experiment } from './harness.mjs';
const hubRoot = resolve(experiment, '../../..');
const sharedFixtures = resolve(hubRoot, '../../examples/fixtures');
const origin = process.argv[2] || 'http://127.0.0.1:4180';
const decks = [
  {
    id: 'poc/demo',
    markdown: await readFile(resolve(experiment, 'fixtures/deck.md'), 'utf8'),
    assets: JSON.parse(await readFile(resolve(experiment, 'fixtures/assets.json'), 'utf8')),
  },
];
for (const id of ['aaa/aaa1', 'aaa/aaa2', 'bbb/bbb1', 'bbb/bbb2']) {
  const dir = resolve(sharedFixtures, id);
  decks.push({
    id: 'fixture/' + id,
    markdown: (await readFile(resolve(dir, 'slides.md'), 'utf8')).split(
      '\n---\nlayout: section',
    )[0],
    assets: { 'assets/conflict.svg': await readFile(resolve(dir, 'assets/conflict.svg'), 'utf8') },
  });
}
for (const deck of decks) {
  const response = await fetch(origin + '/api/decks/' + encodeURIComponent(deck.id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deck),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  const { stdout } = await promisify(execFile)(process.execPath, [
    resolve(experiment, 'local-thumbnail.mjs'),
    origin,
    deck.id,
  ]);
  console.log(
    JSON.stringify({
      id: deck.id,
      pages: result.slides.length,
      entry: origin + result.entry,
      thumbnail: JSON.parse(stdout),
    }),
  );
}
