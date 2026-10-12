import { createHash } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve } from 'node:path';

const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.js', '.css', '.json']);
// Match complete URL/path tokens, including an external URL's scheme, so an
// external /assets/ path cannot accidentally become a local reference.
const ASSET_REFERENCE = /[^\s"'`<>(){}[\],;\\=]+?\.(?:js|css)(?=[?#\s"'`<>(){}[\],;\\=]|$)/gi;

async function readSnapshot(root) {
  const paths = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
      else if (entry.isFile()) paths.push(path);
      else throw new Error(`unsupported entry in offline site: ${path}`);
    }
  }
  await visit(root);
  paths.sort();
  return new Map(
    await Promise.all(paths.map(async (path) => [path, await readFile(join(root, path))])),
  );
}

function isEmittedAsset(path) {
  return path.split('/').slice(0, -1).includes('assets') && /\.(?:js|css)$/i.test(path);
}

function rewriteReferences(text, sourcePath, assets) {
  return text.replace(ASSET_REFERENCE, (reference) => {
    if (reference.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(reference)) return reference;
    const candidates = reference.startsWith('/')
      ? [posix.normalize(reference.slice(1))]
      : [posix.join(posix.dirname(sourcePath), reference), posix.normalize(reference)];
    // Vite uses module-relative imports and site-relative preload-map entries.
    const source = candidates.find((path) => assets.has(path));
    if (!source) return reference;
    const destination = assets.get(source);
    return reference.slice(0, reference.lastIndexOf('/') + 1) + posix.basename(destination);
  });
}

/**
 * Fingerprint a finished offline site. Every emitted JS/CSS asset shares the
 * snapshot digest, so a changed font/CSS also refreshes ancestor module URLs
 * without attempting to hash a potentially cyclic module dependency graph.
 * Run once after all content rewriting, before measuring or serving the site.
 */
export async function fingerprintOfflineSite(siteRoot) {
  if (typeof siteRoot !== 'string' || !isAbsolute(siteRoot)) {
    throw new Error('site root must be an absolute path');
  }
  const root = resolve(siteRoot);
  const files = await readSnapshot(root);
  const emittedAssets = [...files.keys()].filter(isEmittedAsset);
  if (emittedAssets.some((path) => /-offline-[a-f0-9]{64}\.(?:js|css)$/i.test(path))) {
    throw new Error(
      'offline site is already fingerprinted; rebuild from the original site before postprocessing',
    );
  }

  const hash = createHash('sha256');
  for (const [path, bytes] of files) {
    // Length prefixes make the path/byte boundaries unambiguous for binary files.
    hash
      .update(`${Buffer.byteLength(path)}:`)
      .update(path)
      .update(`${bytes.length}:`)
      .update(bytes);
  }
  const snapshotSha256 = hash.digest('hex');
  const assets = new Map(
    emittedAssets.map((path) => {
      const extension = posix.extname(path);
      return [path, `${path.slice(0, -extension.length)}-offline-${snapshotSha256}${extension}`];
    }),
  );
  for (const destination of assets.values()) {
    if (files.has(destination))
      throw new Error(`offline fingerprint destination already exists: ${destination}`);
  }

  const rewritten = new Map();
  for (const [path, bytes] of files) {
    if (!TEXT_EXTENSIONS.has(posix.extname(path).toLowerCase())) continue;
    const text = bytes.toString('utf8');
    const output = rewriteReferences(text, path, assets);
    if (output !== text) rewritten.set(path, output);
  }
  for (const [path, text] of rewritten) await writeFile(join(root, path), text);
  for (const [source, destination] of assets)
    await rename(join(root, source), join(root, destination));

  return {
    snapshotSha256,
    renamedAssets: assets.size,
    rewrittenFiles: rewritten.size,
    assets: [...assets].map(([from, to]) => ({ from, to })),
  };
}
