// @ts-expect-error Vite supplies an inline CSS string; the browser-only query has no TS declaration.
import catalogStyles from '@slidev-stage-hub/hub/frontend/style.css?inline';
import { createWorkersCatalogSource } from '@slidev-stage-hub/hub/client';
import { mountHub } from '@slidev-stage-hub/hub/frontend';

/** Mount the shared Hub catalog UI using the Worker catalog endpoint. */
export async function showCatalog(): Promise<void> {
  document.title = 'Slidev Lab';
  // The shared stylesheet has document-level defaults; keep them out of deck views.
  const style = document.createElement('style');
  style.textContent = catalogStyles;
  document.head.append(style);
  const root = document.querySelector<HTMLElement>('#app') ?? document.body;
  await mountHub(root, {
    source: createWorkersCatalogSource(),
  });
}
