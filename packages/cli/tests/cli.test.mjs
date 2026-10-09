import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hubBin = path.join(packageRoot, 'dist/bin/hub.js');
const stageBin = path.join(packageRoot, 'dist/bin/stage.js');

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slidev-stage-hub-cli-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function run(bin, args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function runAsync(bin, args, cwd) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status, signal) => accept({ status, signal, stdout, stderr }));
  });
}

function jsonOutput(result) {
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
  return JSON.parse(result.stdout);
}

test('both bins provide help and version in the JSON envelope', async () => {
  await withTempDir(async (cwd) => {
    for (const [bin, args, label] of [
      [hubBin, ['--help', '--json'], 'hub'],
      [stageBin, ['--json', '--version'], 'stage'],
    ]) {
      const result = run(bin, args, cwd);
      assert.equal(result.status, 0, result.stderr);
      const envelope = jsonOutput(result);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.command, label);
      assert.ok(envelope.data.help || envelope.data.version);
    }
    const version = run(hubBin, ['--version', '--json'], cwd);
    assert.equal(version.status, 0);
    assert.equal(jsonOutput(version).data.version, '0.1.0');
  });
});

test('invalid arguments return input exit code without creating build outputs', async () => {
  await withTempDir(async (cwd) => {
    const result = run(
      hubBin,
      [
        'build',
        '--source-root',
        'slides',
        '--out-dir',
        'dist',
        '--unknown',
        'PRIVATE_VALUE',
        '--json',
      ],
      cwd,
    );
    assert.equal(result.status, 2);
    const envelope = jsonOutput(result);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, 'hub build');
    assert.equal(envelope.error.code, 'INVALID_ARGUMENTS');
    assert.equal(`${result.stdout}${result.stderr}`.includes('PRIVATE_VALUE'), false);
    await assert.rejects(readFile(path.join(cwd, 'dist')));
  });
});

test('unknown top-level commands and misplaced positionals fail in JSON mode', async () => {
  await withTempDir(async (cwd) => {
    for (const [bin, args, command] of [
      [hubBin, ['--json', 'typo'], 'hub typo'],
      [stageBin, ['--json', 'typo'], 'stage typo'],
      [hubBin, ['serve', 'extra', '--json'], 'hub serve'],
      [stageBin, ['prepare', 'extra', '--json'], 'stage prepare'],
    ]) {
      const result = run(bin, args, cwd);
      assert.equal(result.status, 2);
      const envelope = jsonOutput(result);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.command, command);
    }
  });
});

test('hub check resolves config paths from its file and flag paths from caller cwd', async () => {
  await withTempDir(async (root) => {
    const caller = path.join(root, 'caller');
    const configDir = path.join(root, 'config');
    const configSource = path.join(configDir, 'source');
    const callerSource = path.join(caller, 'override-source');
    const dependencyRoot = path.join(configDir, 'dependencies');
    const theme = path.join(configDir, 'theme');
    await Promise.all([
      mkdir(caller, { recursive: true }),
      mkdir(path.join(configSource, 'unused'), { recursive: true }),
      mkdir(path.join(configSource, 'configured-course'), { recursive: true }),
      mkdir(path.join(callerSource, 'course', 'topic'), { recursive: true }),
      mkdir(dependencyRoot, { recursive: true }),
      mkdir(theme, { recursive: true }),
    ]);
    await writeFile(path.join(callerSource, 'course', 'topic', 'slides.md'), '# Topic\n');
    await writeFile(path.join(configSource, 'configured-course', 'slides.md'), '# Configured\n');
    const configPath = path.join(configDir, 'hub.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        sourceRoot: './source',
        outDir: './configured-output',
        dependencyRoot: './dependencies',
        theme: './theme',
      }),
    );

    const result = run(
      hubBin,
      ['check', '--config', configPath, '--source-root', 'override-source', '--json'],
      caller,
    );
    assert.equal(result.status, 0, result.stderr);
    const data = jsonOutput(result).data;
    assert.deepEqual(data.deckIds, ['course/topic']);
    assert.equal(data.sourceRoot, callerSource);
    assert.equal(data.outDir, path.join(configDir, 'configured-output'));
    assert.equal(data.dependencyRoot, dependencyRoot);
    assert.equal(data.theme, theme);
    await assert.rejects(readFile(data.outDir));

    const configRelative = run(hubBin, ['check', '--config', configPath, '--json'], caller);
    assert.equal(configRelative.status, 0, configRelative.stderr);
    const relativeData = jsonOutput(configRelative).data;
    assert.deepEqual(relativeData.deckIds, ['configured-course']);
    assert.equal(relativeData.sourceRoot, configSource);
    assert.equal(relativeData.outDir, path.join(configDir, 'configured-output'));
  });
});

