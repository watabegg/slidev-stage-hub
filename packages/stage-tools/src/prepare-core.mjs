import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { inspectDeckSource } from '@slidev-stage-hub/slidev-adapter/inspect-deck';
import { loadSlidevParser as loadAdapterSlidevParser } from '@slidev-stage-hub/slidev-adapter/runtime';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function isSafeDeckId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  const segments = id.split('/');
  // The current Rust viewer cannot route percent-encoded path segments.
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      /^[A-Za-z0-9._~-]+$/.test(segment),
  );
}

function encodeDeckId(id) {
  return id.split('/').map(encodeURIComponent).join('/');
}

export function canonicalEntryForId(id) {
  if (!isSafeDeckId(id))
    throw new Error(
      `unsafe native deck id ${JSON.stringify(id)}; use nested ASCII letters, numbers, dot, underscore, tilde, or hyphen segments`,
    );
  return `/${encodeDeckId(id)}/1`;
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('public manifest must be an object');
  if (manifest.schemaVersion !== 1) throw new Error('public manifest schemaVersion must be 1');
  if (!Array.isArray(manifest.decks) || manifest.decks.length === 0)
    throw new Error('public manifest must contain a non-empty decks array');

  const seenIds = new Set();
  for (const [index, deck] of manifest.decks.entries()) {
    const label = `public manifest deck ${index + 1}`;
    if (!deck || typeof deck !== 'object' || Array.isArray(deck))
      throw new Error(`${label} must be an object`);
    if (!isSafeDeckId(deck.id))
      throw new Error(
        `${label} has an unsupported native id ${JSON.stringify(deck.id)}; use nested ASCII letters, numbers, dot, underscore, tilde, or hyphen segments`,
      );
    if (seenIds.has(deck.id))
      throw new Error(`public manifest contains duplicate deck id ${JSON.stringify(deck.id)}`);
    seenIds.add(deck.id);
    if (
      typeof deck.sourcePath !== 'string' ||
      deck.sourcePath.length === 0 ||
      deck.sourcePath.includes('\0')
    )
      throw new Error(`${label} must have a non-empty sourcePath`);
    if (!Number.isSafeInteger(deck.pages) || deck.pages <= 0)
      throw new Error(`${label} pages must be a positive integer`);
    if (typeof deck.revision !== 'string' || !/^[a-f\d]{64}$/i.test(deck.revision))
      throw new Error(`${label} revision must be a SHA-256 hex string`);
    const expectedEntry = canonicalEntryForId(deck.id);
    if (deck.entry !== expectedEntry)
      throw new Error(`${label} entry must be the canonical route ${expectedEntry}`);
  }

  return manifest;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbsolutePath(value) {
  return (
    typeof value === 'string' && value.length > 0 && !value.includes('\0') && path.isAbsolute(value)
  );
}

async function readSourceReceipt(site, receiptPath) {
  let bytes;
  try {
    bytes = await fs.readFile(receiptPath);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(`private source receipt is required but missing: ${receiptPath}`, {
        cause: error,
      });
    throw new Error(`cannot read private source receipt ${receiptPath}: ${error.message}`, {
      cause: error,
    });
  }

  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid private source receipt JSON at ${receiptPath}: ${error.message}`, {
      cause: error,
    });
  }
}

function mergeReceiptSources(manifest, receipt, site) {
  if (!isPlainObject(receipt)) throw new Error('private source receipt must be an object');
  if (receipt.schemaVersion !== 1)
    throw new Error('private source receipt schemaVersion must be 1');
  if (!isAbsolutePath(receipt.output) || receipt.output !== site)
    throw new Error('private source receipt output must match the resolved site path');
  // These fields describe the Hub build but do not authorize source access.
  if (!isAbsolutePath(receipt.sourceRoot))
    throw new Error('private source receipt sourceRoot must be an absolute path');
  if (!Array.isArray(receipt.decks))
    throw new Error('private source receipt decks must be an array');

  const receiptDecks = new Map();
  for (const [index, deck] of receipt.decks.entries()) {
    const label = `private source receipt deck ${index + 1}`;
    if (!isPlainObject(deck)) throw new Error(`${label} must be an object`);
    if (typeof deck.id !== 'string' || deck.id.length === 0)
      throw new Error(`${label} id must be a non-empty string`);
    if (receiptDecks.has(deck.id))
      throw new Error(
        `private source receipt contains duplicate deck id ${JSON.stringify(deck.id)}`,
      );
    if (typeof deck.revision !== 'string' || !/^[a-f\d]{64}$/i.test(deck.revision))
      throw new Error(`${label} revision must be a SHA-256 hex string`);
    if (!isAbsolutePath(deck.sourcePath))
      throw new Error(`${label} sourcePath must be a non-empty absolute path`);
    // Validate the recorded digest's shape only. Source edits are supported and
    // the approved fixtures root remains the authority for resolving sources.
    if (typeof deck.sourceRevision !== 'string' || !/^[a-f\d]{64}$/i.test(deck.sourceRevision))
      throw new Error(`${label} sourceRevision must be a SHA-256 hex string`);
    receiptDecks.set(deck.id, deck);
  }

  const matchedIds = new Set();
  const decks = manifest.decks.map((deck) => {
    if (typeof deck.id !== 'string' || deck.id.length === 0)
      throw new Error('public manifest deck id must be a non-empty string');
    if (matchedIds.has(deck.id))
      throw new Error(`public manifest contains duplicate deck id ${JSON.stringify(deck.id)}`);
    matchedIds.add(deck.id);

    const source = receiptDecks.get(deck.id);
    if (!source) throw new Error(`private source receipt is missing public deck ${deck.id}`);
    if (source.revision !== deck.revision)
      throw new Error(`private source receipt revision is stale for deck ${deck.id}`);
    return { ...deck, sourcePath: source.sourcePath };
  });

  if (matchedIds.size !== receiptDecks.size)
    throw new Error('private source receipt deck list does not match the public manifest');
  return { ...manifest, decks };
}

export async function readManifestSnapshot(
  site,
  receiptPath = `${path.resolve(site)}.receipt.json`,
) {
  const resolvedSite = path.resolve(site);
  const manifestPath = path.join(resolvedSite, 'manifest.json');
  let bytes;
  try {
    bytes = await fs.readFile(manifestPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { bytes: null, manifest: null };
    throw new Error(`cannot read public manifest ${manifestPath}: ${error.message}`, {
      cause: error,
    });
  }

  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid public manifest JSON at ${manifestPath}: ${error.message}`, {
      cause: error,
    });
  }

  if (
    !isPlainObject(manifest) ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.decks) ||
    manifest.decks.length === 0 ||
    manifest.decks.some((deck) => !isPlainObject(deck))
  )
    return { bytes, manifest: validateManifest(manifest) };

  if (manifest.decks.every((deck) => Object.hasOwn(deck, 'sourcePath')))
    return { bytes, manifest: validateManifest(manifest) };

  if (
    typeof receiptPath !== 'string' ||
    !path.isAbsolute(receiptPath) ||
    receiptPath.includes('\0')
  )
    throw new Error('receiptPath must be an absolute path');
  const resolvedReceiptPath = path.resolve(receiptPath);
  const receipt = await readSourceReceipt(resolvedSite, resolvedReceiptPath);
  return {
    bytes,
    manifest: validateManifest(mergeReceiptSources(manifest, receipt, resolvedSite)),
  };
}

