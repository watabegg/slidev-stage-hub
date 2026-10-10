import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import test from 'node:test';
import {
  createPostgresPublicationStore,
  initializePostgresPublicationStore,
} from '../dist/index.js';

const connectionString = process.env.HUB_TEST_DATABASE_URL;
const databaseTest = connectionString ? test : test.skip;

databaseTest(
  'PostgreSQL begin is latest-wins under pooled concurrency and current survives begin',
  async () => {
    const pool = new Pool({ connectionString, max: 12 });
    const otherPool = new Pool({ connectionString, max: 2 });
    const suffix = randomUUID();
    const deck = `portable-test-${suffix}`;
    const otherDeck = `${deck}-other`;
    try {
      await initializePostgresPublicationStore(pool);
      const store = createPostgresPublicationStore({ pool });
      const storeFromReconnectedPool = createPostgresPublicationStore({ pool: otherPool });
      const first = await store.begin(deck);
      const original = { revision: 'previous', fields: ['whole', 'manifest'] };
      assert.equal(await store.commit(deck, first, original), true);
      assert.deepEqual(await store.current(deck), original);

      const tokens = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          (index % 2 ? store : storeFromReconnectedPool).begin(deck),
        ),
      );
      const latest = tokens.reduce((left, right) => (BigInt(left) > BigInt(right) ? left : right));
      assert.equal(new Set(tokens).size, tokens.length);
      assert.deepEqual(
        await store.current(deck),
        original,
        'begin leaves the previously published manifest intact',
      );
      assert.equal(await store.commit(deck, tokens[0], { revision: 'stale' }), false);
      assert.equal(
        await store.commit(deck, latest, { revision: 'latest', nested: { retained: true } }),
        true,
      );
      assert.equal(
        await store.commit(deck, latest, { revision: 'latest-repeat' }),
        true,
        'same latest token may retry',
      );
      assert.equal(await store.commit(deck, 'not-a-token', {}), false);
      assert.equal(await store.commit(deck, '-1', {}), false);
      assert.equal(await store.commit(deck, '9223372036854775808', {}), false);
      assert.deepEqual(await storeFromReconnectedPool.current(deck), { revision: 'latest-repeat' });

      const otherToken = await store.begin(otherDeck);
      assert.notEqual(await store.commit(otherDeck, otherToken, { deck: 'other' }), false);
      assert.deepEqual(await store.current(deck), { revision: 'latest-repeat' });
      assert.deepEqual(await store.current(otherDeck), { deck: 'other' });
      assert.equal(await store.current(`${deck}-missing`), null);
    } finally {
      await pool.query('DELETE FROM hub_publications WHERE deck_id = ANY($1::text[])', [
        [deck, otherDeck],
      ]);
      await Promise.all([pool.end(), otherPool.end()]);
    }
  },
  {
    skip: connectionString
      ? false
      : 'Set HUB_TEST_DATABASE_URL to run PostgreSQL concurrency and persistence checks',
    timeout: 30_000,
  },
);
