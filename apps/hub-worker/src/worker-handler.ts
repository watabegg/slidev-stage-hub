import { readCatalogPage, readLegacyCatalogPage, isDeckId } from './catalog.ts';
import { errorResponse, WorkerError } from './errors.ts';
import { isReleaseManifest, type ReleaseManifest } from './manifest.ts';
import { readNativePlayerDocument } from './native-player.ts';
import { publishDeck } from './publish.ts';
import {
  MAX_PUBLISH_BODY_BYTES,
  MAX_THUMBNAIL_BODY_BYTES,
  readBoundedBody,
  readJson,
} from './storage.ts';
import { captureThumbnail, ThumbnailError, validatePng } from './thumbnail.ts';
import type { WorkerEnv } from './types.ts';

const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const THUMBNAIL_PLACEHOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><rect width="1200" height="675" fill="#20242b"/><path d="M475 390h250l-125-155z" fill="#727b88"/><circle cx="525" cy="280" r="25" fill="#727b88"/><text x="600" y="455" fill="#c7cbd2" font-family="sans-serif" font-size="24" text-anchor="middle">Thumbnail unavailable</text></svg>';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

export async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
  try {
    return await routeRequest(request, env);
  } catch (error) {
    return errorResponse(error);
  }
}

async function routeRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/catalog.json') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return json(await readCatalogPage(env, url));
  }
  if (url.pathname === '/native-player.json') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return json(await readNativePlayerDocument(env));
  }
  if (url.pathname === '/api/catalog') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return json(await readLegacyCatalogPage(env, url));
  }
  if (url.pathname === '/thumbnail-placeholder.svg') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    return new Response(request.method === 'HEAD' ? null : THUMBNAIL_PLACEHOLDER, {
      headers: {
        'cache-control': 'public, max-age=3600',
        'content-type': 'image/svg+xml; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  const deckRoute = url.pathname.match(/^\/api\/decks\/(.+)$/u);
  if (deckRoute) return handleDeckRoute(request, url, env, deckRoute[1]);

  const thumbnailPrefix = '/api/thumbnail/';
  if (url.pathname.startsWith(thumbnailPrefix)) {
    return handleThumbnailRoute(request, url, env, url.pathname.slice(thumbnailPrefix.length));
  }

  if (url.pathname.startsWith('/releases/') && request.method === 'GET') {
    return readRelease(request, env, url.pathname.slice(1));
  }

  try {
    return await env.STATIC.fetch(request);
  } catch {
    throw new WorkerError(502, 'worker', 'Static content is unavailable');
  }
}

async function handleDeckRoute(
  request: Request,
  url: URL,
  env: WorkerEnv,
  encodedId: string,
): Promise<Response> {
  const id = decodeId(encodedId);
  if (!isDeckId(id)) throw new WorkerError(400, 'request', 'Invalid deck id');

  if (request.method === 'GET') {
    const manifest = await fetchManifest(env, id, url.searchParams.get('revision') ?? undefined);
    return manifest ? json(manifest) : json({ error: 'Deck not found' }, 404);
  }
  if (request.method !== 'POST') return methodNotAllowed('GET, POST');

  await verifyMutationAuthorization(request, env);
  const input = await readJsonRequest(request, MAX_PUBLISH_BODY_BYTES);
  const result = await publishDeck(env, id, input);
  return json(
    { ...result.manifest, published: result.published, cached: result.cached },
    result.published ? 200 : 409,
  );
}

async function handleThumbnailRoute(request: Request, url: URL, env: WorkerEnv, encodedId: string) {
  if (request.method !== 'POST' && request.method !== 'PUT') {
    return methodNotAllowed('POST, PUT');
  }
  await verifyMutationAuthorization(request, env);
  const id = decodeId(encodedId);
  if (!isDeckId(id)) throw new WorkerError(400, 'request', 'Invalid deck id');

  const manifest = await fetchManifest(env, id, url.searchParams.get('revision') ?? undefined);
  if (!manifest) return json({ error: 'Deck not found' }, 404);
  const key = `releases/${id}/${manifest.revision}/thumbnail.png`;
  try {
    if (await env.FILES.head(key)) return json({ status: 'cached', src: `/${key}` });
  } catch {
    throw new WorkerError(500, 'storage', 'Could not read thumbnail metadata');
  }

  if (request.method === 'PUT') {
    const bytes = await readBoundedBody(request, MAX_THUMBNAIL_BODY_BYTES);
    try {
      validatePng(bytes);
    } catch (error) {
      if (error instanceof ThumbnailError) {
        throw new WorkerError(400, 'thumbnail', 'Uploaded thumbnail is not a valid 1200×675 PNG');
      }
      throw error;
    }
    try {
      await env.FILES.put(key, bytes, {
        httpMetadata: { contentType: 'image/png' },
        onlyIf: { etagDoesNotMatch: '*' },
      });
    } catch {
      throw new WorkerError(500, 'storage', 'Could not store the thumbnail');
    }
    return json({ status: 'uploaded', src: `/${key}` });
  }

  if (!env.BROWSER) {
    return json(
      {
        status: 'unavailable',
        reason: 'Browser Run is not bound; use the local thumbnail uploader.',
      },
      503,
    );
  }
  const target = new URL(`/${id}/1`, request.url);
  target.searchParams.set('revision', manifest.revision);
  target.searchParams.set('embedded', 'true');
  target.searchParams.set('labThumbnail', 'true');
  try {
    const thumbnail = await captureThumbnail({ browser: env.BROWSER, url: target.href });
    await env.FILES.put(key, thumbnail.bytes, {
      httpMetadata: { contentType: 'image/png' },
    });
    return json({ status: 'created', src: `/${key}`, usedMs: thumbnail.usedMs });
  } catch (error) {
    if (error instanceof ThumbnailError) {
      const status = error.code === 'BROWSER_FAILED' ? 502 : 503;
      throw new WorkerError(
        status,
        'thumbnail',
        error.code === 'BROWSER_LIMIT'
          ? 'Browser Run rate limit was reached'
          : error.code === 'BROWSER_UNAVAILABLE'
            ? 'Browser Run is unavailable'
            : 'Browser Run screenshot failed',
      );
    }
    throw new WorkerError(500, 'storage', 'Could not store the thumbnail');
  }
}

async function fetchManifest(
  env: WorkerEnv,
  id: string,
  revision: string | undefined,
): Promise<ReleaseManifest | null> {
  if (revision !== undefined) {
    if (!REVISION_PATTERN.test(revision)) return null;
    const value = await readJson(env.FILES, `releases/${id}/${revision}/manifest.json`);
    if (value === null) return null;
    return requireManifest(value, id, revision, 'storage');
  }

  let current: unknown | null;
  try {
    current = await env.VERSIONS.getByName(id).current();
  } catch {
    throw new WorkerError(500, 'commit', 'Could not read the current publication');
  }
  return current === null ? null : requireManifest(current, id, undefined, 'commit');
}

function requireManifest(
  value: unknown,
  id: string,
  revision: string | undefined,
  phase: 'storage' | 'commit',
): ReleaseManifest {
  if (
    !isReleaseManifest(value) ||
    value.id !== id ||
    (revision !== undefined && value.revision !== revision) ||
    !REVISION_PATTERN.test(value.revision)
  ) {
    throw new WorkerError(500, phase, 'Publication metadata is invalid');
  }
  return value;
}

async function readRelease(request: Request, env: WorkerEnv, key: string): Promise<Response> {
  let object: R2ObjectBody | null;
  try {
    object = await env.FILES.get(key);
  } catch {
    throw new WorkerError(500, 'storage', 'Could not read release data');
  }
  if (!object) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const headers = new Headers({
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

async function verifyMutationAuthorization(request: Request, env: WorkerEnv): Promise<void> {
  if (!env.PUBLISH_TOKEN) {
    const hostname = new URL(request.url).hostname;
    if (
      String(env.LOCAL_MUTATIONS) === 'true' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
    ) {
      return;
    }
    throw new WorkerError(403, 'auth', 'Publishing API disabled');
  }

  const supplied = request.headers.get('authorization')?.match(/^Bearer (.+)$/iu)?.[1];
  if (!supplied || supplied.length > 512) {
    throw new WorkerError(401, 'auth', 'Authentication required');
  }
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(env.PUBLISH_TOKEN)),
  ]);
  if (!constantTimeEqual(new Uint8Array(actual), new Uint8Array(expected))) {
    throw new WorkerError(401, 'auth', 'Authentication required');
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function readJsonRequest(request: Request, limit: number): Promise<unknown> {
  const bytes = await readBoundedBody(request, limit);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new WorkerError(400, 'request', 'Request body must be valid JSON');
  }
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new WorkerError(400, 'request', 'Invalid deck id');
  }
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: 'Method not allowed', phase: 'request' },
    { status: 405, headers: { allow, 'cache-control': 'no-store' } },
  );
}
