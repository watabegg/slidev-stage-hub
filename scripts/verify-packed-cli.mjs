import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packCli, packageNames, runProcess } from './pack-cli.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(repository, 'artifacts/step5');
const temporary = await mkdtemp(join(tmpdir(), 'stage-hub-packed-'));
const install = join(temporary, 'install');
const cwd = join(temporary, 'empty-cwd');
const project = join(temporary, 'project');
const checks = [];
await mkdir(evidence, { recursive: true });
await mkdir(cwd);
await mkdir(join(project, 'slides/demo'), { recursive: true });
// Legacy machine settings must not influence the new CLI.
const env = {
  ...process.env,
  SLIDEV_LAB_THEME: '/missing/legacy-theme',
  SLIDEV_LAB_FIXTURES_ROOT: '/missing/legacy-slides',
};
let server;
async function cli(bin, args, expected = 0) {
  console.log(`Packed CLI verification: ${bin} ${args[0]}`);
  const result = await runProcess(join(install, 'node_modules/.bin', bin), [...args, '--json'], {
    cwd,
    env,
  });
  assert.equal(result.code, expected, `${bin} ${args[0]}: ${result.stderr}\n${result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, expected === 0);
  checks.push(`${bin} ${args[0]} (exit ${expected})`);
  return output;
}
try {
  console.log('Packed CLI verification: pack and install');
  await packCli(install);
  const installed = await runProcess('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], {
    cwd: install,
  });
  await writeFile(join(evidence, 'install.log'), installed.stdout + installed.stderr);
  assert.equal(installed.code, 0, installed.stderr);
  for (const name of packageNames) {
    const actual = await realpath(join(install, 'node_modules/@slidock', name));
    assert.ok(
      !relative(repository, actual)
        .split(sep)
        .every((part) => part !== '..'),
      `Package escaped isolation: ${actual}`,
    );
    assert.ok(actual.startsWith(install + sep), `Package not installed from tarball: ${actual}`);
  }
  checks.push('five private tarballs installed outside workspace without repository symlinks');
  await cli('slidock', ['--help']);
  await cli('slive', ['--version']);
  await cli('hub', ['--help']);
  await cli('stage', ['--version']);
  await cli('slidock', ['publish'], 2);
  await cli('slive', ['prepare', '--unknown-option'], 2);
  const jobsFixture = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/capabilities') {
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          publicationJobs: { enabled: true, pollAfterMs: 2000 },
          thumbnail: { available: false },
          limits: { requestBytes: 524288, maxSlides: 100 },
        }),
      );
    } else if (request.url?.startsWith('/api/decks/packed/jobs?')) {
      response.end(JSON.stringify({ schemaVersion: 1, items: [] }));
    } else response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    jobsFixture.once('error', reject);
    jobsFixture.listen(0, '127.0.0.1', resolve);
  });
  try {
    const jobsOrigin = 'http://127.0.0.1:' + jobsFixture.address().port;
    const remote = join(project, 'packed.remote.json');
    await cli('slidock', ['init', '--origin', jobsOrigin, '--remote-config', remote]);
    await cli('slidock', ['doctor', '--remote-config', remote]);
    await cli('slidock', ['jobs', 'list', '--id', 'packed', '--remote-config', remote]);
    checks.push('packed remote profile, doctor and publication job client run outside workspace');
  } finally {
    await new Promise((resolve) => {
      jobsFixture.close(resolve);
      jobsFixture.closeAllConnections();
    });
  }
  await writeFile(
    join(project, 'slides/demo/slides.md'),
    '---\ntheme: default\ntitle: Packed CLI\nfonts:\n  webfonts: []\n  sans: Arial\n  mono: monospace\n---\n\n# Packed CLI\n\n<!-- PRIVATE_NOTE_PACKED -->\n\n---\n\n# Second page\n',
  );
  const chromiumExecutable = process.env.CHROMIUM_EXECUTABLE;
  await writeFile(
    join(project, 'hub.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      sourceRoot: 'slides',
      outDir: 'site',
      offline: false,
      ...(chromiumExecutable ? { chromiumExecutable } : {}),
    }),
  );
  await cli('slidock', ['check', '--config', join(project, 'hub.config.json')]);
  await cli('slidock', ['build', '--config', join(project, 'hub.config.json')]);
  const site = join(project, 'site');
  const catalog = JSON.parse(await readFile(join(site, 'catalog.json'), 'utf8'));
  assert.equal(catalog.decks.length, 1);
  await cli('slidock', [
    'thumbnail',
    '--site',
    site,
    ...(chromiumExecutable ? ['--chromium-executable', chromiumExecutable] : []),
  ]);
  const config = join(project, '.slidev-stage/local-config.json');
  await cli('slive', [
    'prepare',
    '--site',
    site,
    '--fixtures-root',
    join(project, 'slides'),
    '--output-config',
    config,
  ]);
  await cli('slive', ['doctor', '--output-config', config]);
  const runtime = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(runtime.schemaVersion, 1);
  assert.ok(runtime.siteRoot.includes(`${sep}versions${sep}`));
  server = spawn(
    join(install, 'node_modules/.bin/slidock'),
    ['serve', '--site', site, '--port', '0', '--json'],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ready = await new Promise((accept, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error('Packed slidock serve readiness timeout')),
      15000,
    );
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Packed slidock serve exited (${code})`));
    });
    server.stderr.resume();
    server.stdout.on('data', (data) => {
      buffer += data;
      if (buffer.includes('\n')) {
        clearTimeout(timer);
        try {
          accept(JSON.parse(buffer.trim()));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  const origin = ready.data.origin ?? ready.data.url;
  assert.equal(typeof origin, 'string');
  assert.equal((await fetch(origin)).status, 200);
  checks.push('packed slidock serve returns site over HTTP');
  await cli('slive', ['connect', origin, '--output-config', join(project, 'remote.json')]);
  await cli('slive', ['doctor', '--output-config', join(project, 'remote.json')]);
  const headless = await runProcess(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    delete globalThis.window; delete globalThis.document; delete globalThis.fetch;
    const { getCatalog, createPublicationJobClient } = await import('@slidock/slidock/client');
    if (typeof createPublicationJobClient !== 'function') throw new Error('Missing publication client export');
    const value = await getCatalog({ load: async () => ({ schemaVersion: 1, decks: [], categories: [] }) });
    if (value.decks.length !== 0) throw new Error('Unexpected catalog');
  `,
    ],
    { cwd: install },
  );
  assert.equal(headless.code, 0, headless.stderr);
  checks.push('packed client runs without browser globals');
  const customEntry = join(install, 'custom.ts');
  await writeFile(
    customEntry,
    `import { mountHub } from '@slidock/slidock/frontend';
import '@slidock/slidock/frontend/style.css';
await mountHub('#app', { navigation: { homeLabel: 'Packed custom frontend' } });
`,
  );
  await cli('slidock', [
    'build',
    '--config',
    join(project, 'hub.config.json'),
    '--frontend-entry',
    customEntry,
    '--out-dir',
    join(project, 'custom-site'),
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(join(project, 'custom-site/catalog.json'), 'utf8')),
    catalog,
  );
  checks.push('packed frontend and stylesheet exports build outside repository');
  await writeFile(
    join(evidence, 'gate.json'),
    JSON.stringify({ status: 'passed', checks }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ status: 'passed', checks }));
} catch (error) {
  await writeFile(
    join(evidence, 'gate.json'),
    JSON.stringify({ status: 'failed', checks, error: error.message }, null, 2) + '\n',
  );
  throw error;
} finally {
  if (server && server.exitCode === null) {
    await new Promise((accept) => {
      const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
      server.once('close', () => {
        clearTimeout(timer);
        accept();
      });
      server.kill('SIGTERM');
    });
  }
  if (process.env.KEEP_PACKED_CLI_TMP === '1')
    console.log(`Packed verification workspace: ${temporary}`);
  else await rm(temporary, { recursive: true, force: true });
}