test('hub defaults source and output paths from the caller working directory', async () => {
  await withTempDir(async (cwd) => {
    const sourceRoot = path.join(cwd, 'slides');
    await mkdir(path.join(sourceRoot, 'default-course'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'default-course', 'slides.md'), '# Default\n');
    const result = run(hubBin, ['check', '--json'], cwd);
    assert.equal(result.status, 0, result.stderr);
    const data = jsonOutput(result).data;
    assert.equal(data.sourceRoot, sourceRoot);
    assert.equal(data.outDir, path.join(cwd, 'dist'));
    assert.deepEqual(data.deckIds, ['default-course']);
    await assert.rejects(readFile(data.outDir));
  });
});

test('hub config rejects unknown fields before build side effects', async () => {
  await withTempDir(async (cwd) => {
    await mkdir(path.join(cwd, 'slides', 'deck'), { recursive: true });
    await writeFile(path.join(cwd, 'slides', 'deck', 'slides.md'), '# Deck\n');
    const configPath = path.join(cwd, 'hub.config.json');
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, outDir: 'built', credentialValue: 'PRIVATE_VALUE' }),
    );
    const result = run(hubBin, ['build', '--config', configPath, '--json'], cwd);
    assert.equal(result.status, 2);
    const envelope = jsonOutput(result);
    assert.equal(envelope.error.code, 'INVALID_CONFIG');
    assert.equal(`${result.stdout}${result.stderr}`.includes('PRIVATE_VALUE'), false);
    await assert.rejects(readFile(path.join(cwd, 'built')));
  });
});

test('stage doctor reports a missing runtime config and does not create it', async () => {
  await withTempDir(async (cwd) => {
    const result = run(stageBin, ['doctor', '--json'], cwd);
    assert.equal(result.status, 1);
    const envelope = jsonOutput(result);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, 'stage doctor');
    assert.equal(envelope.error.code, 'NOT_READY');
    assert.ok(envelope.error.checks.some((check) => check.name === 'runtime-config' && !check.ok));
    await assert.rejects(readFile(path.join(cwd, '.slidev-stage', 'local-config.json')));
    await assert.rejects(readFile(path.join(cwd, '.slidev-stage')));
  });
});

test('stage doctor validates an existing remote runtime and private auth file read-only', async () => {
  await withTempDir(async (cwd) => {
    const origin = 'https://slides.example.test';
    const authFile = path.join(cwd, 'headers.json');
    const outputConfig = path.join(cwd, 'runtime.json');
    await writeFile(
      authFile,
      JSON.stringify({ origin, headers: { Authorization: 'Bearer DOCTOR_CANARY' } }),
      {
        mode: 0o600,
      },
    );
    await chmod(authFile, 0o600);
    await writeFile(
      outputConfig,
      JSON.stringify({
        schemaVersion: 1,
        decks: [{ id: 'deck-one', revision: 'revision-1', entry: '/deck-one/1', clickTotals: [0] }],
        notes: {},
        approvedSourceRoot: path.join(cwd, 'approved'),
        viewerOrigin: origin,
        authHeadersFile: authFile,
      }),
    );
    const original = await readFile(outputConfig, 'utf8');
    const result = run(stageBin, ['doctor', '--output-config', outputConfig, '--json'], cwd);
    assert.equal(result.status, 0, result.stderr);
    const envelope = jsonOutput(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.ready, true);
    assert.ok(envelope.data.checks.some((check) => check.name === 'auth-headers' && check.ok));
    assert.equal(`${result.stdout}${result.stderr}`.includes('DOCTOR_CANARY'), false);
    assert.equal(await readFile(outputConfig, 'utf8'), original);
  });
});

test('stage settings reject generated runtime keys before creating an output config', async () => {
  await withTempDir(async (cwd) => {
    const settingsPath = path.join(cwd, 'stage.config.json');
    await writeFile(settingsPath, JSON.stringify({ schemaVersion: 1, decks: [] }));
    const result = run(stageBin, ['prepare', '--config', settingsPath, '--json'], cwd);
    assert.equal(result.status, 2);
    const envelope = jsonOutput(result);
    assert.equal(envelope.error.code, 'INVALID_CONFIG');
    assert.match(envelope.error.message, /--output-config/);
    await assert.rejects(readFile(path.join(cwd, '.slidev-stage', 'local-config.json')));
  });
});

