import assert from 'node:assert/strict';
import { chmod, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  connect,
  normalizeOrigin,
  parseConnectArgs,
  validatePlayerDocument,
} from './connect.mjs';

const validDeck = {
  id: 'course/topic-1',
  revision: 'build-17',
  entry: '/course/topic-1/1',
  clickTotals: [0, 2, 4],
};

function playerDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    decks: [{ ...validDeck }],
    unsupportedDecks: [],
    ...overrides,
  };
}

async function withHttpFixture(body, run, { status = 200, headers = {}, onRequest } = {}) {
  const server = createServer((request, response) => {
    onRequest?.(request);
    if (request.url !== '/native-player.json') {
      response.writeHead(404).end('missing');
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await run(origin);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slidev-native-connect-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('normalizes public HTTPS and permits HTTP only for the exact loopback hosts', () => {
  assert.equal(normalizeOrigin('https://Slides.Example.com:443/'), 'https://slides.example.com');
  assert.equal(normalizeOrigin('http://127.0.0.1:4173/'), 'http://127.0.0.1:4173');
  assert.equal(normalizeOrigin('http://localhost:4173'), 'http://localhost:4173');
  assert.equal(normalizeOrigin('http://[::1]:4173'), 'http://[::1]:4173');
  for (const input of [
    'http://slides.example.com',
    'http://127.1:4173',
    'https://user@example.com',
    'https://@example.com',
    'https://example.com/deck',
    'https://example.com?draft=1',
    'https://example.com#slide',
    'file:///tmp/site',
    'https://example.com/./',
  ]) assert.throws(() => normalizeOrigin(input), Error, input);
});

test('connect fetches the public manifest from HTTP loopback and writes only public deck metadata', async () => {
  const document = playerDocument({
    decks: [{ ...validDeck, ignoredField: 'discarded' }],
    unsupportedDecks: [{ id: '資料/旧版', reason: 'unsupported runtime' }],
  });
  await withHttpFixture(document, async origin => withTempDir(async directory => {
    const configPath = path.join(directory, 'local-config.json');
    const artifactsRoot = path.join(directory, 'artifacts');
    const result = await connect(`${origin}/`, { configPath, artifactsRoot });
    assert.deepEqual(result.config, {
      decks: [validDeck],
      notes: {},
      approvedSourceRoot: artifactsRoot,
      viewerOrigin: origin,
    });
    assert.deepEqual(result.unsupportedDecks, [{ id: '資料/旧版', reason: 'unsupported runtime' }]);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), result.config);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  }));
});

test('connect sends origin-bound auth headers only to the manifest request and stores only the file path', async () => {
  const authorization = 'Bearer TEST_CANARY_AUTH_VALUE';
  const accessId = 'TEST_CANARY_ACCESS_ID';
  const accessSecret = 'TEST_CANARY_ACCESS_SECRET';
  let seenHeaders;
  await withHttpFixture(playerDocument(), async origin => withTempDir(async directory => {
    const headersFile = path.join(directory, 'auth.json');
    await writeFile(headersFile, JSON.stringify({
      origin,
      headers: {
        Authorization: authorization,
        'CF-Access-Client-Id': accessId,
        'CF-Access-Client-Secret': accessSecret,
      },
    }), { mode: 0o600 });
    await chmod(headersFile, 0o600);
    const configPath = path.join(directory, 'local-config.json');
    const artifactsRoot = path.join(directory, 'artifacts');
    const result = await connect(origin, { headersFile, configPath, artifactsRoot });

    assert.deepEqual(result.config, {
      decks: [validDeck],
      notes: {},
      approvedSourceRoot: artifactsRoot,
      viewerOrigin: origin,
      authHeadersFile: headersFile,
    });
    const serialized = await readFile(configPath, 'utf8');
    assert.deepEqual(JSON.parse(serialized), result.config);
    for (const secret of [authorization, accessId, accessSecret])
      assert.equal(serialized.includes(secret), false);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  }), {
    onRequest(request) {
      seenHeaders = request.headers;
    },
  });

  assert.equal(seenHeaders.accept, 'application/json');
  assert.equal(seenHeaders.authorization, authorization);
  assert.equal(seenHeaders['cf-access-client-id'], accessId);
  assert.equal(seenHeaders['cf-access-client-secret'], accessSecret);
});

test('rejects malformed CLI argument layouts before connecting', () => {
  assert.deepEqual(parseConnectArgs(['https://slides.example.com']), {
    origin: 'https://slides.example.com',
    headersFile: undefined,
  });
  assert.deepEqual(parseConnectArgs(['https://slides.example.com', '--headers-file', './auth.json']), {
    origin: 'https://slides.example.com',
    headersFile: './auth.json',
  });
  for (const args of [
    [],
    ['https://slides.example.com', '--headers-file'],
    ['https://slides.example.com', '--unknown', './auth.json'],
    ['https://slides.example.com', '--headers-file', '', 'extra'],
  ]) assert.throws(() => parseConnectArgs(args), /usage: node apps\/stage\/scripts\/connect\.mjs/);

  const script = fileURLToPath(new URL('./connect.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'https://slides.example.com', '--headers-file'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: node apps\/stage\/scripts\/connect\.mjs/);
});

test('rejects schema, protocol, malformed deck, and empty supported-deck lists', async () => {
  assert.throws(() => validatePlayerDocument(playerDocument({ schemaVersion: 2 })), /schemaVersion must be 1/);
  assert.throws(() => validatePlayerDocument(playerDocument({ protocolVersion: 2 })), /protocolVersion must be 1/);
  assert.throws(() => validatePlayerDocument(playerDocument({ decks: [{ ...validDeck, id: '../topic' }] })), /id must use/);
  assert.throws(() => validatePlayerDocument(playerDocument({ decks: [{ ...validDeck, entry: '/wrong/1' }] })), /entry must be exactly/);
  assert.throws(() => validatePlayerDocument(playerDocument({ decks: [{ ...validDeck, clickTotals: [0, -1] }] })), /u32 integer/);
  assert.throws(() => validatePlayerDocument(playerDocument({ decks: [{ ...validDeck, clickTotals: [] }] })), /non-empty array/);
  assert.throws(() => validatePlayerDocument(playerDocument({ decks: [] })), /no supported decks/);
});

test('failed fetch and validation leave an existing native config untouched', async () => {
  await withTempDir(async directory => {
    const configPath = path.join(directory, 'local-config.json');
    const original = '{"keep":"previous config"}\n';
    await writeFile(configPath, original);

    await withHttpFixture(playerDocument({ schemaVersion: 9 }), async origin => {
      await assert.rejects(connect(origin, { configPath }), /schemaVersion must be 1/);
    });
    assert.equal(await readFile(configPath, 'utf8'), original);
  });
});

test('missing or mismatched auth fails before replacing the existing config', async () => {
  await withTempDir(async directory => {
    const configPath = path.join(directory, 'local-config.json');
    const original = '{"keep":"previous config"}\n';
    await writeFile(configPath, original);

    let requests = 0;
    await withHttpFixture(playerDocument(), async origin => {
      await assert.rejects(connect(origin, { configPath }), /returned HTTP 401/);
      assert.equal(await readFile(configPath, 'utf8'), original);

      const headersFile = path.join(directory, 'wrong-origin.json');
      await writeFile(headersFile, JSON.stringify({
        origin: 'https://other.example.com',
        headers: { Authorization: 'Bearer TEST_CANARY_WRONG_ORIGIN' },
      }), { mode: 0o600 });
      await chmod(headersFile, 0o600);
      await assert.rejects(connect(origin, { configPath, headersFile }), /origin/);
      assert.equal(await readFile(configPath, 'utf8'), original);
      assert.equal(requests, 1);
    }, {
      status: 401,
      onRequest() {
        requests += 1;
      },
    });
  });
});

test('auth transport errors do not echo header values and preserve existing config', async () => {
  await withTempDir(async directory => {
    const canary = 'TEST_CANARY_FETCH_ERROR_VALUE';
    const headersFile = path.join(directory, 'auth.json');
    const configPath = path.join(directory, 'local-config.json');
    const original = '{"keep":"previous config"}\n';
    await writeFile(headersFile, JSON.stringify({
      origin: 'https://slides.example.com',
      headers: { Authorization: `Bearer ${canary}` },
    }), { mode: 0o600 });
    await chmod(headersFile, 0o600);
    await writeFile(configPath, original);

    await assert.rejects(
      connect('https://slides.example.com', {
        configPath,
        headersFile,
        fetchImpl: async () => {
          throw new Error(`request rejected ${canary}`);
        },
      }),
      error => {
        assert.match(error.message, /request failed with configured authentication headers/);
        assert.equal(error.message.includes(canary), false);
        return true;
      },
    );
    assert.equal(await readFile(configPath, 'utf8'), original);
  });
});

test('malformed manifest errors do not echo the HTTP body or JSON parser excerpts', async () => {
  await withTempDir(async directory => {
    const canary = 'TEST_CANARY_HTTP_BODY_VALUE';
    const configPath = path.join(directory, 'local-config.json');
    const original = '{"keep":"previous config"}\n';
    await writeFile(configPath, original);

    await withHttpFixture(`THIS IS NOT JSON ${canary}`, async origin => {
      await assert.rejects(
        connect(origin, { configPath }),
        error => {
          assert.match(error.message, /did not return valid JSON/);
          assert.equal(error.message.includes(canary), false);
          assert.equal(error.message.includes('Unexpected token'), false);
          return true;
        },
      );
      assert.equal(await readFile(configPath, 'utf8'), original);
    });
  });
});

test('authenticated response stream errors do not expose transport causes', async () => {
  await withTempDir(async directory => {
    const canary = 'TEST_CANARY_RESPONSE_STREAM_CAUSE';
    const headersFile = path.join(directory, 'auth.json');
    const configPath = path.join(directory, 'local-config.json');
    const original = '{"keep":"previous config"}\n';
    await writeFile(headersFile, JSON.stringify({
      origin: 'https://slides.example.com',
      headers: { Authorization: `Bearer ${canary}` },
    }), { mode: 0o600 });
    await chmod(headersFile, 0o600);
    await writeFile(configPath, original);

    await assert.rejects(
      connect('https://slides.example.com', {
        configPath,
        headersFile,
        fetchImpl: async () => new Response(new ReadableStream({
          start(controller) {
            controller.error(new Error(`stream failed ${canary}`));
          },
        }), { status: 200 }),
      }),
      error => {
        assert.match(error.message, /response body could not be read/);
        assert.equal(error.message.includes(canary), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(await readFile(configPath, 'utf8'), original);
  });
});

test('rejects redirected and oversized manifest responses', async () => {
  await withTempDir(async directory => {
    const configPath = path.join(directory, 'local-config.json');
    await withHttpFixture(playerDocument(), async origin => {
      await assert.rejects(connect(origin, { configPath }), /returned HTTP 404/);
    }, { status: 404 });

    await withHttpFixture(playerDocument(), async origin => {
      await assert.rejects(connect(origin, { configPath }), /redirected/);
    }, { status: 302, headers: { location: '/native-player.json' } });

    await withHttpFixture('x'.repeat(1024 * 1024 + 1), async origin => {
      await assert.rejects(connect(origin, { configPath }), /1 MiB/);
    });
    assert.equal(await readFile(configPath).then(() => true, () => false), false);
  });
});
