import { handlePublicationJobRequest } from './jobs/service.js';
import { readCatalogPage, readLegacyCatalogPage, isDeckId } from './catalog.js';
import { errorResponse, WorkerError } from './errors.js';
import { isReleaseManifest, type ReleaseManifest } from './manifest.js';
import { readNativePlayerDocument } from './native-player.js';
import { publishDeck } from './publish.js';
import {
  MAX_PUBLISH_BODY_BYTES,
  MAX_THUMBNAIL_BODY_BYTES,
  readBoundedBody,
  readJson,
} from './storage.js';
import { ThumbnailError, validatePng, captureAndStoreThumbnail } from './thumbnail.js';
import type { ArtifactObject, HubServerOptions } from './ports.js';
import { readRuntimeFile } from './runtime.js';

const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const THUMBNAIL_PLACEHOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><rect width="1200" height="675" fill="#20242b"/><path d="M475 390h250l-125-155z" fill="#727b88"/><circle cx="525" cy="280" r="25" fill="#727b88"/><text x="600" y="455" fill="#c7cbd2" font-family="sans-serif" font-size="24" text-anchor="middle">Thumbnail unavailable</text></svg>';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

export async function handleRequest(request: Request, env: HubServerOptions): Promise<Response> {
  try {
    return await routeRequest(request, env);
  } catch (error) {
    return errorResponse(error);
  }
}