test('hub serve prints a ready JSON envelope after binding and closes on SIGTERM', async () => {
  await withTempDir(async (cwd) => {
    const site = path.join(cwd, 'site');
    await mkdir(site);
    await writeFile(path.join(site, 'index.html'), '<h1>served</h1>\n');
    const child = spawn(
      process.execPath,
      [hubBin, 'serve', '--site', site, '--port', '0', '--json'],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    await new Promise((accept, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`serve did not become ready: ${stderr}`)),
        10_000,
      );
      child.stdout.on('data', () => {
        if (stdout.includes('\n')) {
          clearTimeout(timeout);
          accept();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`serve exited before ready (${code}): ${stderr}`));
      });
    });
    const envelope = JSON.parse(stdout.trim());
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, 'hub serve');
    assert.equal(envelope.data.site, site);
    assert.match(envelope.data.origin, /^http:\/\//);
    const response = await fetch(`${envelope.data.origin}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<h1>served</h1>\n');
    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null);
    assert.equal(code, 0, stderr);
  });
});

test('stage connect forwards private auth and reports no header or manifest detail', async () => {
  await withTempDir(async (cwd) => {
    const secret = 'Bearer CLI_AUTH_CANARY';
    const manifestDetail = 'PRIVATE_MANIFEST_REASON_CANARY';
    let receivedAuthorization;
    const server = http.createServer((request, response) => {
      receivedAuthorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          protocolVersion: 1,
          decks: [
            {
              id: 'course/topic',
              revision: 'revision-1',
              entry: '/course/topic/1',
              clickTotals: [0, 1],
            },
          ],
          unsupportedDecks: [{ id: 'course/ignored', reason: manifestDetail }],
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const headersFile = path.join(cwd, 'headers.json');
    const outputConfig = path.join(cwd, 'runtime', 'config.json');
    await writeFile(headersFile, JSON.stringify({ origin, headers: { Authorization: secret } }), {
      mode: 0o600,
    });
    await chmod(headersFile, 0o600);
    try {
      const result = await runAsync(
        stageBin,
        [
          'connect',
          origin,
          '--output-config',
          outputConfig,
          '--headers-file',
          headersFile,
          '--json',
        ],
        cwd,
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const envelope = jsonOutput(result);
      assert.equal(envelope.ok, true);
      assert.deepEqual(envelope.data.unsupportedDeckIds, ['course/ignored']);
      assert.equal(receivedAuthorization, secret);
      const outputConfigJson = await readFile(outputConfig, 'utf8');
      assert.equal(outputConfigJson.includes(secret), false);
      assert.equal(outputConfigJson.includes(manifestDetail), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
      assert.equal(`${result.stdout}${result.stderr}`.includes(manifestDetail), false);
    } finally {
      await new Promise((accept) => server.close(accept));
    }
  });
});

test('help lists actionable command flags and empty path values fail before mutation', async () => {
  await withTempDir(async (cwd) => {
    for (const [bin, command, flag] of [
      [hubBin, 'build', '--source-root'],
      [stageBin, 'prepare', '--output-config'],
    ]) {
      const help = run(bin, ['--help', '--json'], cwd);
      assert.equal(help.status, 0);
      assert.ok(jsonOutput(help).data.help.includes(flag));
      const result = run(bin, [command, flag, '', '--json'], cwd);
      assert.equal(result.status, 2);
      assert.equal(jsonOutput(result).ok, false);
    }
  });
});

test('Stage settings resolve runtime paths from the settings file and allow caller overrides', async () => {
  await withTempDir(async (directory) => {
    const project = path.join(directory, 'project');
    const cwd = path.join(directory, 'empty');
    await mkdir(project);
    await mkdir(cwd);
    const settings = path.join(project, 'stage.config.json');
    await writeFile(settings, JSON.stringify({ schemaVersion: 1, outputConfig: 'runtime.json' }));
    await writeFile(
      path.join(project, 'runtime.json'),
      JSON.stringify({
        schemaVersion: 1,
        approvedSourceRoot: project,
        viewerOrigin: 'https://example.com',
        notes: {},
        decks: [{ id: 'demo', revision: 'v1', entry: '/demo/1', clickTotals: [0] }],
      }),
    );
    const configured = run(stageBin, ['doctor', '--config', settings, '--json'], cwd);
    assert.equal(configured.status, 0, configured.stdout);
    assert.equal(jsonOutput(configured).data.ready, true);
    const override = run(
      stageBin,
      ['doctor', '--config', settings, '--output-config', 'runtime.json', '--json'],
      cwd,
    );
    assert.equal(override.status, 1);
    assert.equal(jsonOutput(override).error.code, 'NOT_READY');
    await assert.rejects(readFile(path.join(cwd, 'runtime.json')));
  });
});
