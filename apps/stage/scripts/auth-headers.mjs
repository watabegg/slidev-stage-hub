import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_AUTH_FILE_BYTES = 64 * 1024;
const MAX_HEADER_COUNT = 64;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function hasDuplicateJsonKeys(source) {
  const containers = [];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === '"') break;
        index += 1;
      }

      const end = Math.min(index + 1, source.length);
      let next = end;
      while (/\s/.test(source[next] ?? '')) next += 1;
      if (source[next] === ':') {
        const container = containers.at(-1);
        if (container?.kind === 'object') {
          const key = JSON.parse(source.slice(start, end));
          if (container.keys.has(key)) return true;
          container.keys.add(key);
        }
      }
      index = end - 1;
      continue;
    }

    if (character === '{') containers.push({ kind: 'object', keys: new Set() });
    else if (character === '[') containers.push({ kind: 'array' });
    else if (character === '}' || character === ']') containers.pop();
  }

  return false;
}

async function readFileBounded(fileHandle) {
  const chunks = [];
  let total = 0;

  while (total <= MAX_AUTH_FILE_BYTES) {
    const buffer = Buffer.alloc(Math.min(8192, MAX_AUTH_FILE_BYTES + 1 - total));
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > MAX_AUTH_FILE_BYTES)
      throw new Error('authentication header file exceeds the 64 KiB limit');
  }

  return Buffer.concat(chunks, total);
}

function validateHeaderDocument(document, expectedOrigin, normalizeOrigin) {
  if (document === null || typeof document !== 'object' || Array.isArray(document))
    throw new Error('authentication header file must contain a JSON object');

  const documentKeys = Object.keys(document);
  if (documentKeys.length !== 2 || !Object.hasOwn(document, 'origin') || !Object.hasOwn(document, 'headers'))
    throw new Error('authentication header file must contain only origin and headers');
  if (typeof document.origin !== 'string')
    throw new Error('authentication header file origin must exactly match the normalized target origin');
  let normalizedFileOrigin;
  try {
    normalizedFileOrigin = normalizeOrigin(document.origin);
  } catch {
    throw new Error('authentication header file origin must be a valid root origin');
  }
  if (normalizedFileOrigin !== expectedOrigin)
    throw new Error('authentication header file origin must exactly match the normalized target origin');

  const sourceHeaders = document.headers;
  if (sourceHeaders === null || typeof sourceHeaders !== 'object' || Array.isArray(sourceHeaders))
    throw new Error('authentication header file headers must be an object');

  const names = Object.keys(sourceHeaders);
  if (names.length === 0) throw new Error('authentication header file headers must not be empty');
  if (names.length > MAX_HEADER_COUNT)
    throw new Error('authentication header file may contain at most 64 headers');

  const seenNames = new Set();
  const headers = Object.create(null);
  for (const name of names) {
    const normalizedName = name.toLowerCase();
    if (!HEADER_NAME.test(name))
      throw new Error('authentication header names must be valid HTTP tokens');
    if (seenNames.has(normalizedName))
      throw new Error('authentication header names must be unique case-insensitively');
    seenNames.add(normalizedName);

    if (FORBIDDEN_HEADERS.has(normalizedName)
      || normalizedName.startsWith('proxy-')
      || normalizedName.startsWith('sec-')) {
      throw new Error('authentication header file contains a forbidden header name');
    }

    const value = sourceHeaders[name];
    if (typeof value !== 'string' || value.length === 0 || /[^\x20-\x7e]/.test(value))
      throw new Error('authentication header values must be non-empty printable ASCII');
    Object.defineProperty(headers, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return headers;
}

export async function readAuthHeadersFile(headersFile, expectedOrigin, normalizeOrigin) {
  if (typeof headersFile !== 'string' || headersFile.length === 0)
    throw new Error('--headers-file requires a non-empty path');
  if (typeof expectedOrigin !== 'string' || expectedOrigin.length === 0)
    throw new Error('a normalized target origin is required to read authentication headers');
  if (typeof normalizeOrigin !== 'function')
    throw new Error('origin validation is required to read authentication headers');

  const absolutePath = path.resolve(headersFile);
  let pathStat;
  try {
    pathStat = await fs.lstat(absolutePath);
  } catch (error) {
    throw new Error(`could not inspect authentication header file ${absolutePath} (${error.code ?? 'I/O error'})`);
  }
  if (!pathStat.isFile()) throw new Error('authentication header file must be a regular file');
  if (process.platform !== 'win32' && (pathStat.mode & 0o077) !== 0)
    throw new Error('authentication header file must not grant group or other permissions');

  const unixFlags = process.platform === 'win32'
    ? 0
    : (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let fileHandle;
  try {
    fileHandle = await fs.open(absolutePath, fsConstants.O_RDONLY | unixFlags);
  } catch (error) {
    throw new Error(`could not open authentication header file ${absolutePath} (${error.code ?? 'I/O error'})`);
  }

  let bytes;
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile()) throw new Error('authentication header file must be a regular file');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      throw new Error('authentication header file must not grant group or other permissions');
    if (stat.size > MAX_AUTH_FILE_BYTES)
      throw new Error('authentication header file exceeds the 64 KiB limit');
    bytes = await readFileBounded(fileHandle);
  } finally {
    await fileHandle.close();
  }

  let source;
  let document;
  try {
    source = bytes.toString('utf8');
    document = JSON.parse(source);
  } catch {
    throw new Error('authentication header file must contain valid JSON');
  }
  if (hasDuplicateJsonKeys(source))
    throw new Error('authentication header file must not contain duplicate JSON keys');

  return {
    absolutePath,
    headers: validateHeaderDocument(document, expectedOrigin, normalizeOrigin),
  };
}
