import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverDecks } from './internal/catalog.mjs';

export class HubBuildError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HubBuildError';
  }
}
export interface HubProfile {
  dependencyRoot: string;
  theme: string;
}
export interface HubDeck {
  id: string;
  entry: string;
  profile?: string;
}
export interface HubBuildOptions {
  configPath?: string;
  baseDir?: string;
  sourceRoot?: string;
  outDir?: string;
  dependencyRoot?: string;
  theme?: string;
  decks?: HubDeck[];
  profiles?: Record<string, HubProfile>;
  offline?: boolean;
  chromiumExecutable?: string;
  bootstrap?: 'sync' | 'tla';
  isolateDecks?: boolean;
  onProgress?: (event: { phase: string }) => void;
}
export interface NormalizedHubConfig {
  sourceRoot: string;
  outDir: string;
  dependencyRoot: string;
  theme: string;
  frontendRoot: string;
  decks: Array<HubDeck & { categoryPath: string[] }>;
  profiles?: Record<string, HubProfile>;
  offline: boolean;
  chromiumExecutable?: string;
  bootstrap: 'sync' | 'tla';
  isolateDecks: boolean;
}

export const hubRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
export function defaultToolchain(): HubProfile {
  return {
    dependencyRoot: hubRoot,
    theme: dirname(require.resolve('@slidev/theme-default/package.json')),
  };
}
export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
// oxlint-disable-next-line no-control-regex -- Match the existing catalog URL boundary.
const reservedId = /[\u0000-\u001f\u007f\\:?#[\]@!$&'()*+,;=%]/u;
const keys = new Set([
  'sourceRoot',
  'outDir',
  'dependencyRoot',
  'theme',
  'decks',
  'profiles',
  'offline',
  'chromiumExecutable',
  'bootstrap',
  'isolateDecks',
]);
function knownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new HubBuildError('CONFIG', `${label}: unknown key ${key}`);
}
function absolute(value: unknown, base: string | undefined, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new HubBuildError('CONFIG', `${label} must be a local path`);
  if (/^[a-z]+:\/\//i.test(value))
    throw new HubBuildError('CONFIG', `${label} must be a local path`);
  if (!isAbsolute(value) && !base)
    throw new HubBuildError('CONFIG', `${label} requires an absolute path or baseDir`);
  return isAbsolute(value) ? resolve(value) : resolve(base!, value);
}
async function canonicalOutput(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalOutput(parent), relative(parent, path));
  }
}

