import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const themeRoot = resolve(process.env.SLIDEV_THEME_PATH || '/home/watabegg/slidev-watabegg');
const artifactRoot = resolve(root, 'bundle-sharing/artifacts/baseline');
const resultsRoot = resolve(root, 'bundle-sharing/results');
const ids = ['aaa/aaa1', 'aaa/aaa2', 'bbb/bbb1', 'bbb/bbb2'];

const themeRequire = createRequire(resolve(themeRoot, 'package.json'));
const cliEntry = themeRequire.resolve('@slidev/cli/dist/index.mjs');
const cliRequire = createRequire(cliEntry);
const parserPath = cliRequire.resolve('@slidev/parser');
const { parseSync } = await import(parserPath);
assert(cliEntry.startsWith(resolve(themeRoot, 'node_modules')), 'Slidev CLI must resolve from the local theme installation');

async function packageVersion(path) {
  return JSON.parse(await readFile(path, 'utf8')).version;
}

function resolvePackageFromCli(name) {
  return cliRequire.resolve(`${name}/package.json`);
}

function git(args, { encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['-C', themeRoot, ...args], { encoding });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error}`);
  return result.stdout;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function themeSnapshot() {
  const revision = git(['rev-parse', 'HEAD']).trim();
  const status = git(['status', '--short']).trim().split('\n').filter(Boolean);
  const diff = git(['diff', '--binary', 'HEAD'], { encoding: null });
  const untrackedPaths = git(['ls-files', '--others', '--exclude-standard', '-z'], { encoding: null })
    .toString('utf8').split('\0').filter(Boolean).sort();
  const snapshot = createHash('sha256').update(diff);
  for (const path of untrackedPaths) {
    const contentHash = sha256(await readFile(resolve(themeRoot, path)));
    snapshot.update(path).update('\0').update(contentHash).update('\0');
  }
  return { revision, dirty: status.length > 0, dirtyPaths: status, workingTreeSnapshotSha256: snapshot.digest('hex') };
}

async function allFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...await allFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort((a, b) => relative(dir, a).localeCompare(relative(dir, b)));
}

async function treeMetrics(outDir) {
  const files = await allFiles(outDir);
  assert(files.length > 0, `Build output is empty: ${outDir}`);
  let rawBytes = 0;
  let gzipBytes = 0;
  const fileHashes = [];
  const tree = createHash('sha256');
  for (const path of files) {
    const bytes = await readFile(path);
    const relPath = relative(outDir, path).split(sep).join('/');
    const digest = sha256(bytes);
    rawBytes += bytes.byteLength;
    gzipBytes += gzipSync(bytes).byteLength;
    fileHashes.push({ path: relPath, bytes: bytes.byteLength, sha256: digest });
    tree.update(relPath).update('\0').update(digest).update('\n');
  }
  return { fileCount: files.length, rawBytes, gzipBytes, treeSha256: tree.digest('hex'), files: fileHashes };
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${signal || `code ${code}`}`));
    });
  });
}

