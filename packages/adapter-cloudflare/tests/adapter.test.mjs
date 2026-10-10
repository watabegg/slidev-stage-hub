import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCloudflareOptions,
  createDurableObjectPublicationStore,
  createR2ArtifactStore,
} from '../dist/index.js';

function namespace() {
  const states = new Map();
  const calls = [];
  return {
    calls,
    getByName(id) {
      if (!states.has(id)) states.set(id, { generation: 0, current: null });
      const state = states.get(id);
      return {
        async begin() {
          return ++state.generation;
        },
        async current() {
          return state.current;
        },
        async commit(generation, manifest) {
          calls.push({ id, generation, manifest });
          if (state.generation !== generation) return false;
          state.current = manifest;
          return true;
        },
      };
    },
  };
}

test('DO adapter preserves latest begin wins, existing current, and repeated token commits', async () => {
  const store = createDurableObjectPublicationStore(namespace());
  const first = await store.begin('deck');
  assert.equal(first, '1');
  assert.equal(await store.commit('deck', first, { revision: 'initial' }), true);
  const latest = await store.begin('deck');
  assert.deepEqual(await store.current('deck'), { revision: 'initial' });
  assert.equal(await store.commit('deck', first, { revision: 'stale' }), false);
  assert.equal(await store.commit('deck', latest, { revision: 'latest' }), true);
  assert.equal(await store.commit('deck', latest, { revision: 'latest' }), true);
  assert.equal(await store.current('other'), null);
});

test('DO adapter rejects malformed or unsafe tokens without calling RPC', async () => {
  const versions = namespace();
  const store = createDurableObjectPublicationStore(versions);
  await store.begin('deck');
  for (const token of [
    '',
    '0',
    '-1',
    '+1',
    '01',
    '1.0',
    '1e0',
    ' 1',
    '1\n',
    'NaN',
    '9007199254740992',
  ]) {
    assert.equal(await store.commit('deck', token, {}), false, token);
  }
  assert.equal(versions.calls.length, 0);
  await assert.rejects(
    createDurableObjectPublicationStore({
      getByName: () => ({ begin: async () => Number.MAX_SAFE_INTEGER + 1 }),
    }).begin('deck'),
    /invalid publication generation/u,
  );
});

test('R2 adapter maps streaming metadata, atomic ifAbsent and opaque continuation cursors', async () => {
  const calls = [];
  const bytes = new Uint8Array([1, 2, 3]);
  const object = {
    httpMetadata: { contentType: 'image/png' },
    httpEtag: '"provider:etag"',
    size: 3,
  };
  const bucket = {
    async get() {
      return { ...object, body: new Response(bytes).body };
    },
    async head() {
      return object;
    },
    async put(...args) {
      calls.push(args);
      return args[2].onlyIf ? null : object;
    },
    async list(options) {
      calls.push(options);
      return { objects: [{ key: `${options.prefix}entry` }], truncated: true, cursor: 'opaque+/=' };
    },
  };
  const store = createR2ArtifactStore(bucket);
  assert.deepEqual(await store.head('key'), {
    contentType: 'image/png',
    etag: '"provider:etag"',
    size: 3,
  });
  assert.deepEqual(
    new Uint8Array(await new Response((await store.get('key')).body).arrayBuffer()),
    bytes,
  );
  assert.equal(await store.put('key', bytes, { ifAbsent: true, contentType: 'image/png' }), false);
  assert.deepEqual(calls[0][2], {
    httpMetadata: { contentType: 'image/png' },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  assert.deepEqual(await store.list({ prefix: 'index/', limit: 1, cursor: 'previous' }), {
    keys: ['index/entry'],
    cursor: 'opaque+/=',
  });
  await assert.rejects(store.list({ prefix: 'index/', limit: 0 }), /limit/u);
});

test('R2 adapter preserves absence and rejects storage failures and missing list cursor', async () => {
  const store = createR2ArtifactStore({
    get: async () => null,
    head: async () => null,
    put: async () => null,
    list: async () => ({ objects: [], truncated: true }),
  });
  assert.equal(await store.get('missing'), null);
  assert.equal(await store.head('missing'), null);
  await assert.rejects(store.put('key', 'body'), /did not store/u);
  await assert.rejects(store.list({ prefix: 'index/', limit: 100 }), /continuation/u);
});

test('Cloudflare factory binds current generated profile and local mutation configuration', async () => {
  const env = {
    FILES: {},
    VERSIONS: namespace(),
    STATIC: { fetch: async () => new Response('static') },
    PROFILE_DIGEST: 'digest',
    LOCAL_MUTATIONS: 'true',
    PROFILE_THEME: 'theme',
    PROFILE_LAYOUTS: '["cover"]',
    PROFILE_COMPONENTS: '["Figure"]',
    PUBLISH_TOKEN: 'secret',
  };
  const options = createCloudflareOptions(env);
  assert.deepEqual(options.profile, {
    digest: 'digest',
    theme: 'theme',
    layouts: '["cover"]',
    components: '["Figure"]',
  });
  assert.equal(options.allowLocalMutations, true);
  assert.equal(options.publishToken, 'secret');
  assert.equal(options.renderThumbnail, undefined);
  assert.equal(
    await (await options.staticAssets.fetch(new Request('https://hub.test'))).text(),
    'static',
  );
});