async function routeRequest(request: Request, env: HubServerOptions): Promise<Response> {
  const url = new URL(request.url);
  const jobResponse = await handlePublicationJobRequest(request, env, () =>
    verifyMutationAuthorization(request, env),
  );
  if (jobResponse) return jobResponse;
  if (url.pathname === '/_hub/jobs') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const entry = new URL(request.url);
    entry.pathname = '/jobs.html';
    entry.search = '';
    const response = await fetchStaticContent(new Request(entry, request), env);
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    headers.set('referrer-policy', 'no-referrer');
    headers.set('x-content-type-options', 'nosniff');
    if (request.method === 'HEAD') await response.body?.cancel();
    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers,
    });
  }

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

  const documentRoute = url.pathname.match(/^\/(.+)\/([1-9][0-9]*)\/?$/u);
  if (documentRoute && (request.method === 'GET' || request.method === 'HEAD')) {
    const id = decodeId(documentRoute[1]);
    const page = Number(documentRoute[2]);
    if (isDeckId(id) && Number.isSafeInteger(page)) {
      const manifest = await fetchManifest(env, id, url.searchParams.get('revision') ?? undefined);
      if (!manifest || !manifest.slides.some((slide) => slide.no === page)) {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      if (manifest.runtimeId !== undefined) {
        const object = await readRuntimeFile(env.artifacts, manifest.runtimeId, 'index.html');
        if (!object) throw new WorkerError(503, 'storage', 'Pinned runtime is unavailable');
        const html = await new Response(object.body).text();
        if (!/<head(?:\s[^>]*)?>/iu.test(html))
          throw new WorkerError(503, 'storage', 'Pinned runtime is unavailable');
        const body = html.replace(
          /(<head(?:\s[^>]*)?>)/iu,
          `$1<meta name="hub-revision" content="${manifest.revision}">`,
        );
        return new Response(request.method === 'HEAD' ? null : body, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }
      // Deck category names may match provider-reserved directories. Serve the
      // verified document through its public entrypoint while retaining the URL
      // and revision query that the browser's runtime uses to select the deck.
      const entryUrl = new URL(request.url);
      entryUrl.pathname = '/index.html';
      let response = await fetchStaticContent(new Request(entryUrl, request), env);
      if (
        response.ok &&
        response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'text/html'
      ) {
        const headers = new Headers(response.headers);
        headers.set('cache-control', 'no-store');
        headers.delete('content-length');
        headers.delete('etag');
        const html = request.method === 'HEAD' ? '' : await response.text();
        const base = /<base(?:\s|>)/iu.test(html) ? '' : '<base href="/">';
        const body = html.replace(
          /(<head(?:\s[^>]*)?>)/iu,
          `$1${base}<meta name="hub-revision" content="${manifest.revision}">`,
        );
        if (request.method === 'HEAD') await response.body?.cancel();
        response = new Response(request.method === 'HEAD' ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      if (request.method === 'HEAD') {
        await response.body?.cancel();
        return new Response(null, response);
      }
      return response;
    }
  }

  if (url.pathname === '/runtimes' || url.pathname.startsWith('/runtimes/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const match = /^\/runtimes\/([a-f0-9]{64})\/(.+)$/u.exec(url.pathname);
    const object = match ? await readRuntimeFile(env.artifacts, match[1], match[2]) : null;
    if (!object)
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    const headers = new Headers({
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    if (object.contentType) headers.set('content-type', object.contentType);
    if (object.etag) headers.set('etag', object.etag);
    if (request.method === 'HEAD') await object.body.cancel();
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  }

  if (url.pathname.startsWith('/releases/') && request.method === 'GET') {
    return readRelease(request, env, url.pathname.slice(1));
  }

  if (
    ['/api', '/releases', '/private', '/index'].some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )
  ) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  return fetchStaticContent(request, env);
}

async function fetchStaticContent(request: Request, env: HubServerOptions): Promise<Response> {
  const url = new URL(request.url);
  try {
    const response = await env.staticAssets.fetch(request);
    if (
      /\.(?:[cm]?js|css|json|map|wasm|png|jpe?g|svg|webp|ico|woff2?|ttf)$/iu.test(url.pathname) &&
      response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'text/html'
    ) {
      await response.body?.cancel();
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    return response;
  } catch {
    throw new WorkerError(502, 'worker', 'Static content is unavailable');
  }
}

async function handleDeckRoute(
  request: Request,
  url: URL,
  env: HubServerOptions,
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

async function handleThumbnailRoute(
  request: Request,
  url: URL,
  env: HubServerOptions,
  encodedId: string,
) {
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
    if (await env.artifacts.head(key)) return json({ status: 'cached', src: `/${key}` });
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
      await env.artifacts.put(key, bytes, {
        contentType: 'image/png',
        ifAbsent: true,
      });
    } catch {
      throw new WorkerError(500, 'storage', 'Could not store the thumbnail');
    }
    return json({ status: 'uploaded', src: `/${key}` });
  }

  if (!env.renderThumbnail) {
    return json(
      {
        status: 'unavailable',
        reason: 'Browser Run is not bound; use the local thumbnail uploader.',
      },
      503,
    );
  }
  try {
    const thumbnail = await captureAndStoreThumbnail(
      env,
      id,
      manifest.revision,
      new URL(request.url).origin,
    );
    return json({ status: thumbnail.status, src: thumbnail.src, usedMs: thumbnail.usedMs });
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
  env: HubServerOptions,
  id: string,
  revision: string | undefined,
): Promise<ReleaseManifest | null> {
  if (revision !== undefined) {
    if (!REVISION_PATTERN.test(revision)) return null;
    const value = await readJson(env.artifacts, `releases/${id}/${revision}/manifest.json`);
    if (value === null) return null;
    return requireManifest(value, id, revision, 'storage');
  }

  let current: unknown | null;
  try {
    current = await env.publications.current(id);
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

async function readRelease(
  request: Request,
  env: HubServerOptions,
  key: string,
): Promise<Response> {
  let object: ArtifactObject | null;
  try {
    object = await env.artifacts.get(key);
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
  if (object.contentType) headers.set('content-type', object.contentType);
  if (object.etag) headers.set('etag', object.etag);
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

async function verifyMutationAuthorization(request: Request, env: HubServerOptions): Promise<void> {
  if (!env.publishToken) {
    const hostname = new URL(request.url).hostname;
    if (
      env.allowLocalMutations === true &&
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
    crypto.subtle.digest('SHA-256', encoder.encode(env.publishToken)),
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
