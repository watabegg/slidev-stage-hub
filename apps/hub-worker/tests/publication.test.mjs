import assert from 'node:assert/strict';
import test from 'node:test';
import { publishDeck } from '../src/publish.ts';
import { createMemoryBucket, createMemoryEnv } from './support/memory-r2.mjs';

const markdown = '# Publication test';

function compileResult(input) {
  return {
    title: input.markdown.slice(2),
    frontmatter: {},
    slides: [{ no: 1, frontmatter: {}, code: 'export default {}', css: '' }],
    warnings: [],
    native: { clickTotals: [0] },
  };
}

test('an index marker failure cannot advance the current Durable Object revision', async () => {
  const bucket = createMemoryBucket({ failPut: (key) => key.startsWith('index/') });
  const current = new Map([['deck', { revision: 'a'.repeat(64), title: 'previous' }]]);
  const env = createMemoryEnv({ bucket, current });

  await assert.rejects(
    publishDeck(env, 'deck', { markdown }, async (input) => compileResult(input)),
    (error) => error.status === 500 && error.phase === 'storage',
  );
  assert.equal(current.get('deck').title, 'previous');
  assert.equal(env.VERSIONS.calls.filter((call) => call.kind === 'commit').length, 0);
  assert.ok([...bucket.values.keys()].some((key) => key.endsWith('/manifest.json')));
});

test('an artifact write failure leaves no release manifest, index marker, or current revision', async () => {
  const bucket = createMemoryBucket({ failPut: (key) => key.endsWith('/1.js') });
  const env = createMemoryEnv({ bucket });

  await assert.rejects(
    publishDeck(env, 'deck', { markdown }, async (input) => compileResult(input)),
    (error) => error.status === 500 && error.phase === 'storage',
  );
  assert.equal(
    [...bucket.values.keys()].some((key) => key.endsWith('/manifest.json')),
    false,
  );
  assert.equal(
    [...bucket.values.keys()].some((key) => key.startsWith('index/')),
    false,
  );
  assert.equal(env.VERSIONS.calls.filter((call) => call.kind === 'commit').length, 0);
  assert.equal(env.current.has('deck'), false);
});

test('a slow earlier publication cannot replace the latest generation', async () => {
  const bucket = createMemoryBucket();
  const env = createMemoryEnv({ bucket });
  let markOlderStarted;
  let releaseOlder;
  const olderStarted = new Promise((resolve) => {
    markOlderStarted = resolve;
  });
  const olderGate = new Promise((resolve) => {
    releaseOlder = resolve;
  });
  const compile = async (input) => {
    if (input.markdown === '# Older') {
      markOlderStarted();
      await olderGate;
    }
    return compileResult(input);
  };

  const olderPublication = publishDeck(env, 'deck', { markdown: '# Older' }, compile);
  await olderStarted;
  const latest = await publishDeck(env, 'deck', { markdown: '# Latest' }, compile);
  releaseOlder();
  const older = await olderPublication;

  assert.equal(latest.published, true);
  assert.equal(older.published, false);
  assert.equal(env.current.get('deck').title, 'Latest');
  assert.deepEqual(
    env.VERSIONS.calls.filter((call) => call.kind === 'commit').map((call) => call.generation),
    [2, 1],
  );
});
