import {
  defineAsyncComponent,
  defineComponent,
  h,
  reactive,
  shallowReactive,
  shallowRef,
} from 'vue';
import type { Component } from 'vue';
import { isRecord, type DeckManifest } from './manifest';

type SlideComponentModule = { default: Component };

const SlideLoadError = defineComponent({
  setup() {
    return () =>
      h(
        'div',
        {
          role: 'alert',
          style:
            'margin:2rem;padding:1.5rem;background:#fff4f4;color:#792323;border:1px solid #d99;border-radius:8px;font:20px/1.6 sans-serif',
        },
        [
          h('p', 'スライドを読み込めませんでした。接続を確認して再読み込みしてください。'),
          h(
            'button',
            {
              type: 'button',
              onClick: () => location.reload(),
              style:
                'padding:.4em 1em;border:1px solid currentColor;border-radius:4px;cursor:pointer',
            },
            '再読み込み',
          ),
        ],
      );
  },
});

const styleLoads = new Map<string, Promise<void>>();

function loadSlideComponent(moduleUrl: string): Promise<SlideComponentModule> {
  // Compiled slide modules export a Vue component as their default export.
  return import(/* @vite-ignore */ moduleUrl) as Promise<SlideComponentModule>;
}

function ensureStylesheet(href?: string) {
  if (!href) return Promise.resolve();

  const existing = styleLoads.get(href);
  if (existing) return existing;

  const pending = new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.slidevLabCss = href;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      styleLoads.delete(href);
      reject(new Error(`Failed to load slide stylesheet: ${href}`));
    };
    document.head.append(link);
  });
  styleLoads.set(href, pending);
  return pending;
}

/** Build the route objects consumed by Slidev's useNav and SlideWrapper. */
export function createSlideRoutes(
  manifest: Pick<DeckManifest, 'title' | 'frontmatter' | 'slides'>,
) {
  const defaults = (manifest.frontmatter?.defaults || {}) as Record<string, unknown>;
  const routes = manifest.slides.map((item, index) => {
    const frontmatter = reactive({ ...defaults, ...item.frontmatter });
    const slide = {
      title:
        typeof item.title === 'string'
          ? item.title
          : typeof frontmatter.title === 'string'
            ? frontmatter.title
            : index === 0
              ? manifest.title || ''
              : '',
      note: '',
      noteHTML: '',
      raw: '',
      content: '',
      frontmatter,
      source: undefined,
      importChain: undefined,
      images: Array.isArray(frontmatter.images)
        ? frontmatter.images
            .map((image: unknown) => {
              if (typeof image === 'string') return image;
              return isRecord(image) && typeof image.src === 'string' ? image.src : undefined;
            })
            .filter((image: unknown): image is string => typeof image === 'string')
        : [],
      filepath: '',
      start: index,
      sourceIndex: index,
      id: index,
      no: item.no,
    };
    const meta = shallowReactive({
      get layout() {
        return frontmatter.layout;
      },
      get transition() {
        return frontmatter.transition;
      },
      get class() {
        return frontmatter.class;
      },
      get clicks() {
        return frontmatter.clicks;
      },
      get name() {
        return frontmatter.name;
      },
      get preload() {
        return frontmatter.preload;
      },
      slide,
      __clicksContext: null,
      __preloaded: false,
    });

    let loadedModule: Promise<SlideComponentModule> | undefined;
    const load = async () => {
      if (!loadedModule) {
        loadedModule = (async () => {
          await ensureStylesheet(item.css);
          // Vite must leave this immutable-revision ESM URL for the browser.
          return loadSlideComponent(item.module);
        })();
      }
      return loadedModule;
    };

    return {
      no: item.no,
      meta,
      load,
      component: defineAsyncComponent({ loader: load, errorComponent: SlideLoadError }),
    };
  });

  return shallowRef(routes);
}
