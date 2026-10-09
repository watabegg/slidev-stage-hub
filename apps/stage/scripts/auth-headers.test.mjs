import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readAuthHeadersFile } from './auth-headers.mjs';
import { normalizeOrigin } from './connect.mjs';

const origin = 'https://slides.example.com';
const canary = 'TEST_CANARY_MUST_NOT_APPEAR_IN_ERRORS';

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slidev-native-auth-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createAuthFile(directory, document, { filename = 'auth.json', mode = 0o600 } = {}) {
  const filePath = path.join(directory, filename);
  const source = typeof document === 'string' ? document : JSON.stringify(document);
  await writeFile(filePath, source, { mode });
  await chmod(filePath, mode);
  return filePath;
}

function validDocument(headers = { Authorization: `Bearer ${canary}` }, fileOrigin = origin) {
  return { origin: fileOrigin, headers };
}

test('reads a private regular auth file and normalizes its origin before comparing', async () => {
  await withTempDir(async (directory) => {
    const filePath = await createAuthFile(
      directory,
      validDocument(
        {
          Authorization: `Bearer ${canary}`,
          'CF-Access-Client-Id': 'test-id',
          'CF-Access-Client-Secret': 'test-secret',
        },
        'HTTPS://SLIDES.EXAMPLE.COM:443/',
      ),
    );

    const result = await readAuthHeadersFile(filePath, origin, normalizeOrigin);
    assert.equal(result.absolutePath, filePath);
    assert.deepEqual(
      { ...result.headers },
      {
        Authorization: `Bearer ${canary}`,
        'CF-Access-Client-Id': 'test-id',
        'CF-Access-Client-Secret': 'test-secret',
      },
    );
  });
});

test('rejects group or other readable auth files without exposing a header value', async (t) => {
  if (process.platform === 'win32')
    return t.skip('Unix permission bits are not available on Windows');
  await withTempDir(async (directory) => {
    const filePath = await createAuthFile(directory, validDocument(), { mode: 0o640 });
    await assert.rejects(readAuthHeadersFile(filePath, origin, normalizeOrigin), (error) => {
      assert.match(error.message, /must not grant group or other permissions/);
      assert.equal(error.message.includes(canary), false);
      return true;
    });
  });
});

test('rejects mismatched or non-root origins without exposing header values', async () => {
  await withTempDir(async (directory) => {
    for (const fileOrigin of ['https://other.example.com', 'https://slides.example.com/deck']) {
      const filePath = await createAuthFile(directory, validDocument(undefined, fileOrigin), {
        filename: `${path.basename(fileOrigin.replaceAll('/', '_'))}.json`,
      });
      await assert.rejects(readAuthHeadersFile(filePath, origin, normalizeOrigin), (error) => {
        assert.match(error.message, /origin/);
        assert.equal(error.message.includes(canary), false);
        return true;
      });
    }
  });
});

test('rejects invalid headers, duplicate names, and duplicate JSON keys without echoing values', async () => {
  await withTempDir(async (directory) => {
    const cases = [
      {
        name: 'case-insensitive duplicate names',
        document: validDocument({ Authorization: canary, authorization: 'second-secret' }),
        pattern: /unique case-insensitively/,
      },
      {
        name: 'newline values',
        document: validDocument({ Authorization: `${canary}\nInjected: true` }),
        pattern: /printable ASCII/,
      },
      {
        name: 'non-ASCII values',
        document: validDocument({ Authorization: `${canary}秘密` }),
        pattern: /printable ASCII/,
      },
      {
        name: 'forbidden transport headers',
        document: validDocument({ Host: canary }),
        pattern: /forbidden header name/,
      },
      {
        name: 'forbidden proxy headers',
        document: validDocument({ 'Proxy-Authorization': canary }),
        pattern: /forbidden header name/,
      },
      {
        name: 'forbidden browser headers',
        document: validDocument({ 'Sec-Fetch-Site': canary }),
        pattern: /forbidden header name/,
      },
      {
        name: 'empty header maps',
        document: validDocument({}),
        pattern: /must not be empty/,
      },
      {
        name: 'extra schema fields',
        document: { ...validDocument(), token: canary },
        pattern: /only origin and headers/,
      },
    ];

    for (const [index, item] of cases.entries()) {
      const filePath = await createAuthFile(directory, item.document, {
        filename: `invalid-${index}.json`,
      });
      await assert.rejects(readAuthHeadersFile(filePath, origin, normalizeOrigin), (error) => {
        assert.match(error.message, item.pattern, item.name);
        assert.equal(error.message.includes(canary), false, item.name);
        return true;
      });
    }

    const duplicateKeyPath = await createAuthFile(
      directory,
      `{"origin":"${origin}","headers":{"Authorization":"${canary}","Authorization":"second-secret"}}`,
      { filename: 'duplicate-json-key.json' },
    );
    await assert.rejects(
      readAuthHeadersFile(duplicateKeyPath, origin, normalizeOrigin),
      (error) => {
        assert.match(error.message, /duplicate JSON keys/);
        assert.equal(error.message.includes(canary), false);
        return true;
      },
    );
  });
});

test('enforces the 64 KiB and 64-header limits', async () => {
  await withTempDir(async (directory) => {
    const oversizedPath = await createAuthFile(
      directory,
      `{"origin":"${origin}","headers":{"Authorization":"${canary}${'A'.repeat(64 * 1024)}"}}`,
      { filename: 'oversized.json' },
    );
    await assert.rejects(readAuthHeadersFile(oversizedPath, origin, normalizeOrigin), (error) => {
      assert.match(error.message, /64 KiB/);
      assert.equal(error.message.includes(canary), false);
      return true;
    });

    const tooManyHeaders = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`X-Test-${index}`, 'value']),
    );
    const tooManyPath = await createAuthFile(directory, validDocument(tooManyHeaders), {
      filename: 'too-many-headers.json',
    });
    await assert.rejects(
      readAuthHeadersFile(tooManyPath, origin, normalizeOrigin),
      /at most 64 headers/,
    );

    const exactly64 = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`X-Test-${index}`, 'value']),
    );
    const exactly64Path = await createAuthFile(directory, validDocument(exactly64), {
      filename: '64-headers.json',
    });
    const result = await readAuthHeadersFile(exactly64Path, origin, normalizeOrigin);
    assert.equal(Object.keys(result.headers).length, 64);
  });
});

test('rejects non-JSON and non-regular files without including file contents', async () => {
  await withTempDir(async (directory) => {
    const malformedPath = await createAuthFile(directory, `{"token":"${canary}"`, {
      filename: 'malformed.json',
    });
    await assert.rejects(readAuthHeadersFile(malformedPath, origin, normalizeOrigin), (error) => {
      assert.match(error.message, /valid JSON/);
      assert.equal(error.message.includes(canary), false);
      return true;
    });

    await assert.rejects(readAuthHeadersFile(directory, origin, normalizeOrigin), /regular file/);
  });
});

test('rejects Linux FIFOs before opening them', async (t) => {
  if (process.platform !== 'linux') return t.skip('FIFO preflight is covered on Linux');
  await withTempDir(async (directory) => {
    const fifoPath = path.join(directory, 'auth-fifo');
    execFileSync('mkfifo', [fifoPath]);
    await assert.rejects(readAuthHeadersFile(fifoPath, origin, normalizeOrigin), /regular file/);
  });
});
