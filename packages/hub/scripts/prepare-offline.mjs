import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fingerprintOfflineSite } from './fingerprint-offline.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = resolve(process.argv[2] || 'artifacts/module-graph/site');
const target = resolve(process.argv[3] || 'artifacts/module-graph-offline/site');
if (source === target || target.startsWith(source + '/') || source.startsWith(target + '/'))
  throw new Error('source and output must be separate trees');
if (!target.startsWith(join(root, 'artifacts') + '/'))
  throw new Error('offline output must be under this repository artifacts/');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
const vendor = spawnSync(
  process.execPath,
  [join(root, 'scripts/vendor-fonts.mjs'), target, resolve(target, '../font-vendor.json')],
  { stdio: 'inherit' },
);
if (vendor.status !== 0) process.exit(vendor.status || 1);
// Slidev's default favicon also appears in compiled head configuration. Replace
// only this known default URL; arbitrary external deck embeds remain untouched.
const favicon = 'https://cdn.jsdelivr.net/gh/slidevjs/slidev/assets/favicon.png';
let changed = 0;
const paths = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) paths.push(path);
  }
}
await walk(target);
for (const path of paths.filter((path) => /\.(?:html|js|json)$/.test(path))) {
  const text = await readFile(path, 'utf8');
  if (text.includes(favicon)) {
    await writeFile(path, text.replaceAll(favicon, '/favicon.svg'));
    changed++;
  }
}
await writeFile(
  join(target, 'favicon.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2089eb"/><path d="M46 18H23v14h18v14H18" fill="none" stroke="white" stroke-width="7"/></svg>\n',
);
const manifestPath = join(target, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.commonAssets = [...new Set([...(manifest.commonAssets || []), 'favicon.svg'])].sort();
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const fingerprint = await fingerprintOfflineSite(target);
paths.length = 0;
await walk(target);
const files = await Promise.all(
  paths.map(async (path) => {
    const bytes = await readFile(path);
    return {
      path: relative(target, path),
      rawBytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
    };
  }),
);
const result = {
  source,
  target,
  changedFaviconFiles: changed,
  fingerprint,
  fileCount: files.length,
  rawBytes: files.reduce((n, f) => n + f.rawBytes, 0),
  gzipBytes: files.reduce((n, f) => n + f.gzipBytes, 0),
  files,
};
await writeFile(resolve(target, '../offline-metrics.json'), JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    target,
    fileCount: result.fileCount,
    rawBytes: result.rawBytes,
    gzipBytes: result.gzipBytes,
    changedFaviconFiles: changed,
    snapshotSha256: fingerprint.snapshotSha256,
    renamedAssets: fingerprint.renamedAssets,
  }),
);
