// @ts-expect-error Vite supplies an inline CSS string; the browser-only query has no TS declaration.
import catalogStyles from '@slidock/slidock/frontend/style.css?inline';
import { createWorkersCatalogSource } from '@slidock/slidock/client';
import { mountHub } from '@slidock/slidock/frontend';

/** Mount the shared Hub catalog UI using the Worker catalog endpoint. */
export async function showCatalog(): Promise<void> {
  document.title = 'Slidock';
  // The shared stylesheet has document-level defaults; keep them out of deck views.
  const style = document.createElement('style');
  style.textContent = catalogStyles;
  document.head.append(style);
  const root = document.querySelector<HTMLElement>('#app') ?? document.body;
  await mountHub(root, {
    source: createWorkersCatalogSource(),
  });
}
