#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readAuthHeadersFile } from './auth-headers.mjs';

const nativeAppRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultArtifactsRoot = path.join(nativeAppRoot, 'artifacts');
const defaultConfigPath = path.join(defaultArtifactsRoot, 'local-config.json');
const MANIFEST_PATH = '/native-player.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNativeDeckId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(id);
}

export function normalizeOrigin(input) {
  if (typeof input !== 'string' || input.length === 0)
    throw new Error('provide a root URL, for example https://slides.example.com');
  if (input.trim() !== input || /[\\\s\u0000-\u001f\u007f]/.test(input))
    throw new Error('URL must not contain whitespace or control characters');
  const parts = /^([A-Za-z][A-Za-z\d+.-]*):\/\/([^/?#]*)(.*)$/s.exec(input);
  if (!parts) throw new Error('URL must be an absolute HTTPS or HTTP loopback origin');
  const [, , authority, tail] = parts;
  if (tail !== '' && tail !== '/')
    throw new Error('URL must contain only the origin and optional trailing slash; paths, queries, and fragments are not allowed');
  if (authority.includes('@')) throw new Error('URL credentials are not allowed');

  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new Error(`invalid URL: ${error.message}`, { cause: error });
  }
  if (url.username || url.password)
    throw new Error('URL credentials are not allowed');
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('URL scheme must be HTTPS, or HTTP on localhost/127.0.0.1/[::1]');
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('URL must be a root origin with no path, query, or fragment');

  if (url.protocol === 'http:') {
    const literalHost = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1).toLowerCase()
      : authority.split(':', 1)[0].toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]'].includes(literalHost))
      throw new Error('HTTP is allowed only for localhost, 127.0.0.1, or [::1]; use HTTPS for other hosts');
  }
  return url.origin;
}

function validateDeckId(id, label, seenIds) {
  if (!isNativeDeckId(id))
    throw new Error(`${label} id must use non-empty ASCII letters, numbers, underscores, or hyphens in slash-separated segments`);
  if (seenIds.has(id)) throw new Error(`duplicate deck id ${JSON.stringify(id)} in native-player.json`);
  seenIds.add(id);
}

export function validatePlayerDocument(document) {
  if (!isPlainObject(document)) throw new Error('native-player.json must contain a JSON object');
  if (document.schemaVersion !== 1) throw new Error('native-player.json schemaVersion must be 1');
  if (document.protocolVersion !== 1) throw new Error('native-player.json protocolVersion must be 1');
  if (!Array.isArray(document.decks)) throw new Error('native-player.json decks must be an array');
  if (!Array.isArray(document.unsupportedDecks))
    throw new Error('native-player.json unsupportedDecks must be an array');

  const seenIds = new Set();
  const decks = document.decks.map((deck, index) => {
    const label = `deck ${index + 1}`;
    if (!isPlainObject(deck)) throw new Error(`${label} must be an object`);
    validateDeckId(deck.id, label, seenIds);
    if (typeof deck.revision !== 'string' || deck.revision.trim().length === 0)
      throw new Error(`${label} ${deck.id} revision must be a non-empty string`);
    const expectedEntry = `/${deck.id}/1`;
    if (deck.entry !== expectedEntry)
      throw new Error(`${label} ${deck.id} entry must be exactly ${expectedEntry}`);
    if (!Array.isArray(deck.clickTotals) || deck.clickTotals.length === 0)
      throw new Error(`${label} ${deck.id} clickTotals must be a non-empty array`);
    for (const [pageIndex, total] of deck.clickTotals.entries()) {
      if (!Number.isSafeInteger(total) || total < 0 || total > 0xffff_ffff)
        throw new Error(`${label} ${deck.id} clickTotals[${pageIndex}] must be a safe non-negative u32 integer`);
    }
    return {
      id: deck.id,
      revision: deck.revision,
      entry: deck.entry,
      clickTotals: [...deck.clickTotals],
    };
  });
  if (decks.length === 0) throw new Error('native-player.json has no supported decks');

  const unsupportedDecks = document.unsupportedDecks.map((deck, index) => {
    const label = `unsupportedDecks[${index}]`;
    if (!isPlainObject(deck)) throw new Error(`${label} must be an object`);
    if (typeof deck.id !== 'string' || deck.id.length === 0)
      throw new Error(`${label} id must be a non-empty string`);
    if (seenIds.has(deck.id)) throw new Error(`duplicate deck id ${JSON.stringify(deck.id)} in native-player.json`);
    seenIds.add(deck.id);
    if (typeof deck.reason !== 'string')
      throw new Error(`${label} ${deck.id} reason must be a string`);
    return { id: deck.id, reason: deck.reason };
  });

  return { decks, unsupportedDecks };
}

