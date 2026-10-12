import { mountNavigation } from '@slidock/slidock/frontend';
import { createSlideRoutes } from './routes';
import { showCatalog } from './catalog';
import { deckBase, deckId } from '/@lab/selection';
import baseConfig from '/@lab/base-config';
import {
  isRecord,
  selectRequestedRevision,
  validateDeckManifest,
  type DeckManifest,
} from './manifest';

type RuntimeConfig = Record<string, unknown> & {
  themeConfig?: Record<string, unknown>;
  htmlAttrs?: Record<string, unknown>;
};

const runtimeOnlyConfig = [
  'title',
  'titleTemplate',
  'author',
  'keywords',
  'info',
  'seoMeta',
  'themeConfig',
  'lang',
];

type SlidevRuntimeData = {
  configs: RuntimeConfig;
  slides: ReturnType<typeof createSlideRoutes>;
};

declare global {
  interface Window {
    __slidevLabData?: SlidevRuntimeData;
    __slidevLab?: { runtimeVersion?: string; theme?: string };
    __workersPoc?: { id: string; revision: string; deckBase: string };
  }
}

function mergeConfig(manifest: DeckManifest): RuntimeConfig {
  const config: RuntimeConfig = { ...baseConfig };
  const source = manifest.frontmatter ?? {};
  for (const key of runtimeOnlyConfig) {
    if (source[key] !== undefined) config[key] = source[key];
  }
  const sourceThemeConfig = isRecord(source.themeConfig) ? source.themeConfig : {};
  config.themeConfig = {
    ...baseConfig.themeConfig,
    ...sourceThemeConfig,
  };
  config.title = manifest.title || source.title || 'Slidev';
  const titleTemplate =
    typeof config.titleTemplate === 'string' ? config.titleTemplate : '%s - Slidev';
  config.slidesTitle = titleTemplate.replace('%s', String(config.title));
  config.htmlAttrs = source.lang
    ? { ...baseConfig.htmlAttrs, lang: source.lang }
    : baseConfig.htmlAttrs;
  return config;
}

function pinRevision(revision: string) {
  const url = new URL(location.href);
  if (url.searchParams.get('revision') === revision) return;
  url.searchParams.set('revision', revision);
  history.replaceState(history.state, '', url);
}

async function boot() {
  if (new URL(location.href).pathname === '/_hub/jobs') {
    const { bootJobStatus } = await import('./job-status');
    bootJobStatus();
    return;
  }

  if (!deckId) {
    await showCatalog();
    return;
  }

  const documentUrl = new URL(location.href);
  const requestedRevision = selectRequestedRevision(
    documentUrl,
    document.querySelector('meta[name="hub-revision"]')?.getAttribute('content') ?? null,
  );
  const query = requestedRevision ? `?revision=${encodeURIComponent(requestedRevision)}` : '';
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}${query}`, {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Deck ${deckId} is unavailable (${response.status})`);
  const runtimeId = new URL(import.meta.url).pathname.match(/^\/runtimes\/([a-f0-9]{64})\//u)?.[1];
  const manifest = validateDeckManifest(await response.json(), deckId, runtimeId);
  if (requestedRevision && manifest.revision !== requestedRevision)
    throw new Error(
      `Requested revision ${requestedRevision} does not match the returned deck revision`,
    );

  pinRevision(manifest.revision);
  mountNavigation();
  window.__slidevLab = { runtimeVersion: manifest.runtimeVersion, theme: manifest.theme };
  window.__slidevLabData = {
    configs: mergeConfig(manifest),
    slides: createSlideRoutes(manifest),
  };
  window.__workersPoc = { id: deckId, revision: manifest.revision, deckBase };

  // Config/slides facades are read synchronously when Slidev's client is
  // evaluated, so publish the manifest before importing the real app.
  await import('@slidev/client/main.ts');
}

function showError(error: unknown) {
  console.error('[slidev-workers] startup failed', error);
  const container = document.createElement('pre');
  container.setAttribute('role', 'alert');
  container.style.cssText =
    'margin:2rem;padding:1rem;white-space:pre-wrap;color:#8a1024;background:#fff4f4;border:1px solid #df9aa5';
  container.textContent = `Slidev could not load this deck.\n${error instanceof Error ? error.message : String(error)}`;
  document.body.replaceChildren(container);
}

void boot().catch(showError);
