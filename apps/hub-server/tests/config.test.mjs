import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createConfiguredHub } from '../dist/config.js';

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'hub-server-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function runtimeDirectory() {
  const workspace = await temporaryDirectory();
  const root = join(workspace, 'site');
  await mkdir(root);
  await writeFile(
    join(root, 'runtime-manifest.json'),
    JSON.stringify({
      profileDigest: 'a'.repeat(64),
      theme: { name: 'minimal' },
      layouts: [],
      components: [],
    }),
  );
  await writeFile(join(root, 'index.html'), '<main>built runtime</main>');
  return root;
}

function envFor(staticRoot, extra = {}) {
  return {
    NODE_ENV: 'test',
    HUB_STATIC_DIR: staticRoot,
    HUB_ARTIFACT_DIR: join(staticRoot, '..', 'objects'),
    ...extra,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('valid runtime manifest creates a configured server that serves its built runtime', async () => {
  const staticRoot = await runtimeDirectory();
  const app = await createConfiguredHub(envFor(staticRoot));
  try {
    const response = await app.server.fetch(new Request('http://localhost/'));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(await response.text(), '<main>built runtime</main>');
    assert.equal(app.staticRoot, staticRoot);
  } finally {
    await app.close();
  }
});

test('production rejects filesystem artifacts and memory publication state', async () => {
  const staticRoot = await runtimeDirectory();
  await assert.rejects(
    createConfiguredHub(
      envFor(staticRoot, {
        NODE_ENV: 'production',
        HUB_STORAGE: 'filesystem',
        HUB_PUBLICATIONS: 'postgres',
      }),
    ),
    /production requires durable external storage/i,
  );
  await assert.rejects(
    createConfiguredHub(
      envFor(staticRoot, {
        NODE_ENV: 'production',
        HUB_STORAGE: 's3',
        HUB_PUBLICATIONS: 'memory',
      }),
    ),
    /production requires durable external storage/i,
  );
});

test('invalid provider names and missing object-store buckets fail during configuration', async () => {
  const staticRoot = await runtimeDirectory();
  await assert.rejects(
    createConfiguredHub(envFor(staticRoot, { HUB_STORAGE: 'local-cache' })),
    /HUB_STORAGE must be filesystem, s3 or gcs/,
  );
  await assert.rejects(
    createConfiguredHub(envFor(staticRoot, { HUB_PUBLICATIONS: 'sqlite' })),
    /HUB_PUBLICATIONS must be memory or postgres/,
  );
  for (const provider of ['s3', 'gcs']) {
    await assert.rejects(
      createConfiguredHub(envFor(staticRoot, { HUB_STORAGE: provider })),
      /HUB_BUCKET is required/,
    );
  }
});

test('PostgreSQL configuration reports a missing database URL without connecting', async () => {
  const staticRoot = await runtimeDirectory();
  await assert.rejects(
    createConfiguredHub(envFor(staticRoot, { HUB_PUBLICATIONS: 'postgres' })),
    /HUB_DATABASE_URL is required/,
  );
});

test('PostgreSQL initialization failure is propagated and closes its pool', async () => {
  const staticRoot = await runtimeDirectory();
  await assert.rejects(
    createConfiguredHub(
      envFor(staticRoot, {
        HUB_PUBLICATIONS: 'postgres',
        HUB_DATABASE_URL: 'postgres://hub-test:hub-test@127.0.0.1:1/hub-test',
        HUB_DATABASE_INIT: 'true',
      }),
    ),
    /ECONNREFUSED/,
  );
});

test('local mutation switch and publish token are wired into the real request handler', async () => {
  const staticRoot = await runtimeDirectory();
  const request = (headers = {}) =>
    new Request('http://localhost/api/decks/sample-deck', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{',
    });

  const disabled = await createConfiguredHub(envFor(staticRoot));
  try {
    assert.equal((await disabled.server.fetch(request())).status, 403);
  } finally {
    await disabled.close();
  }

  const local = await createConfiguredHub(
    envFor(staticRoot, { HUB_ALLOW_LOCAL_MUTATIONS: 'true' }),
  );
  try {
    const response = await local.server.fetch(request());
    assert.equal(response.status, 400);
    assert.equal((await response.json()).phase, 'request');
  } finally {
    await local.close();
  }

  const tokenApp = await createConfiguredHub(
    envFor(staticRoot, {
      HUB_ALLOW_LOCAL_MUTATIONS: 'true',
      HUB_PUBLISH_TOKEN: 'test-publish-token',
    }),
  );
  try {
    assert.equal((await tokenApp.server.fetch(request())).status, 401);
    assert.equal(
      (await tokenApp.server.fetch(request({ authorization: 'Bearer wrong-token' }))).status,
      401,
    );
    const authorized = await tokenApp.server.fetch(
      request({ authorization: 'Bearer test-publish-token' }),
    );
    assert.equal(authorized.status, 400);
    assert.equal((await authorized.json()).phase, 'request');
  } finally {
    await tokenApp.close();
  }
});

test('default memory and filesystem configuration needs no PostgreSQL URL', async () => {
  const staticRoot = await runtimeDirectory();
  const app = await createConfiguredHub(envFor(staticRoot));
  try {
    const response = await app.server.fetch(new Request('http://localhost/native-player.json'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      schemaVersion: 2,
      protocolVersion: 1,
      decks: [],
      unsupportedDecks: [],
    });
  } finally {
    await app.close();
  }
});
