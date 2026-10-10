import {
  DeckCompileError,
  compileDeck,
  type CompileDeckInput,
  type CompileDeckResult,
} from './compiler.js';
import { WorkerError } from './errors.js';
import { isRecord, isReleaseManifest, type ReleaseManifest } from './manifest.js';
import { markDeckIndexed, putImmutableArtifacts, readJson, type ArtifactWrite } from './storage.js';
import type { HubServerOptions } from './ports.js';
import { archiveRuntime } from './runtime.js';

const MAX_SLIDES = 100;
export const REVISION_METADATA_VERSION = 'native-click-metadata-v1';
const DEFAULT_THEME = '@slidev/theme-default';

export interface PublishResult {
  manifest: ReleaseManifest;
  published: boolean;
  cached: boolean;
}

export type CompileFunction = (input: CompileDeckInput) => Promise<CompileDeckResult>;

export async function publishDeck(
  env: HubServerOptions,
  id: string,
  input: unknown,
  compile: CompileFunction = compileDeck,
): Promise<PublishResult> {
  validatePublicationInput(id, input);
  let generation: string;
  try {
    generation = await env.publications.begin(id);
  } catch {
    throw new WorkerError(500, 'commit', 'Could not reserve a publication generation');
  }
  const { manifest, cached } = await preparePublication(env, id, input, compile);
  let published: boolean;
  try {
    published = await env.publications.commit(id, generation, manifest);
  } catch {
    throw new WorkerError(500, 'commit', 'Could not commit publication');
  }
  return { manifest, published, cached };
}

export interface PublicationInput {
  markdown: string;
  assets: Record<string, string>;
}
export interface PreparationHooks {
  runtime?: (runtimeId: string | undefined) => Promise<void>;
  phase?: (phase: 'runtime' | 'compile' | 'store') => Promise<void>;
  completed?: (phase: 'runtime' | 'compile' | 'store') => Promise<void>;
  progress?: (completed: number, total: number, unit?: 'slides' | 'objects') => Promise<void>;
}
export function validatePublicationInput(id: string, input: unknown): PublicationInput {
  if (!isDeckId(id)) throw new WorkerError(400, 'request', 'Invalid deck id');
  if (!isRecord(input)) throw new WorkerError(400, 'request', 'JSON body must be an object');
  if (typeof input.markdown !== 'string' || !input.markdown.trim()) {
    throw new WorkerError(400, 'request', 'markdown is required');
  }

  const assetsInput = input.assets || {};
  if (!isRecord(assetsInput)) {
    throw new WorkerError(400, 'request', 'assets must be a filename/content object');
  }
  const assets: Record<string, string> = {};
  for (const [name, value] of Object.entries(assetsInput)) {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(svg|txt|css)$/u.test(name)) {
      throw new WorkerError(400, 'request', 'Unsupported asset');
    }
    if (typeof value !== 'string') throw new WorkerError(400, 'request', 'Unsupported asset');
    assets[name] = value;
  }
  const orderedAssets = Object.fromEntries(
    Object.entries(assets).sort(([left], [right]) => left.localeCompare(right)),
  );
  return { markdown: input.markdown, assets: orderedAssets };
}
export async function preparePublication(
  env: HubServerOptions,
  id: string,
  value: unknown,
  compile: CompileFunction = compileDeck,
  hooks: PreparationHooks = {},
): Promise<{ manifest: ReleaseManifest; cached: boolean }> {
  const input = validatePublicationInput(id, value);
  const orderedAssets = input.assets;
  let revision = await calculateRevision(env.profile.digest, input.markdown, orderedAssets);
  await hooks.phase?.('runtime');
  let snapshot;
  try {
    snapshot = await env.loadRuntime?.();
  } catch {
    throw new WorkerError(500, 'storage', 'Could not load the publication runtime');
  }
  await hooks.runtime?.(snapshot?.id);
  if (snapshot !== undefined) {
    snapshot = await archiveRuntime(env, snapshot);
    revision = await calculateRevision(
      env.profile.digest,
      input.markdown,
      orderedAssets,
      snapshot.id,
    );
  }
  await hooks.completed?.('runtime');
  await hooks.phase?.('compile');
  const prefix = `releases/${id}/${revision}`;

  const existing = await readJson(env.artifacts, `${prefix}/manifest.json`);
  let manifest: ReleaseManifest;
  let cached = false;
  if (existing !== null) {
    if (
      !isReleaseManifest(existing) ||
      existing.id !== id ||
      existing.revision !== revision ||
      (snapshot !== undefined && existing.runtimeId !== snapshot.id)
    ) {
      throw new WorkerError(500, 'storage', 'Stored publication metadata is invalid');
    }
    manifest = existing;
    cached = true;
    await hooks.completed?.('compile');
    await hooks.phase?.('store');
  } else {
    const result = await compileForPublication(compile, {
      markdown: input.markdown,
      onProgress: hooks.progress,
      deckId: id,
      assetBase: `/${prefix}/assets/`,
      ...(snapshot ? { runtimeBase: `/runtimes/${snapshot.id}/_runtime/` } : {}),
    });
    if (result.slides.length > MAX_SLIDES) {
      throw new WorkerError(400, 'compiler', 'This runtime supports at most 100 slides');
    }
    const themeName = env.profile.theme || DEFAULT_THEME;
    validateThemeAndComponents(result, env, themeName);

    const artifacts = makeArtifacts(id, revision, prefix, input, orderedAssets, result);
    await hooks.completed?.('compile');
    await hooks.phase?.('store');
    await putImmutableArtifacts(env.artifacts, artifacts, hooks.progress);

    manifest = {
      id,
      revision,
      profileDigest: env.profile.digest,
      ...(snapshot ? { runtimeId: snapshot.id } : {}),
      title: result.title,
      frontmatter: result.frontmatter,
      warnings: result.warnings,
      entry: `/${id}/1?revision=${revision}`,
      slides: result.slides.map((slide) => ({
        no: slide.no,
        title: slide.title,
        frontmatter: slide.frontmatter,
        module: `/${prefix}/${slide.no}.js`,
        css: `/${prefix}/${slide.no}.css`,
      })),
      native: result.native,
      runtimeVersion: '53.0.0',
      theme: themeName,
    };
    await putImmutableArtifacts(env.artifacts, [
      {
        key: `${prefix}/manifest.json`,
        body: JSON.stringify(manifest),
        options: { contentType: 'application/json' },
      },
    ]);
  }

  // The index marker is written first: an orphan marker is safe because reads
  // resolve the current manifest through the publication store, while a failed
  // marker write must never advance the current revision.
  await markDeckIndexed(env.artifacts, id);
  await hooks.completed?.('store');
  return { manifest, cached };
}

