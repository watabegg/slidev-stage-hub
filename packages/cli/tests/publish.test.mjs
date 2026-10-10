import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hubBin = path.join(packageRoot, 'dist/bin/hub.js');

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slidev-hub-publish-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withServer(handler, run) {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/api/capabilities') {
      response.writeHead(404);
      response.end();
      return;
    }
    handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function jsonOutput(result) {
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
  return JSON.parse(result.stdout);
}

async function writeHeadersFile(cwd, origin, headers, mode = 0o600) {
  const filePath = path.join(cwd, 'headers.json');
  await writeFile(filePath, JSON.stringify({ origin, headers }), { mode });
  await chmod(filePath, mode);
  return filePath;
}

function publishArgs(origin, extra = []) {
  return [
    'publish',
    '--origin',
    origin,
    '--id',
    'course/topic',
    '--source',
    'source.md',
    ...extra,
    '--json',
  ];
}

test('hub publish sends Markdown, allowed text assets, and private headers and emits only metadata', async () => {
  await withTempDir(async (cwd) => {
    const secret = 'Bearer PUBLISH_AUTH_CANARY';
    const markdown = '# MARKDOWN_BODY_CANARY\n';
    const rawResponseCanary = 'RAW_RESPONSE_BODY_CANARY';
    await writeFile(path.join(cwd, 'source.md'), markdown);
    await writeFile(
      path.join(cwd, 'assets.json'),
      JSON.stringify({ 'img/figure.svg': '<svg/>', 'styles/site.css': 'h1{color:red}' }),
    );
    let received;
    await withServer(
      async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        received = {
          url: request.url,
          method: request.method,
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'course/topic',
            revision: 'revision-1',
            entry: '/course/topic/1?revision=revision-1',
            published: true,
            cached: true,
            slides: [{ no: 1 }, { no: 2 }],
            warnings: ['generic Worker warning'],
            private: rawResponseCanary,
          }),
        );
      },
      async (origin) => {
        const headersFile = await writeHeadersFile(cwd, origin, { Authorization: secret });
        const result = await run(
          hubBin,
          publishArgs(origin, ['--assets', 'assets.json', '--headers-file', 'headers.json']),
          cwd,
        );

        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const envelope = jsonOutput(result);
        assert.deepEqual(envelope, {
          ok: true,
          command: 'hub publish',
          data: {
            origin,
            id: 'course/topic',
            entry: `${origin}/course/topic/1?revision=revision-1`,
            revision: 'revision-1',
            cached: true,
            pages: 2,
            warnings: ['generic Worker warning'],
          },
        });
        assert.deepEqual(received, {
          url: '/api/decks/course%2Ftopic',
          method: 'POST',
          authorization: secret,
          contentType: 'application/json',
          body: {
            markdown,
            assets: { 'img/figure.svg': '<svg/>', 'styles/site.css': 'h1{color:red}' },
          },
        });
        assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
        assert.equal(`${result.stdout}${result.stderr}`.includes(markdown.trim()), false);
        assert.equal(`${result.stdout}${result.stderr}`.includes(rawResponseCanary), false);
        assert.equal(
          await readFile(headersFile, 'utf8').then((value) => value.includes(secret)),
          true,
        );
      },
    );
  });
});

test('hub publish rejects missing, malformed, and positional inputs with exit code 2', async () => {
  await withTempDir(async (cwd) => {
    const missing = await run(hubBin, ['publish', '--json'], cwd);
    assert.equal(missing.status, 2);
    assert.equal(jsonOutput(missing).error.code, 'INVALID_ORIGIN');

    const positional = await run(hubBin, ['publish', 'extra', '--json'], cwd);
    assert.equal(positional.status, 2);
    assert.equal(jsonOutput(positional).ok, false);

    await writeFile(path.join(cwd, 'source.md'), '# Deck\n');
    const badId = await run(
      hubBin,
      [
        'publish',
        '--origin',
        'http://127.0.0.1:4180',
        '--id',
        '../escape',
        '--source',
        'source.md',
        '--json',
      ],
      cwd,
    );
    assert.equal(badId.status, 2);
    assert.equal(jsonOutput(badId).error.code, 'INVALID_ID');

    const badOrigin = await run(hubBin, publishArgs('http://example.com'), cwd);
    assert.equal(badOrigin.status, 2);
    assert.equal(jsonOutput(badOrigin).error.code, 'INVALID_ORIGIN');
  });
});

test('hub publish rejects non-private and mismatched private header files without sending them', async () => {
  await withTempDir(async (cwd) => {
    const secret = 'Bearer BAD_AUTH_CANARY';
    await writeFile(path.join(cwd, 'source.md'), '# Deck\n');
    let requestCount = 0;
    await withServer(
      (_request, response) => {
        requestCount += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      },
      async (origin) => {
        const invalidFiles = [
          { origin, mode: 0o644 },
          { origin: 'https://other.example', mode: 0o600 },
        ];
        for (const invalidFile of invalidFiles) {
          await writeHeadersFile(
            cwd,
            invalidFile.origin,
            { Authorization: secret },
            invalidFile.mode,
          );
          const result = await run(
            hubBin,
            publishArgs(origin, ['--headers-file', 'headers.json']),
            cwd,
          );
          assert.equal(result.status, 2);
          assert.equal(jsonOutput(result).error.code, 'INVALID_AUTH_FILE');
          assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
        }
        assert.equal(requestCount, 0);
      },
    );
  });
});

