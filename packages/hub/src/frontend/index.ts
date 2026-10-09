import { createApp } from 'vue';
import type { App } from 'vue';
import { CatalogClientError, getCatalog } from '@slidev-stage-hub/hub/client';
import type { CatalogDeck, CatalogSource } from '@slidev-stage-hub/hub/client';
import type { CatalogRequestOptions } from '@slidev-stage-hub/hub/client';
import Home from './Home.vue';

export { mountNavigation } from './navigation.js';
export type { MountNavigationOptions } from './navigation.js';

export interface HubNavigationOptions {
  homeHref?: string;
  homeLabel?: string;
  deckHref?: (deck: CatalogDeck) => string;
}

export interface MountHubOptions extends CatalogRequestOptions {
  source?: CatalogSource;
  navigation?: HubNavigationOptions;
}

export class FrontendMountError extends Error {
  readonly code = 'MOUNT';

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'FrontendMountError';
  }
}

function isElementLike(target: unknown): target is Element {
  return (
    typeof target === 'object' && target !== null && 'nodeType' in target && target.nodeType === 1
  );
}

function resolveTarget(target: Element | string): Element {
  if (typeof target !== 'string') {
    if (isElementLike(target)) return target;
    throw new FrontendMountError('Hub mount target must be an Element or selector');
  }

  try {
    const element = document.querySelector(target);
    if (!element) throw new Error(`No element matches ${target}`);
    return element;
  } catch (cause) {
    if (cause instanceof FrontendMountError) throw cause;
    throw new FrontendMountError('Unable to resolve Hub mount target', { cause });
  }
}

export async function mountHub(
  target: Element | string,
  options: MountHubOptions = {},
): Promise<{ unmount(): void }> {
  const element = resolveTarget(target);
  const catalog = await getCatalog(options.source, { signal: options.signal });
  if (options.signal?.aborted) {
    throw new CatalogClientError('ABORTED', 'Catalog request was aborted', {
      cause: options.signal.reason,
    });
  }

  let app: App<Element>;
  try {
    app = createApp(Home, {
      catalog,
      homeHref: options.navigation?.homeHref,
      homeLabel: options.navigation?.homeLabel,
      deckHref: options.navigation?.deckHref,
    });
    app.mount(element);
  } catch (cause) {
    throw new FrontendMountError('Unable to mount Hub frontend', { cause });
  }

  let mounted = true;
  return {
    unmount() {
      if (!mounted) return;
      mounted = false;
      app.unmount();
    },
  };
}
