import { validatePlayerDocument } from '@slidev-stage-hub/protocol/contracts';
const MANIFEST_PATH = '/native-player.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export function normalizeOrigin(input) {
  if (typeof input !== 'string' || input.length === 0)
    throw new Error('provide a root URL, for example https://slides.example.com');
  // oxlint-disable-next-line no-control-regex -- Reject control characters at the URL/path boundary.
  if (input.trim() !== input || /[\\\s\u0000-\u001f\u007f]/.test(input))
    throw new Error('URL must not contain whitespace or control characters');
  const parts = /^([A-Za-z][A-Za-z\d+.-]*):\/\/([^/?#]*)(.*)$/s.exec(input);
  if (!parts) throw new Error('URL must be an absolute HTTPS or HTTP loopback origin');
  const [, , authority, tail] = parts;
  if (tail !== '' && tail !== '/')
    throw new Error(
      'URL must contain only the origin and optional trailing slash; paths, queries, and fragments are not allowed',
    );
  if (authority.includes('@')) throw new Error('URL credentials are not allowed');

  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error(`invalid URL: ${error.message}`, { cause: error });
  }
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('URL scheme must be HTTPS, or HTTP on localhost/127.0.0.1/[::1]');
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('URL must be a root origin with no path, query, or fragment');

  if (url.protocol === 'http:') {
    const literalHost = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1).toLowerCase()
      : authority.split(':', 1)[0].toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]'].includes(literalHost))
      throw new Error(
        'HTTP is allowed only for localhost, 127.0.0.1, or [::1]; use HTTPS for other hosts',
      );
  }
  return url.origin;
}

export { validatePlayerDocument };

async function readBoundedBody(response, endpoint) {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_MANIFEST_BYTES
  ) {
    await response.body?.cancel().catch(() => {});
    throw new ManifestBodyError(`${endpoint} exceeds the 1 MiB manifest limit`);
  }
  if (!response.body) throw new ManifestBodyError(`${endpoint} returned an empty response body`);

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        throw new ManifestBodyError(`${endpoint} exceeds the 1 MiB manifest limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength);
}

class ManifestBodyError extends Error {}

function makeRequestHeaders(authHeaders) {
  const headers = { accept: 'application/json' };
  for (const name of Object.keys(authHeaders ?? {})) {
    const normalizedName = name.toLowerCase();
    const previousName = Object.keys(headers).find((key) => key.toLowerCase() === normalizedName);
    if (previousName) delete headers[previousName];
    Object.defineProperty(headers, name, {
      value: authHeaders[name],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return headers;
}

export async function fetchPlayerDocument(
  origin,
  { fetchImpl = globalThis.fetch, requestHeaders } = {},
) {
  const endpoint = `${normalizeOrigin(origin)}${MANIFEST_PATH}`;
  const hasAuthHeaders = Object.keys(requestHeaders ?? {}).length > 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: makeRequestHeaders(requestHeaders),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const message = `timed out fetching ${endpoint} after ${FETCH_TIMEOUT_MS / 1000} seconds`;
        throw hasAuthHeaders ? new Error(message) : new Error(message, { cause: error });
      }
      if (hasAuthHeaders)
        throw new Error(
          `could not fetch ${endpoint}: request failed with configured authentication headers`,
        );
      const detail = error.cause?.message
        ? `${error.message} (${error.cause.message})`
        : error.message;
      throw new Error(`could not fetch ${endpoint}: ${detail}`, { cause: error });
    }
    if (response.status >= 300 && response.status < 400)
      throw new Error(
        `${endpoint} redirected (HTTP ${response.status}); redirects are not followed`,
      );
    if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`);

    let bytes;
    try {
      bytes = await readBoundedBody(response, endpoint);
    } catch (error) {
      if (controller.signal.aborted) {
        const message = `timed out reading ${endpoint} after ${FETCH_TIMEOUT_MS / 1000} seconds`;
        throw hasAuthHeaders ? new Error(message) : new Error(message, { cause: error });
      }
      if (hasAuthHeaders && !(error instanceof ManifestBodyError))
        throw new Error(`${endpoint} response body could not be read`);
      throw error;
    }
    let document;
    try {
      document = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error(`${endpoint} did not return valid JSON`);
    }
    return validatePlayerDocument(document);
  } finally {
    clearTimeout(timeout);
  }
}
