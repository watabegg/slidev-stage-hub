import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fingerprintOfflineSite } from './fingerprint-offline.mjs';

const execFileAsync = promisify(execFile);
const repo = resolve(new URL('..', import.meta.url).pathname);

async function site(t, files, parent = tmpdir()) {
  const root = await mkdtemp(join(parent, 'offline-fingerprint-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  return root;
}

async function snapshot(root) {
  const files = {};
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${path}/`);
      else files[path] = (await readFile(join(root, path))).toString('base64');
    }
  }
  await walk(root);
  return files;
}

test('rewrites cyclic modules, group assets, HTML, CSS and manifest while preserving binaries and other directories', async t => {
  const binary = Buffer.from([0, 255, 128, ...Buffer.from('/assets/a.js')]);
  const root = await site(t, {
    'assets/a.js': 'import { b } from "./b.js"; export const a = 1; export function total() { return a + b; }',
    'assets/b.js': 'import { a } from "./a.js"; export const b = 2; export function read() { return a; }',
    'assets/entry.js': 'import "./a.js"; const deps = ["assets/a.js", "assets/theme.css"];',
    'assets/theme.css': '@import url("./parts/base.css"); @import "/_fonts/abc.css"; .a { background: url("./logo.png"); }',
    'assets/parts/base.css': '.a { color: red; }',
    'assets/logo.png': binary,
    '_fonts/abc.css': '@font-face { src: url("/_fonts/abc.woff2"); }',
    '_fonts/abc.woff2': binary,
    'groups/alternate/assets/entry.js': 'import "../../../assets/a.js"; import "./helper.js";',
    'groups/alternate/assets/helper.js': 'export const group = "alternate";',
    'groups/alternate/index.html': '<script src="assets/entry.js"></script>',
    'notassets/entry.js': 'export const unrelated = true;',
    'index.html': '<script src="/assets/entry.js?version=1#entry"></script><link href="/assets/theme.css"><script src="/notassets/entry.js"></script><script src="https://example.com/assets/entry.js"></script><script src="//example.com/assets/entry.js"></script>',
    'manifest.json': JSON.stringify({ commonAssets: ['assets/a.js', '/assets/theme.css', '_fonts/abc.css'], decks: [{ entry: '/groups/alternate/assets/entry.js', assets: ['groups/alternate/assets/helper.js'] }] }),
  });
  const result = await fingerprintOfflineSite(root);
  const mapping = new Map(result.assets.map(({ from, to }) => [from, to]));
  assert.equal(result.renamedAssets, 7);
  assert.match(result.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(root, mapping.get('assets/a.js')), 'utf8'), `import { b } from "./${mapping.get('assets/b.js').split('/').at(-1)}"; export const a = 1; export function total() { return a + b; }`);
  assert.equal((await import(pathToFileURL(join(root, mapping.get('assets/a.js'))).href)).total(), 3);
  const entry = await readFile(join(root, mapping.get('assets/entry.js')), 'utf8');
  assert.ok(entry.includes(`"${mapping.get('assets/a.js')}"`));
  assert.ok(entry.includes(`"${mapping.get('assets/theme.css')}"`));
  const group = await readFile(join(root, mapping.get('groups/alternate/assets/entry.js')), 'utf8');
  assert.ok(group.includes(`"../../../${mapping.get('assets/a.js')}"`));
  assert.ok(group.includes(`"./${mapping.get('groups/alternate/assets/helper.js').split('/').at(-1)}"`));
  assert.equal(await readFile(join(root, 'groups/alternate/index.html'), 'utf8'), `<script src="assets/${mapping.get('groups/alternate/assets/entry.js').split('/').at(-1)}"></script>`);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.ok(html.includes(`src="/${mapping.get('assets/entry.js')}?version=1#entry"`));
  assert.ok(html.includes(`href="/${mapping.get('assets/theme.css')}"`));
  assert.ok(html.includes('src="/notassets/entry.js"'));
  assert.ok(html.includes('src="https://example.com/assets/entry.js"'));
  assert.ok(html.includes('src="//example.com/assets/entry.js"'));
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.commonAssets, [mapping.get('assets/a.js'), `/${mapping.get('assets/theme.css')}`, '_fonts/abc.css']);
  assert.equal(manifest.decks[0].entry, `/${mapping.get('groups/alternate/assets/entry.js')}`);
  assert.deepEqual(manifest.decks[0].assets, [mapping.get('groups/alternate/assets/helper.js')]);
  const css = await readFile(join(root, mapping.get('assets/theme.css')), 'utf8');
  assert.ok(css.includes(`./parts/${mapping.get('assets/parts/base.css').split('/').at(-1)}`));
  assert.ok(css.includes('/_fonts/abc.css'));
  assert.deepEqual(await readFile(join(root, 'assets/logo.png')), binary);
  assert.deepEqual(await readFile(join(root, '_fonts/abc.woff2')), binary);
  assert.equal(await readFile(join(root, 'notassets/entry.js'), 'utf8'), 'export const unrelated = true;');
  await assert.rejects(stat(join(root, 'assets/a.js')), { code: 'ENOENT' });
});

test('identical snapshots are deterministic and font or CSS changes refresh ancestor JS URLs', async t => {
  const files = {
    'index.html': '<script src="/assets/entry.js"></script>',
    'assets/entry.js': 'import "./child.js";',
    'assets/child.js': 'const deps = ["assets/style.css"];',
    'assets/style.css': '@import "/_fonts/old.css";',
    '_fonts/old.css': '@font-face { src: url("old.woff2"); }',
    '_fonts/old.woff2': Buffer.from('first font'),
  };
  const roots = await Promise.all([
    site(t, files),
    site(t, Object.fromEntries(Object.entries(files).reverse())),
    site(t, { ...files, '_fonts/old.woff2': Buffer.from('second font') }),
    site(t, { ...files, 'assets/style.css': '@import "/_fonts/new.css";' }),
  ]);
  const results = await Promise.all(roots.map(fingerprintOfflineSite));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await snapshot(roots[0]), await snapshot(roots[1]));
  for (const changed of results.slice(2)) {
    assert.notEqual(results[0].snapshotSha256, changed.snapshotSha256);
    for (const path of ['assets/entry.js', 'assets/child.js', 'assets/style.css']) {
      assert.notEqual(results[0].assets.find(asset => asset.from === path).to, changed.assets.find(asset => asset.from === path).to);
    }
  }
});

test('a repeated invocation rejects before modifying the site', async t => {
  const root = await site(t, { 'index.html': '<script src="assets/main.js"></script>', 'assets/main.js': 'export const value = 1;' });
  await fingerprintOfflineSite(root);
  const before = await snapshot(root);
  await assert.rejects(fingerprintOfflineSite(root), /already fingerprinted/);
  assert.deepEqual(await snapshot(root), before);
});

test('prepare-offline fingerprints after favicon rewriting and measures the renamed files', async t => {
  const favicon = 'https://cdn.jsdelivr.net/gh/slidevjs/slidev/assets/favicon.png';
  const source = await site(t, {
    'index.html': '<script src="/assets/main.js"></script>',
    'assets/main.js': `export const favicon = "${favicon}";`,
    'manifest.json': JSON.stringify({ commonAssets: ['assets/main.js'], decks: [{ assets: ['assets/main.js'] }] }),
  });
  const artifacts = join(repo, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const outputDirectory = await mkdtemp(join(artifacts, 'offline-fingerprint-test-'));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const target = join(outputDirectory, 'site');
  await execFileAsync(process.execPath, [join(repo, 'scripts/prepare-offline.mjs'), source, target]);
  const metrics = JSON.parse(await readFile(join(outputDirectory, 'offline-metrics.json'), 'utf8'));
  const asset = metrics.fingerprint.assets[0];
  assert.equal(await readFile(join(target, asset.to), 'utf8'), 'export const favicon = "/favicon.svg";');
  assert.ok(metrics.files.some(file => file.path === asset.to));
  assert.ok(!metrics.files.some(file => file.path === asset.from));
  assert.equal(metrics.rawBytes, (await Promise.all(metrics.files.map(file => stat(join(target, file.path))))).reduce((sum, file) => sum + file.size, 0));
  const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.commonAssets, [asset.to, 'favicon.svg']);
  assert.deepEqual(manifest.decks[0].assets, [asset.to]);
  assert.equal(Object.hasOwn(metrics, 'limitation'), false);
});
