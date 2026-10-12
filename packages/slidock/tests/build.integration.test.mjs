import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const entry = new URL('../dist/node/index.js', import.meta.url).href;
async function snapshot(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${item.name}`;
      if (item.isDirectory()) await walk(join(directory, item.name), `${name}/`);
      else
        files.push([
          name,
          createHash('sha256')
            .update(await readFile(join(directory, item.name)))
            .digest('hex'),
        ]);
    }
  }
  await walk(root);
  return files.sort(([a], [b]) => a.localeCompare(b));
}
async function run(cwd, code) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd,
      env: {
        ...process.env,
        SLIDEV_LAB_THEME: '/does-not-exist',
        SLIDEV_LAB_FIXTURES_ROOT: '/does-not-exist',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    child.once('error', reject);
    child.once('close', (status) => (status === 0 ? resolve() : reject(new Error(output))));
  });
}

test(
  'public build API works from empty cwd and preserves published bytes after a late failure',
  { timeout: 240000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'hub-service-'));
    const output = join(temporary, 'published');
    const config = join(temporary, 'hub.config.json');
    try {
      await run(temporary, `await import(${JSON.stringify(entry)});`);
      assert.deepEqual(await readdir(temporary), []);
      await writeFile(
        config,
        JSON.stringify({
          schemaVersion: 1,
          sourceRoot: join(repository, 'examples/fixtures'),
          outDir: './published',
          offline: false,
          decks: [{ id: 'alpha', entry: join(repository, 'examples/fixtures/aaa/aaa1/slides.md') }],
        }),
      );
      await run(
        temporary,
        `const {buildHub}=await import(${JSON.stringify(entry)}); await buildHub({configPath:${JSON.stringify(config)}});`,
      );
      const receiptPath = `${output}.receipt.json`;
      const receiptBytes = await readFile(receiptPath, 'utf8');
      const receipt = JSON.parse(receiptBytes);
      assert.equal(receipt.output, output);
      assert.equal(receipt.decks.length, 1);
      assert.equal(receipt.decks[0].id, 'alpha');
      if (process.platform !== 'win32') assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
      const manifest = await readFile(join(output, 'manifest.json'), 'utf8');
      assert.equal(manifest.includes('sourcePath'), false);
      assert.equal(manifest.includes(repository), false);
      const before = await snapshot(output);
      await run(
        temporary,
        `const {buildHub}=await import(${JSON.stringify(entry)}); try { await buildHub({configPath:${JSON.stringify(config)},onProgress:({phase})=>{if(phase==='promote')throw new Error('test promotion failure')}}); throw new Error('unexpected success'); } catch(error) {if(error.code!=='BUILD'||!error.message.includes('test promotion failure'))throw error;}`,
      );
      assert.deepEqual(await snapshot(output), before);
      assert.equal(await readFile(receiptPath, 'utf8'), receiptBytes);
      assert.deepEqual((await readdir(temporary)).sort(), [
        'hub.config.json',
        'published',
        'published.receipt.json',
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
