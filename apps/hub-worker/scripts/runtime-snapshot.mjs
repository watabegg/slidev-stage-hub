import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';

const sourceExtensions = new Set([
  '.jsx',
  '.md',
  '.mdx',
  '.sass',
  '.scss',
  '.sh',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);
const privateSegments = new Set([
  '.git',
  '_private',
  'node_modules',
  'private',
  'src',
  'source',
  'sources',
]);
const mimeTypes = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const requiredFiles = ['index.html', '_runtime/bridge.js', '_runtime/vue.js'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function excludedPath(path) {
  const segments = path.split('/');
  if (
    segments.some((segment) => privateSegments.has(segment.toLowerCase())) ||
    segments[0] === 'runtimes' ||
    path === 'runtime-manifest.json' ||
    path.endsWith('.map')
  )
    return true;
  return sourceExtensions.has(extname(path).toLowerCase());
}

async function listPublicFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path).split(sep).join('/');
    if (excludedPath(relativePath)) continue;
    if (entry.isDirectory()) files.push(...(await listPublicFiles(root, path)));
    else if (entry.isFile()) files.push({ path, relativePath });
  }
  return files;
}

function withRuntimeBase(html, id) {
  const head = /<head\b[^>]*>/iu.exec(html);
  if (!head) throw new Error('Built runtime index.html has no head element');
  const withoutBase = html.replace(/<base\b[^>]*>/giu, '');
  const updatedHead = /<head\b[^>]*>/iu.exec(withoutBase);
  if (!updatedHead) throw new Error('Built runtime index.html has no head element');
  const end = updatedHead.index + updatedHead[0].length;
  return `${withoutBase.slice(0, end)}<base href="/runtimes/${id}/">${withoutBase.slice(end)}`;
}

async function writeImmutable(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error(`Runtime snapshot collision at ${path}`);
  }
}

/** Copy a built site into an immutable, versioned browser runtime archive. */
export async function snapshotRuntime({ siteRoot, id }) {
  if (!/^[a-f0-9]{64}$/u.test(id))
    throw new TypeError('Runtime id must be a lowercase SHA-256 digest');
  const sourceFiles = await listPublicFiles(siteRoot);
  const paths = new Set(sourceFiles.map(({ relativePath }) => relativePath));
  for (const path of requiredFiles) {
    if (!paths.has(path)) throw new Error(`Built runtime is missing ${path}`);
  }

  const destinationRoot = join(siteRoot, 'runtimes', id);
  const copiedFiles = [];
  for (const source of sourceFiles) {
    let bytes = await readFile(source.path);
    if (source.relativePath === 'index.html')
      bytes = Buffer.from(withRuntimeBase(bytes.toString('utf8'), id));
    const destination = join(destinationRoot, ...source.relativePath.split('/'));
    await writeImmutable(destination, bytes);
    copiedFiles.push({
      path: source.relativePath,
      sha256: sha256(bytes),
      size: bytes.byteLength,
      contentType:
        mimeTypes[extname(source.relativePath).toLowerCase()] ?? 'application/octet-stream',
    });
  }
  copiedFiles.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { schemaVersion: 1, id, files: copiedFiles };
}
