import {
  DeckCompileError,
  compileDeck,
  type CompileDeckInput,
  type CompileDeckResult,
} from './compiler.ts';
import { WorkerError } from './errors.ts';
import { isRecord, isReleaseManifest, type ReleaseManifest } from './manifest.ts';
import { markDeckIndexed, putArtifacts, putJson, readJson, type ArtifactWrite } from './storage.ts';
import type { WorkerEnv } from './types.ts';

const MAX_SLIDES = 100;
const REVISION_METADATA_VERSION = 'native-click-metadata-v1';
const DEFAULT_THEME = '@slidev/theme-default';

export interface PublishResult {
  manifest: ReleaseManifest;
  published: boolean;
  cached: boolean;
}

type CompileFunction = (input: CompileDeckInput) => Promise<CompileDeckResult>;

export async function publishDeck(
  env: WorkerEnv,
  id: string,
  input: unknown,
  compile: CompileFunction = compileDeck,
): Promise<PublishResult> {
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
  const revision = await calculateRevision(env.PROFILE_DIGEST, input.markdown, orderedAssets);
  const prefix = `releases/${id}/${revision}`;

  let generation: number;
  try {
    generation = await env.VERSIONS.getByName(id).begin();
  } catch {
    throw new WorkerError(500, 'commit', 'Could not reserve a publication generation');
  }

  const existing = await readJson(env.FILES, `${prefix}/manifest.json`);
  let manifest: ReleaseManifest;
  let cached = false;
  if (existing !== null) {
    if (!isReleaseManifest(existing) || existing.id !== id || existing.revision !== revision) {
      throw new WorkerError(500, 'storage', 'Stored publication metadata is invalid');
    }
    manifest = existing;
    cached = true;
  } else {
    const result = await compileForPublication(compile, {
      markdown: input.markdown,
      deckId: id,
      assetBase: `/${prefix}/assets/`,
    });
    if (result.slides.length > MAX_SLIDES) {
      throw new WorkerError(400, 'compiler', 'This runtime supports at most 100 slides');
    }
    const themeName = env.PROFILE_THEME || DEFAULT_THEME;
    validateThemeAndComponents(result, env, themeName);

    const artifacts = makeArtifacts(id, revision, prefix, input, orderedAssets, result);
    await putArtifacts(env.FILES, artifacts);

    manifest = {
      id,
      revision,
      profileDigest: env.PROFILE_DIGEST,
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
    await putJson(env.FILES, `${prefix}/manifest.json`, manifest);
  }

  // The index marker is written first: an orphan marker is safe because reads
  // resolve the current manifest through the Durable Object, while a failed
  // marker write must never advance the current revision.
  await markDeckIndexed(env.FILES, id);
  let published: boolean;
  try {
    published = await env.VERSIONS.getByName(id).commit(generation, manifest);
  } catch {
    throw new WorkerError(500, 'commit', 'Could not commit publication');
  }
  return { manifest, published, cached };
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
  input: Record<string, unknown>,
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
        httpMetadata: {
          contentType: name.endsWith('.svg')
            ? 'image/svg+xml'
            : name.endsWith('.css')
              ? 'text/css'
              : 'text/plain',
        },
      },
    });
  }
  for (const slide of result.slides) {
    objects.push({
      key: `${prefix}/${slide.no}.js`,
      body: slide.code,
      options: { httpMetadata: { contentType: 'text/javascript; charset=utf-8' } },
    });
    objects.push({
      key: `${prefix}/${slide.no}.css`,
      body: slide.css,
      options: { httpMetadata: { contentType: 'text/css; charset=utf-8' } },
    });
  }
  return objects;
}

function validateThemeAndComponents(
  result: CompileDeckResult,
  env: WorkerEnv,
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

  const layouts = readNameList(env.PROFILE_LAYOUTS, ['cover', 'default', 'section'], 'layouts');
  const configuredComponents = readNameList(env.PROFILE_COMPONENTS, ['FigureGrid'], 'components');
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
): Promise<string> {
  const data = new TextEncoder().encode(
    JSON.stringify([profileDigest, REVISION_METADATA_VERSION, markdown, assets]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}