export async function readManifestIfPresent(
  site,
  receiptPath = `${path.resolve(site)}.receipt.json`,
) {
  return (await readManifestSnapshot(site, receiptPath)).manifest;
}

function isInside(parent, child) {
  const relativePath = path.relative(parent, child);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

export async function resolveManifestSources(decks, legacySourceRoot, fixturesRootPath) {
  const approvedRoot = await fs.realpath(fixturesRootPath);
  const rootInfo = await fs.stat(approvedRoot);
  if (!rootInfo.isDirectory())
    throw new Error(`approved fixtures root is not a directory: ${approvedRoot}`);

  const sources = [];
  for (const deck of decks) {
    if (typeof deck.sourcePath !== 'string' || deck.sourcePath.length === 0)
      throw new Error(`source for ${deck.id} must have a non-empty sourcePath`);
    if (!path.isAbsolute(deck.sourcePath) && !legacySourceRoot)
      throw new Error(
        `legacySourceRoot is required to resolve relative manifest sourcePath for ${deck.id}`,
      );
    const declaredSource = path.isAbsolute(deck.sourcePath)
      ? path.resolve(deck.sourcePath)
      : path.resolve(legacySourceRoot, deck.sourcePath);
    let source;
    try {
      source = await fs.realpath(declaredSource);
    } catch (error) {
      throw new Error(
        `cannot resolve source for ${deck.id} (${declaredSource}): ${error.message}`,
        { cause: error },
      );
    }
    if (!isInside(approvedRoot, source))
      throw new Error(
        `source for ${deck.id} resolves outside the approved fixtures root: ${source}`,
      );
    const sourceInfo = await fs.stat(source);
    if (!sourceInfo.isFile()) throw new Error(`source for ${deck.id} is not a file: ${source}`);
    sources.push({ ...deck, source });
  }
  return { approvedRoot, sources };
}

export async function loadSlidevParser(dependencyRoot = packageRoot) {
  if (!path.isAbsolute(dependencyRoot) || dependencyRoot.includes('\0'))
    throw new Error('dependencyRoot must be an absolute path');
  return loadAdapterSlidevParser(dependencyRoot);
}

export { inspectDeckSource };

export async function assertDeckEntryExists(site, id) {
  try {
    await fs.access(path.join(site, ...id.split('/'), 'index.html'));
  } catch {
    await fs.access(path.join(site, 'index.html'));
  }
}

export async function checkTreeForPrivateSentinels(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, item.name);
    if (item.isDirectory()) await checkTreeForPrivateSentinels(fullPath);
    else if (item.isFile()) {
      const bytes = await fs.readFile(fullPath);
      if (bytes.includes(Buffer.from('PRIVATE_NOTE_')))
        throw new Error(`private note in public artifact: ${fullPath}`);
    }
  }
}
