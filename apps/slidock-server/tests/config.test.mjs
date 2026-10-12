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

test('a declared but invalid runtime snapshot fails startup instead of enabling legacy mode', async () => {
  const staticRoot = await runtimeDirectory();
  await writeFile(
    join(staticRoot, 'runtime-manifest.json'),
    JSON.stringify({
      profileDigest: 'a'.repeat(64),
      theme: { name: 'minimal' },
      layouts: [],
      components: [],
      runtime: { schemaVersion: 1, id: 'invalid', files: [] },
    }),
  );
  await assert.rejects(createConfiguredHub(envFor(staticRoot)));
});

test('job admission is opt-in and explicit false supports a draining worker', async () => {
  const staticRoot = await runtimeDirectory();
  for (const flag of [undefined, 'true', 'false']) {
    const app = await createConfiguredHub(
      envFor(staticRoot, flag === undefined ? {} : { HUB_JOBS_ENABLED: flag }),
    );
    try {
      const response = await app.server.fetch(new Request('http://localhost/api/capabilities'));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).publicationJobs.enabled, flag === 'true');
      if (flag === undefined) assert.throws(() => app.startWorker(), /job store/);
      else {
        app.startWorker();
        assert.throws(() => app.startWorker(), /already running/);
      }
    } finally {
      await app.close();
    }
    assert.throws(() => app.startWorker(), /closing/);
  }
});

test('renderer configuration requires an explicit trusted origin and executable', async () => {
  const staticRoot = await runtimeDirectory();
  for (const [extra, message] of [
    [{ HUB_JOBS_ENABLED: 'yes' }, /HUB_JOBS_ENABLED/],
    [{ HUB_THUMBNAIL_RENDERER: 'unknown' }, /HUB_THUMBNAIL_RENDERER/],
    [{ HUB_THUMBNAIL_RENDERER: 'playwright' }, /HUB_PUBLIC_ORIGIN/],
    [{ HUB_PUBLIC_ORIGIN: 'https://example.test/path' }, /HTTP\(S\) origin/],
    [
      { HUB_THUMBNAIL_RENDERER: 'playwright', HUB_PUBLIC_ORIGIN: 'http://localhost:8080' },
      /HUB_CHROMIUM_EXECUTABLE/,
    ],
  ]) {
    await assert.rejects(createConfiguredHub(envFor(staticRoot, extra)), message);
  }
});

test('local mutation bypass is rejected before initialization on public listeners or production', async () => {
  for (const HOST of ['0.0.0.0', '::', '192.0.2.1', 'hub.example', 'localhost']) {
    await assert.rejects(
      createConfiguredHub({ HUB_ALLOW_LOCAL_MUTATIONS: 'true', HOST }),
      /requires a loopback listener outside production/u,
    );
  }
  await assert.rejects(
    createConfiguredHub({
      HUB_ALLOW_LOCAL_MUTATIONS: 'true',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
    }),
    /requires a loopback listener outside production/u,
  );
  const staticRoot = await runtimeDirectory();
  for (const HOST of ['127.0.0.1', '::1']) {
    const app = await createConfiguredHub(
      envFor(staticRoot, { HOST, HUB_ALLOW_LOCAL_MUTATIONS: 'true' }),
    );
    await app.close();
  }
});
