import type {
  CatalogCategory,
  CatalogDeck,
  JsonValue,
  PublicFrontmatter,
} from '@slidock/protocol/contracts';
import { WorkerError, type ErrorPhase } from './errors.js';
import { isReleaseManifest, type ReleaseManifest } from './manifest.js';
import type { ArtifactStore, HubServerOptions } from './ports.js';

const MAX_PAGE_SIZE = 1000;
const PUBLIC_FRONTMATTER_FIELDS = [
  'title',
  'subtitle',
  'author',
  'date',
  'description',
  'tags',
] as const;
const PRIVATE_FRONTMATTER_KEY = /^(?:(?:speaker|presenter|private)[_-]?)?notes?$/i;

export interface IndexPage {
  objects: { key: string }[];
  truncated: boolean;
  cursor?: string;
}

export interface PageOptions {
  limit: number;
  cursor?: string;
}

export interface CatalogPage {
  schemaVersion: 1;
  categories: CatalogCategory[];
  decks: CatalogDeck[];
  cursor?: string;
}

export function parsePageOptions(url: URL): PageOptions {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? MAX_PAGE_SIZE : Number(rawLimit);
  if (
    (rawLimit !== null && !/^\d+$/u.test(rawLimit)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE
  ) {
    throw new WorkerError(400, 'request', 'limit must be an integer from 1 to 1000');
  }

  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4096)) {
    throw new WorkerError(400, 'request', 'cursor is invalid');
  }
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

