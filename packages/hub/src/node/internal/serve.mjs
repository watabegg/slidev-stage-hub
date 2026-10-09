import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const DEFAULT_DECK_IDS = ['aaa/aaa1', 'aaa/aaa2', 'bbb/bbb1', 'bbb/bbb2'];
const MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.otf', 'font/otf'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validDeckId(id) {
  return (
    typeof id === 'string' &&
    id.split('/').every(
      (segment) =>
        segment &&
        segment !== '.' &&
        segment !== '..' &&
        // oxlint-disable-next-line no-control-regex -- Reject control characters at the URL/path boundary.
        !/[\u0000-\u001f\u007f\\:?#[\]@!$&'()*+,;=%]/u.test(segment),
    )
  );
}

function readDeckIds(root) {
  const manifestPath = resolve(root, 'manifest.json');
  if (!existsSync(manifestPath)) return new Set(DEFAULT_DECK_IDS);
  const ids = new Set();
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(manifest.decks)) {
      for (const deck of manifest.decks) if (validDeckId(deck?.id)) ids.add(deck.id);
    }
  } catch (error) {
    throw new Error(`invalid manifest.json: ${error.message}`);
  }
  return ids;
}

function parsePath(rawUrl) {
  const rawPath = (rawUrl || '/').split('?', 1)[0];
  if (!rawPath.startsWith('/')) return null;
  const rawSegments = rawPath.slice(1).split('/');
  if (rawSegments.at(-1) === '') rawSegments.pop();
  const segments = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment === '') return null;
    let segment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (!segment || segment === '.' || segment === '..' || /[\\/\0]/.test(segment)) return null;
    segments.push(segment);
  }
  return segments;
}

function isDeckRouteSuffix(segments) {
  if (segments.length === 0) return true;
  if (segments.length === 2) return segments[0] === 'presenter' && /^\d+$/.test(segments[1]);
  if (segments.length !== 1) return false;
  return (
    /^\d+$/.test(segments[0]) ||
    ['presenter', 'overview', 'notes', 'draw', 'record'].includes(segments[0])
  );
}

function resolveFile(root, segments) {
  let candidate = resolve(root, ...segments);
  if (!isInside(root, candidate)) return null;
  try {
    if (statSync(candidate).isDirectory()) candidate = resolve(candidate, 'index.html');
    const realPath = realpathSync(candidate);
    if (!isInside(root, realPath) || !statSync(realPath).isFile()) return null;
    return realPath;
  } catch {
    return null;
  }
}

function routeEntry(root, segments, deckIds) {
  if (segments.length === 0) return resolveFile(root, ['index.html']);
  for (const deckId of deckIds) {
    const idSegments = deckId.split('/');
    if (
      idSegments.length > segments.length ||
      !idSegments.every((segment, index) => segment === segments[index])
    )
      continue;
    const suffix = segments.slice(idSegments.length);
    if (!isDeckRouteSuffix(suffix)) continue;
    const deckIndex = resolveFile(root, [...idSegments, 'index.html']);
    return deckIndex ?? resolveFile(root, ['index.html']);
  }
  return null;
}

function cacheControlFor(filePath) {
  if (extname(filePath).toLowerCase() === '.html') return 'no-cache, max-age=0, must-revalidate';
  if (filePath.endsWith('/manifest.json')) return 'no-cache, max-age=0, must-revalidate';
  const filename = filePath.split(sep).at(-1);
  if (/[.-][A-Za-z0-9_-]{8,}(?=\.)/.test(filename)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate';
}

function sendNotFound(response) {
  response.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end('Not Found\n');
}

export function createServer(siteRoot) {
  if (!isAbsolute(siteRoot)) throw new Error('site root must be an absolute path');
  const root = realpathSync(resolve(siteRoot));
  const deckIds = readDeckIds(root);

  return createHttpServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      response.end('Method Not Allowed\n');
      return;
    }

    const segments = parsePath(request.url);
    if (!segments) {
      sendNotFound(response);
      return;
    }

    const filePath = resolveFile(root, segments) ?? routeEntry(root, segments, deckIds);
    if (!filePath) {
      sendNotFound(response);
      return;
    }

    try {
      const info = statSync(filePath);
      response.writeHead(200, {
        'content-type':
          MIME_TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
        'content-length': info.size,
        'last-modified': info.mtime.toUTCString(),
        'cache-control': cacheControlFor(filePath),
        'x-content-type-options': 'nosniff',
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(filePath).pipe(response);
    } catch {
      sendNotFound(response);
    }
  });
}