export async function normalizeHubConfig(options: HubBuildOptions): Promise<NormalizedHubConfig> {
  try {
    if (!record(options)) throw new HubBuildError('CONFIG', 'build options must be an object');
    knownKeys(options, new Set([...keys, 'configPath', 'baseDir', 'onProgress']), 'options');
    if (options.onProgress !== undefined && typeof options.onProgress !== 'function')
      throw new HubBuildError('CONFIG', 'onProgress must be a function');
    let base =
      options.baseDir === undefined ? undefined : absolute(options.baseDir, undefined, 'baseDir');
    let configured: Record<string, unknown> = {};
    if (options.configPath !== undefined) {
      const path = absolute(options.configPath, base, 'configPath');
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!record(parsed) || parsed.schemaVersion !== 1)
        throw new HubBuildError('CONFIG', 'config schemaVersion must be 1');
      knownKeys(parsed, new Set([...keys, 'schemaVersion']), 'config');
      const { schemaVersion: _schemaVersion, ...fields } = parsed;
      configured = fields;
      // Paths in the file always belong to its directory, even with API overrides.
      const fileBase = dirname(path);
      for (const key of ['sourceRoot', 'outDir', 'dependencyRoot', 'theme', 'chromiumExecutable'])
        if (configured[key] !== undefined)
          configured[key] = absolute(configured[key], fileBase, key);
      if (Array.isArray(configured.decks))
        configured.decks = configured.decks.map((deck) =>
          record(deck) ? { ...deck, entry: absolute(deck.entry, fileBase, 'deck entry') } : deck,
        );
      if (record(configured.profiles))
        configured.profiles = Object.fromEntries(
          Object.entries(configured.profiles).map(([id, profile]) => [
            id,
            record(profile)
              ? {
                  ...profile,
                  dependencyRoot: absolute(profile.dependencyRoot, fileBase, 'dependencyRoot'),
                  theme: absolute(profile.theme, fileBase, 'theme'),
                }
              : profile,
          ]),
        );
      base ??= fileBase;
    }
    const input: Record<string, unknown> = { ...configured };
    for (const [key, value] of Object.entries(options))
      if (keys.has(key) && value !== undefined) input[key] = value;
    const defaults = defaultToolchain();
    const sourceRoot = await realpath(absolute(input.sourceRoot, base, 'sourceRoot'));
    if (!(await stat(sourceRoot)).isDirectory())
      throw new HubBuildError('CONFIG', 'sourceRoot must be a directory');
    const outDir = await canonicalOutput(absolute(input.outDir, base, 'outDir'));
    if (isInside(sourceRoot, outDir) || isInside(outDir, sourceRoot))
      throw new HubBuildError('CONFIG', 'sourceRoot and outDir must be separate trees');
    if (isInside(outDir, hubRoot))
      throw new HubBuildError('CONFIG', 'outDir must not contain the Hub package');
    const dependencyRoot = await realpath(
      absolute(input.dependencyRoot ?? defaults.dependencyRoot, base, 'dependencyRoot'),
    );
    const theme = await realpath(absolute(input.theme ?? defaults.theme, base, 'theme'));
    for (const flag of ['offline', 'isolateDecks'])
      if (input[flag] !== undefined && typeof input[flag] !== 'boolean')
        throw new HubBuildError('CONFIG', `${flag} must be boolean`);
    if (input.bootstrap !== undefined && input.bootstrap !== 'sync' && input.bootstrap !== 'tla')
      throw new HubBuildError('CONFIG', 'bootstrap must be sync or tla');
    let profiles: Record<string, HubProfile> | undefined;
    if (input.profiles !== undefined) {
      if (!record(input.profiles) || !Object.keys(input.profiles).length)
        throw new HubBuildError('CONFIG', 'profiles must be a nonempty object');
      profiles = {};
      for (const [id, profile] of Object.entries(input.profiles)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id) || !record(profile))
          throw new HubBuildError('CONFIG', `invalid profile ${id}`);
        knownKeys(profile, new Set(['dependencyRoot', 'theme']), `profile ${id}`);
        profiles[id] = {
          dependencyRoot: await realpath(absolute(profile.dependencyRoot, base, 'dependencyRoot')),
          theme: await realpath(absolute(profile.theme, base, 'theme')),
        };
      }
    }
    let decks: NormalizedHubConfig['decks'];
    if (input.decks === undefined) decks = await discoverDecks(sourceRoot);
    else {
      if (!Array.isArray(input.decks) || !input.decks.length)
        throw new HubBuildError('CONFIG', 'decks must be a nonempty array');
      decks = [];
      for (const deck of input.decks) {
        if (!record(deck)) throw new HubBuildError('CONFIG', 'deck must be an object');
        knownKeys(deck, new Set(['id', 'entry', 'profile']), 'deck');
        if (
          typeof deck.id !== 'string' ||
          deck.id
            .split('/')
            .some((part) => !part || part === '.' || part === '..' || reservedId.test(part))
        )
          throw new HubBuildError('CONFIG', 'invalid deck id');
        const entry = await realpath(absolute(deck.entry, base ?? sourceRoot, 'deck entry'));
        if (!isInside(sourceRoot, entry) || !(await stat(entry)).isFile())
          throw new HubBuildError('CONFIG', `deck ${deck.id} is outside sourceRoot or not a file`);
        if (deck.profile !== undefined && typeof deck.profile !== 'string')
          throw new HubBuildError('CONFIG', 'deck profile must be a string');
        decks.push({
          id: deck.id,
          entry,
          categoryPath: deck.id.split('/').slice(0, -1),
          ...(deck.profile ? { profile: deck.profile as string } : {}),
        });
      }
      decks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    if (new Set(decks.map((deck) => deck.id)).size !== decks.length)
      throw new HubBuildError('CONFIG', 'duplicate deck id');
    for (const deck of decks) {
      if (
        profiles
          ? !deck.profile || !Object.hasOwn(profiles, deck.profile)
          : deck.profile !== undefined
      )
        throw new HubBuildError('CONFIG', `deck ${deck.id} requires a declared profile`);
    }
    return {
      sourceRoot,
      outDir,
      dependencyRoot,
      theme,
      frontendRoot: resolve(hubRoot, 'frontend'),
      decks,
      profiles,
      offline: input.offline !== false,
      isolateDecks: input.isolateDecks === true,
      bootstrap: input.bootstrap === 'tla' ? 'tla' : 'sync',
      ...(input.chromiumExecutable !== undefined
        ? { chromiumExecutable: absolute(input.chromiumExecutable, base, 'chromiumExecutable') }
        : {}),
    };
  } catch (error) {
    if (error instanceof HubBuildError) throw error;
    throw new HubBuildError('CONFIG', error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}
