export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PublicFrontmatter = Partial<
  Record<'title' | 'subtitle' | 'author' | 'date' | 'description' | 'tags', JsonValue>
>;

export interface CatalogCategory {
  id: string;
  name: string;
  path: string[];
  parentId: string | null;
}

export interface CatalogDeck {
  id: string;
  title: string;
  entry: string;
  pages: number;
  revision: string;
  categoryPath: string[];
  frontmatter: PublicFrontmatter;
  thumbnail: { src: string; width: number; height: number };
  runtimeVersion: string;
  theme: string;
  profile: string;
}

export interface Catalog {
  schemaVersion: 1;
  categories: CatalogCategory[];
  decks: CatalogDeck[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(
        { length: value.length },
        (_, index) => index in value && isJsonValue(value[index], ancestors),
      ).every(Boolean)
    : Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label} ${field} must be a non-empty string`);
  return value;
}

function requireStringArray(value: unknown, field: string, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))
    throw new Error(`${label} ${field} must be an array of strings`);
  return value;
}

/** Validate the public catalog before it reaches the Hub view. */
export function validateCatalog(value: unknown): Catalog {
  if (!isRecord(value)) throw new Error('catalog.json must contain a JSON object');
  if (value.schemaVersion !== 1) throw new Error('catalog.json schemaVersion must be 1');
  if (!Array.isArray(value.categories)) throw new Error('catalog.json categories must be an array');
  if (!Array.isArray(value.decks)) throw new Error('catalog.json decks must be an array');

  for (const [index, item] of value.categories.entries()) {
    const label = `category ${index + 1}`;
    if (!isRecord(item)) throw new Error(`${label} must be an object`);
    requireString(item, 'id', label);
    requireString(item, 'name', label);
    requireStringArray(item.path, 'path', label);
    if (
      item.parentId !== null &&
      (typeof item.parentId !== 'string' || item.parentId.trim() === '')
    )
      throw new Error(`${label} parentId must be a string or null`);
  }

  for (const [index, item] of value.decks.entries()) {
    const label = `deck ${index + 1}`;
    if (!isRecord(item)) throw new Error(`${label} must be an object`);
    for (const field of ['id', 'title', 'entry', 'revision', 'runtimeVersion', 'theme', 'profile'])
      requireString(item, field, label);
    if (!Number.isSafeInteger(item.pages) || (item.pages as number) <= 0)
      throw new Error(`${label} pages must be a positive integer`);
    requireStringArray(item.categoryPath, 'categoryPath', label);
    if (!isRecord(item.frontmatter) || !isJsonValue(item.frontmatter))
      throw new Error(`${label} frontmatter must contain finite JSON values`);
    if (!isRecord(item.thumbnail)) throw new Error(`${label} thumbnail must be an object`);
    requireString(item.thumbnail, 'src', `${label} thumbnail`);
    for (const field of ['width', 'height']) {
      if (!Number.isSafeInteger(item.thumbnail[field]) || (item.thumbnail[field] as number) <= 0)
        throw new Error(`${label} thumbnail ${field} must be a positive integer`);
    }
  }

  return value as unknown as Catalog;
}
