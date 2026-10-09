import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const experiment = dirname(fileURLToPath(import.meta.url));
export const artifactRoot = resolve(experiment, '../../../artifacts/workers');
const mime = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.html': 'text/html',
};

export async function startHarness({
  port = 0,
  site = resolve(artifactRoot, 'site'),
  persist = false,
  statePath = resolve(artifactRoot, 'state'),
  workerPath = resolve(artifactRoot, 'worker.mjs'),
  bindings = {},
} = {}) {
  await mkdir(artifactRoot, { recursive: true });
  await build({
    entryPoints: [resolve(experiment, 'worker.mjs')],
    outfile: workerPath,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['cloudflare:workers', 'node:*'],
    minify: false,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const workerBytes = await readFile(workerPath);
  let profile = 'runtime-not-built';
  try {
    profile = await readFile(resolve(site, 'runtime-manifest.json'), 'utf8');
  } catch {}
  let contract = {};
  try {
    contract = JSON.parse(profile);
  } catch {}
  const profileDigest = createHash('sha256').update(profile).update(workerBytes).digest('hex');
  const staticFetch = async (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    let file = resolve(site, '.' + pathname);
    if (!file.startsWith(site + '/')) file = resolve(site, 'index.html');
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
    } catch {
      if (pathname.startsWith('/_runtime/') || extname(pathname))
        return new Response('Not found', { status: 404 });
      file = resolve(site, 'index.html');
    }
    try {
      return new Response(await readFile(file), {
        headers: {
          'content-type': mime[extname(file)] || 'application/octet-stream',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('Build the runtime first: node build-runtime.mjs', { status: 503 });
    }
  };
  const options = convertV4MiniflareOptions({
    name: 'slidev-workers-poc',
    modules: true,
    modulesRoot: artifactRoot,
    scriptPath: workerPath,
    host: '127.0.0.1',
    port,
    compatibilityDate: '2026-10-09',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      LOCAL_MUTATIONS: 'true',
      PROFILE_DIGEST: profileDigest,
      PROFILE_THEME: contract.theme?.name || '@slidev/theme-default',
      PROFILE_LAYOUTS: JSON.stringify(contract.layouts || ['cover', 'default', 'section']),
      PROFILE_COMPONENTS: JSON.stringify(contract.components || ['FigureGrid']),
      ...bindings,
    },
    r2Buckets: ['FILES'],
    durableObjects: { VERSIONS: { className: 'DeckVersions', useSQLite: true } },
    serviceBindings: { STATIC: staticFetch },
    cf: false,
  });
  if (persist) options.resourcePersistencePath = statePath;
  options.telemetry = { enabled: false };
  const mf = new Miniflare(options);
  const origin = (await mf.ready).origin;
  return { mf, origin, profileDigest, workerBytes: workerBytes.length };
}