test('hub publish maps 401 and 403 to a sanitized authentication failure', async () => {
  await withTempDir(async (cwd) => {
    const secret = 'Bearer AUTH_FAILURE_CANARY';
    const responseCanary = 'AUTH_RESPONSE_BODY_CANARY';
    await writeFile(path.join(cwd, 'source.md'), '# PRIVATE_MARKDOWN_CANARY\n');
    await withServer(
      (_request, response) => {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: responseCanary }));
      },
      async (origin) => {
        await writeHeadersFile(cwd, origin, { Authorization: secret });
        const result = await run(
          hubBin,
          publishArgs(origin, ['--headers-file', 'headers.json']),
          cwd,
        );
        assert.equal(result.status, 1);
        assert.equal(jsonOutput(result).error.code, 'PUBLISH_AUTH_FAILED');
        assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
        assert.equal(`${result.stdout}${result.stderr}`.includes(responseCanary), false);
        assert.equal(`${result.stdout}${result.stderr}`.includes('PRIVATE_MARKDOWN_CANARY'), false);
      },
    );
  });
});

test('hub publish reports 409 as superseded and does not expose response or source content', async () => {
  await withTempDir(async (cwd) => {
    const responseCanary = 'SUPERSEDED_RESPONSE_CANARY';
    await writeFile(path.join(cwd, 'source.md'), '# PRIVATE_MARKDOWN_CANARY\n');
    await withServer(
      (_request, response) => {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: responseCanary }));
      },
      async (origin) => {
        const result = await run(hubBin, publishArgs(origin), cwd);
        assert.equal(result.status, 1);
        assert.equal(jsonOutput(result).error.code, 'PUBLISH_SUPERSEDED');
        assert.equal(`${result.stdout}${result.stderr}`.includes(responseCanary), false);
        assert.equal(`${result.stdout}${result.stderr}`.includes('PRIVATE_MARKDOWN_CANARY'), false);
      },
    );
  });
});

test('hub publish does not forward private headers through a redirect', async () => {
  await withTempDir(async (cwd) => {
    const secret = 'Bearer REDIRECT_AUTH_CANARY';
    await writeFile(path.join(cwd, 'source.md'), '# Deck\n');
    let redirectTargetRequests = 0;
    await withServer(
      (_request, response) => {
        redirectTargetRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      },
      async (targetOrigin) => {
        await withServer(
          (_request, response) => {
            response.writeHead(302, { location: `${targetOrigin}/collect` });
            response.end('redirect body');
          },
          async (origin) => {
            await writeHeadersFile(cwd, origin, { Authorization: secret });
            const result = await run(
              hubBin,
              publishArgs(origin, ['--headers-file', 'headers.json']),
              cwd,
            );
            assert.equal(result.status, 1);
            assert.equal(jsonOutput(result).error.code, 'PUBLISH_REDIRECTED');
            assert.equal(redirectTargetRequests, 0);
            assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
          },
        );
      },
    );
  });
});

test('hub publish maps other HTTP failures to a sanitized runtime error', async () => {
  await withTempDir(async (cwd) => {
    const responseCanary = 'HTTP_FAILURE_BODY_CANARY';
    await writeFile(path.join(cwd, 'source.md'), '# PRIVATE_MARKDOWN_CANARY\n');
    await withServer(
      (_request, response) => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: responseCanary }));
      },
      async (origin) => {
        const result = await run(hubBin, publishArgs(origin), cwd);
        assert.equal(result.status, 1);
        assert.equal(jsonOutput(result).error.code, 'PUBLISH_HTTP_ERROR');
        assert.equal(`${result.stdout}${result.stderr}`.includes(responseCanary), false);
        assert.equal(`${result.stdout}${result.stderr}`.includes('PRIVATE_MARKDOWN_CANARY'), false);
      },
    );
  });
});

test('hub publish rejects successful responses that do not match the requested deck', async () => {
  await withTempDir(async (cwd) => {
    const responseCanary = 'INVALID_SUCCESS_BODY_CANARY';
    await writeFile(path.join(cwd, 'source.md'), '# PRIVATE_MARKDOWN_CANARY\n');
    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'different/deck',
            revision: 'revision-1',
            entry: '/different/deck/1?revision=revision-1',
            published: true,
            cached: false,
            slides: [{ no: 1 }],
            warnings: [],
            private: responseCanary,
          }),
        );
      },
      async (origin) => {
        const result = await run(hubBin, publishArgs(origin), cwd);
        assert.equal(result.status, 1);
        assert.equal(jsonOutput(result).error.code, 'PUBLISH_INVALID_RESPONSE');
        assert.equal(`${result.stdout}${result.stderr}`.includes(responseCanary), false);
        assert.equal(`${result.stdout}${result.stderr}`.includes('PRIVATE_MARKDOWN_CANARY'), false);
      },
    );
  });
});

test('hub publish rejects a response larger than 1 MiB', async () => {
  await withTempDir(async (cwd) => {
    await writeFile(path.join(cwd, 'source.md'), '# Deck\n');
    await withServer(
      (_request, response) => {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': 1024 * 1024 + 1,
        });
        response.end();
      },
      async (origin) => {
        const result = await run(hubBin, publishArgs(origin), cwd);
        assert.equal(result.status, 1);
        assert.equal(jsonOutput(result).error.code, 'PUBLISH_RESPONSE_TOO_LARGE');
      },
    );
  });
});