function parseSource(id, markdown, sourcePath) {
  const parsed = parseSync(markdown, sourcePath);
  const clickSteps = parsed.slides.map((slide) => (slide.content.match(/\bv-click\b/g) || []).length);
  const sentinel = `PRIVATE_NOTE_${id.split('/')[1]}`;
  const noteCount = parsed.slides.filter((slide) => slide.note?.includes(sentinel)).length;
  assert.equal(parsed.slides.length, 3, `${id} must have exactly three pages`);
  assert.deepEqual(clickSteps, [0, 2, 0], `${id} click steps differ from the fixture contract`);
  assert.equal(noteCount, 2, `${id} must retain both private note sentinels in source`);
  assert.match(markdown, /<QuestionList\b/, `${id} must exercise the theme component`);
  assert.match(markdown, /layout: two-cols/, `${id} must exercise the theme layout`);
  assert.match(markdown, /layout: section/, `${id} must exercise the theme section layout`);
  assert.match(markdown, /<style scoped>/, `${id} must include scoped fixture CSS`);
  assert.match(markdown, /\.fixture-conflict\s*\{/, `${id} must include the conflicting CSS selector`);
  assert.match(markdown, /```mermaid/, `${id} must exercise theme setup for Mermaid`);
  assert.match(markdown, /```ts/, `${id} must exercise code highlighting`);
  assert.match(markdown, /\$\$/, `${id} must exercise math rendering`);
  assert.match(markdown, /\!\[Conflict fixture image\]\(\.\/assets\/conflict\.svg\)/, `${id} must use the same relative image path`);
  return { pageCount: parsed.slides.length, clickSteps, privateNoteSentinelsInSource: noteCount };
}

const theme = await themeSnapshot();
const cliVersion = await packageVersion(cliRequire.resolve('@slidev/cli/package.json'));
const viteVersion = await packageVersion(resolvePackageFromCli('vite'));
const postcssVersion = await packageVersion(resolvePackageFromCli('postcss'));
const parserVersion = await packageVersion(cliRequire.resolve('@slidev/parser/package.json'));
const pnpmVersion = spawnSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const startedAt = new Date().toISOString();
const decks = [];

const imageHashes = await Promise.all(ids.map(async (id) => {
  const imagePath = resolve(root, '../../examples/fixtures', id, 'assets/conflict.svg');
  return { id, sha256: sha256(await readFile(imagePath)) };
}));
assert.equal(new Set(imageHashes.map(({ sha256: hash }) => hash)).size, ids.length, 'Fixture images must have distinct bytes');

await mkdir(artifactRoot, { recursive: true });
await mkdir(resultsRoot, { recursive: true });

for (const id of ids) {
  const sourcePath = resolve(root, '../../examples/fixtures', id, 'slides.md');
  const markdown = await readFile(sourcePath, 'utf8');
  const source = parseSource(id, markdown, sourcePath);
  const sentinel = `PRIVATE_NOTE_${id.split('/')[1]}`;
  const outDir = resolve(artifactRoot, id);
  const base = `/${id}/`;
  const args = ['exec', 'slidev', 'build', relative(root, sourcePath), '--out', outDir, '--base', base, '--without-notes'];

  await rm(outDir, { recursive: true, force: true });
  await mkdir(dirname(outDir), { recursive: true });
  console.log(`\n[baseline] ${id}`);
  console.log(`COMMAND pnpm ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
  const buildStarted = performance.now();
  await run('pnpm', args, root);
  const buildElapsedMs = Number((performance.now() - buildStarted).toFixed(3));

  const files = await allFiles(outDir);
  const matchingFiles = [];
  for (const path of files) {
    const bytes = await readFile(path);
    if (bytes.includes(Buffer.from(sentinel)))
      matchingFiles.push(relative(outDir, path).split(sep).join('/'));
  }
  assert.deepEqual(matchingFiles, [], `${sentinel} leaked into public output: ${matchingFiles.join(', ')}`);
  const metrics = await treeMetrics(outDir);
  const record = {
    id,
    sourcePath: relative(root, sourcePath).split(sep).join('/'),
    outputPath: relative(root, outDir).split(sep).join('/'),
    base,
    command: ['pnpm', ...args],
    source,
    privateNoteSentinel: sentinel,
    privateNoteSentinelPublicMatches: matchingFiles.length,
    buildElapsedMs,
    ...metrics,
  };
  decks.push(record);
  console.log(`[baseline] ${id}: ${source.pageCount} pages, ${metrics.fileCount} files, ${metrics.rawBytes} raw bytes, ${metrics.gzipBytes} gzipped bytes, ${buildElapsedMs} ms, ${metrics.treeSha256}`);
}

const report = {
  schemaVersion: 1,
  status: 'PASS',
  startedAt,
  finishedAt: new Date().toISOString(),
  command: 'pnpm baseline',
  packageManager: packageJson.packageManager,
  environment: {
    platform: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    node: process.version,
    pnpm: pnpmVersion,
    slidevCli: cliVersion,
    slidevParser: parserVersion,
    vite: viteVersion,
    postcss: postcssVersion,
  },
  theme: {
    name: 'slidev-theme-watabegg',
    version: JSON.parse(await readFile(resolve(themeRoot, 'package.json'), 'utf8')).version,
    ...theme,
  },
  fixtureImageSha256: imageHashes,
  measurement: {
    rawBytes: 'Sum of bytes of every emitted build file.',
    gzipBytes: 'Sum of per-file gzipSync bytes (zlib default level), useful as a static-transfer estimate.',
    buildElapsedMs: 'Wall time around each sequential pnpm exec build process, including process startup.',
    treeSha256: 'SHA-256 over sorted output relative paths and per-file SHA-256 digests.',
  },
  decks,
};

const reportPath = resolve(resultsRoot, 'baseline-metrics.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n[baseline] PASS — metrics: ${relative(root, reportPath)}`);
