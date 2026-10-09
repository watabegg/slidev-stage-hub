import './style.css';
import { CatalogClientError } from '@slidev-stage-hub/hub/client';
import { mountHub } from './index.js';
import { showStartupError } from './startup-error.js';

const root =
  document.querySelector('#app') ?? document.body.appendChild(document.createElement('main'));

void mountHub(root).catch((error: unknown) => {
  if (error instanceof CatalogClientError) {
    root.textContent = `資料一覧を読み込めませんでした。${error.message}`;
    return;
  }
  showStartupError(error);
});