async function readBoundedBody(response, endpoint) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_MANIFEST_BYTES) {
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
    const previousName = Object.keys(headers).find(key => key.toLowerCase() === normalizedName);
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

export async function fetchPlayerDocument(origin, { fetchImpl = globalThis.fetch, requestHeaders } = {}) {
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
        throw new Error(`could not fetch ${endpoint}: request failed with configured authentication headers`);
      const detail = error.cause?.message ? `${error.message} (${error.cause.message})` : error.message;
      throw new Error(`could not fetch ${endpoint}: ${detail}`, { cause: error });
    }
    if (response.status >= 300 && response.status < 400)
      throw new Error(`${endpoint} redirected (HTTP ${response.status}); redirects are not followed`);
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

export function makeLocalConfig({ decks, origin, artifactsRoot = defaultArtifactsRoot, authHeadersFile }) {
  const config = {
    decks,
    notes: {},
    approvedSourceRoot: path.resolve(artifactsRoot),
    viewerOrigin: normalizeOrigin(origin),
  };
  if (authHeadersFile !== undefined)
    config.authHeadersFile = path.resolve(authHeadersFile);
  return config;
}

export async function writeLocalConfig(config, configPath = defaultConfigPath) {
  const destination = path.resolve(configPath);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw new Error(`could not write native config ${destination}: ${error.message}`, { cause: error });
  }
}

export async function connect(baseUrl, options = {}) {
  const origin = normalizeOrigin(baseUrl);
  const auth = options.headersFile === undefined
    ? undefined
    : await readAuthHeadersFile(options.headersFile, origin, normalizeOrigin);
  const { decks, unsupportedDecks } = await fetchPlayerDocument(origin, {
    fetchImpl: options.fetchImpl,
    requestHeaders: auth?.headers,
  });
  const config = makeLocalConfig({
    decks,
    origin,
    artifactsRoot: options.artifactsRoot,
    authHeadersFile: auth?.absolutePath,
  });
  await writeLocalConfig(config, options.configPath);
  return { config, unsupportedDecks };
}

export function parseConnectArgs(argv) {
  const usage = 'usage: node apps/stage/scripts/connect.mjs <origin> [--headers-file <path>]';
  if (!Array.isArray(argv) || (argv.length !== 1 && argv.length !== 3))
    throw new Error(usage);
  if (argv.length === 3 && (argv[1] !== '--headers-file' || typeof argv[2] !== 'string' || argv[2].length === 0))
    throw new Error(usage);
  return {
    origin: argv[0],
    headersFile: argv.length === 3 ? argv[2] : undefined,
  };
}

async function main(argv = process.argv.slice(2)) {
  const { origin, headersFile } = parseConnectArgs(argv);
  const { config, unsupportedDecks } = await connect(origin, { headersFile });
  console.log(`Connected to ${config.viewerOrigin}; loaded ${config.decks.length} supported deck(s).`);
  for (const deck of unsupportedDecks)
    console.warn(`Skipped unsupported deck ${deck.id}: ${deck.reason}`);
  if (config.authHeadersFile)
    console.log(`Authentication header file: ${config.authHeadersFile}`);
  console.log(`Native config written to ${defaultConfigPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Connection failed: ${error.message}`);
    process.exitCode = 1;
  });
}
