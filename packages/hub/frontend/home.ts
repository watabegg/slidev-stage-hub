import { createApp } from 'vue';
import { validateCatalog } from '@slidev-stage-hub/protocol/contracts';
import Home from './Home.vue';
import './style.css';

async function mountHome() {
  const root =
    document.querySelector('#app') ?? document.body.appendChild(document.createElement('main'));
  try {
    const response = await fetch('/catalog.json');
    if (!response.ok) throw new Error(`Catalog: HTTP ${response.status}`);
    const catalog = validateCatalog(await response.json());
    createApp(Home, { catalog }).mount(root);
  } catch (error) {
    root.textContent = `資料一覧を読み込めませんでした。${error instanceof Error ? error.message : String(error)}`;
  }
}
void mountHome();