export async function readIndexPage(
  bucket: ArtifactStore,
  options: PageOptions,
  phase: 'catalog' | 'discovery',
): Promise<IndexPage> {
  let listed: { keys: string[]; cursor?: string };
  try {
    listed = await bucket.list({
      prefix: 'index/',
      limit: options.limit,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
  } catch {
    throw new WorkerError(500, phase, phaseFailureMessage(phase));
  }
  if (listed.cursor === '') {
    throw new WorkerError(500, phase, phaseFailureMessage(phase));
  }
  return {
    objects: listed.keys.map((key) => ({ key })),
    truncated: listed.cursor !== undefined,
    ...(listed.cursor !== undefined ? { cursor: listed.cursor } : {}),
  };
}

export async function loadCurrentManifests(
  env: HubServerOptions,
  objects: readonly { key: string }[],
  phase: 'catalog' | 'discovery',
): Promise<ReleaseManifest[]> {
  const manifests: ReleaseManifest[] = [];
  for (let offset = 0; offset < objects.length; offset += 6) {
    const batch = await Promise.allSettled(
      objects.slice(offset, offset + 6).map(async (object) => {
        const id = idFromIndexKey(object.key);
        if (!id) return null;
        const candidate: unknown = await env.publications.current(id);
        if (candidate === null) return null;
        if (!isReleaseManifest(candidate)) {
          throw new WorkerError(500, phase, phaseFailureMessage(phase));
        }
        if (candidate.id !== id || !isRevision(candidate.revision)) {
          throw new WorkerError(500, phase, phaseFailureMessage(phase));
        }
        return candidate;
      }),
    );
    for (const result of batch) {
      if (result.status === 'rejected') {
        if (result.reason instanceof WorkerError) throw result.reason;
        throw new WorkerError(500, phase, phaseFailureMessage(phase));
      }
      if (result.value) manifests.push(result.value);
    }
  }
  return manifests;
}

export async function readLegacyCatalogPage(
  env: HubServerOptions,
  url: URL,
): Promise<{ decks: ReleaseManifest[]; truncated: boolean; cursor?: string }> {
  const options = parsePageOptions(url);
  const page = await readIndexPage(env.artifacts, options, 'catalog');
  const decks = await loadCurrentManifests(env, page.objects, 'catalog');
  return {
    decks,
    truncated: page.truncated,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  };
}

export async function readCatalogPage(env: HubServerOptions, url: URL): Promise<CatalogPage> {
  const options = parsePageOptions(url);
  const page = await readIndexPage(env.artifacts, options, 'catalog');
  const manifests = await loadCurrentManifests(env, page.objects, 'catalog');
  const decks: CatalogDeck[] = [];
  for (let offset = 0; offset < manifests.length; offset += 6) {
    const batch = await Promise.allSettled(
      manifests.slice(offset, offset + 6).map((manifest) => toCatalogDeck(env, manifest)),
    );
    for (const result of batch) {
      if (result.status === 'rejected') {
        if (result.reason instanceof WorkerError) throw result.reason;
        throw new WorkerError(500, 'catalog', 'Catalog could not be read');
      }
      decks.push(result.value);
    }
  }
  const result: CatalogPage = {
    schemaVersion: 1,
    categories: categoriesForDecks(decks),
    decks,
  };
  if (page.cursor !== undefined) result.cursor = page.cursor;
  return result;
}

export function categoriesForDecks(
  decks: readonly Pick<CatalogDeck, 'categoryPath'>[],
): CatalogCategory[] {
  const categories = new Map<string, CatalogCategory>();
  for (const deck of decks) {
    for (let count = 1; count <= deck.categoryPath.length; count += 1) {
      const path = deck.categoryPath.slice(0, count);
      const id = path.join('/');
      const name = path.at(-1);
      if (name === undefined) continue;
      categories.set(id, {
        id,
        name,
        path,
        parentId: count === 1 ? null : path.slice(0, -1).join('/'),
      });
    }
  }
  return [...categories.values()].sort((left, right) => compareStrings(left.id, right.id));
}

async function toCatalogDeck(
  env: HubServerOptions,
  manifest: ReleaseManifest,
): Promise<CatalogDeck> {
  const thumbnailKey = `releases/${manifest.id}/${manifest.revision}/thumbnail.png`;
  let hasThumbnail: boolean;
  try {
    hasThumbnail = (await env.artifacts.head(thumbnailKey)) !== null;
  } catch {
    throw new WorkerError(500, 'catalog', 'Catalog could not be read');
  }

  const frontmatter: PublicFrontmatter = {};
  for (const field of PUBLIC_FRONTMATTER_FIELDS) {
    const value = toPublicJson(manifest.frontmatter[field]);
    if (value !== undefined) frontmatter[field] = value;
  }

  const categoryPath = manifest.id.split('/').slice(0, -1);
  return {
    id: manifest.id,
    title: manifest.title,
    entry: `/${manifest.id}/1?revision=${manifest.revision}`,
    pages: manifest.slides.length,
    revision: manifest.revision,
    categoryPath,
    frontmatter,
    thumbnail: {
      src: hasThumbnail ? `/${thumbnailKey}` : '/thumbnail-placeholder.svg',
      width: 1200,
      height: 675,
    },
    runtimeVersion: nonEmpty(manifest.runtimeVersion) ?? '53.0.0',
    theme: nonEmpty(manifest.theme) ?? nonEmpty(env.profile.theme) ?? '@slidev/theme-default',
    profile: nonEmpty(manifest.profileDigest) ?? nonEmpty(env.profile.digest) ?? 'legacy',
  };
}

function idFromIndexKey(key: string): string | null {
  if (!key.startsWith('index/') || !key.endsWith('.json')) return null;
  const id = key.slice('index/'.length, -'.json'.length);
  return isDeckId(id) ? id : null;
}

export function isDeckId(value: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(value);
}

function isRevision(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function phaseFailureMessage(phase: ErrorPhase): string {
  return phase === 'discovery' ? 'Deck discovery failed' : 'Catalog could not be read';
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPublicJson(value: unknown, ancestors = new Set<object>()): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || ancestors.has(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    return undefined;

  const branch = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    for (const entry of value as unknown[]) {
      const clean = toPublicJson(entry, branch);
      if (clean !== undefined) output.push(clean);
    }
    return output;
  }

  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_FRONTMATTER_KEY.test(key)) continue;
    const clean = toPublicJson(entry, branch);
    if (clean !== undefined) output[key] = clean;
  }
  return output;
}