async function compileForPublication(
  compile: CompileFunction,
  input: CompileDeckInput,
): Promise<CompileDeckResult> {
  try {
    return await compile(input);
  } catch (error) {
    if (error instanceof DeckCompileError) {
      throw new WorkerError(400, 'compiler', error.message);
    }
    throw new WorkerError(500, 'compiler', 'Compilation failed');
  }
}

function makeArtifacts(
  id: string,
  revision: string,
  prefix: string,
  input: PublicationInput,
  assets: Record<string, string>,
  result: CompileDeckResult,
): ArtifactWrite[] {
  const objects: ArtifactWrite[] = [
    { key: `private/${id}/${revision}.json`, body: JSON.stringify(input) },
  ];
  for (const [name, value] of Object.entries(assets)) {
    objects.push({
      key: `${prefix}/assets/${name}`,
      body: value,
      options: {
        contentType: name.endsWith('.svg')
          ? 'image/svg+xml'
          : name.endsWith('.css')
            ? 'text/css'
            : 'text/plain',
      },
    });
  }
  for (const slide of result.slides) {
    objects.push({
      key: `${prefix}/${slide.no}.js`,
      body: slide.code,
      options: { contentType: 'text/javascript; charset=utf-8' },
    });
    objects.push({
      key: `${prefix}/${slide.no}.css`,
      body: slide.css,
      options: { contentType: 'text/css; charset=utf-8' },
    });
  }
  return objects;
}

function validateThemeAndComponents(
  result: CompileDeckResult,
  env: HubServerOptions,
  themeName: string,
): void {
  const themeAlias = themeName.replace(/^@slidev\/theme-/, '').replace(/^slidev-theme-/, '');
  if (
    typeof result.frontmatter.theme === 'string' &&
    ![themeName, themeAlias].includes(result.frontmatter.theme)
  ) {
    throw new WorkerError(
      400,
      'compiler',
      `This runtime only includes the prebuilt theme: ${themeName}`,
    );
  }

  const layouts = readNameList(env.profile.layouts, ['cover', 'default', 'section'], 'layouts');
  const configuredComponents = readNameList(env.profile.components, ['FigureGrid'], 'components');
  const components = new Set(
    ['LabSlideLayout', ...configuredComponents].map((name) => normalizeComponent(name)),
  );
  for (const slide of result.slides) {
    const slideLayout = slide.frontmatter.layout;
    const defaults = isRecord(result.frontmatter.defaults) ? result.frontmatter.defaults : {};
    const defaultLayout = defaults.layout;
    const layout = slideLayout ?? defaultLayout ?? (slide.no === 1 ? 'cover' : 'default');
    if (typeof layout !== 'string' || !layouts.includes(layout)) {
      throw new WorkerError(
        400,
        'compiler',
        `Layout is not registered in this runtime: ${String(layout)}`,
      );
    }
    for (const [, name] of slide.code.matchAll(/resolveComponent\("([^"\\]+)"\)/gu)) {
      if (name !== undefined && !components.has(normalizeComponent(name))) {
        throw new WorkerError(
          400,
          'compiler',
          `Component is not registered in this runtime: ${name}`,
        );
      }
    }
  }
}

function readNameList(value: string | undefined, fallback: string[], label: string): string[] {
  if (!value) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WorkerError(500, 'compiler', `Runtime ${label} configuration is invalid`);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new WorkerError(500, 'compiler', `Runtime ${label} configuration is invalid`);
  }
  return parsed;
}

function normalizeComponent(name: string): string {
  return name.replace(/-/gu, '').toLowerCase();
}

function isDeckId(id: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(id);
}

async function calculateRevision(
  profileDigest: string,
  markdown: string,
  assets: Record<string, string>,
  runtimeId?: string,
): Promise<string> {
  const data = new TextEncoder().encode(
    JSON.stringify(
      runtimeId === undefined
        ? [profileDigest, REVISION_METADATA_VERSION, markdown, assets]
        : [profileDigest, REVISION_METADATA_VERSION, markdown, assets, runtimeId],
    ),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}
