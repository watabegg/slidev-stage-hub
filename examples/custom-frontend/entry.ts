import { createCatalogClient, createHttpCatalogSource } from '@slidev-stage-hub/hub/client';
import './style.css';

const root = document.querySelector('#app')!;
const client = createCatalogClient(createHttpCatalogSource({ url: '/catalog.json' }));
try {
  const catalog = await client.getCatalog();
  const heading = document.createElement('h1');
  heading.textContent = 'My slide collection';
  const list = document.createElement('ul');
  for (const deck of catalog.decks) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = deck.entry;
    link.textContent = `${deck.title} (${deck.pages} pages)`;
    item.append(link);
    list.append(item);
  }
  root.replaceChildren(heading, list);
} catch (error) {
  root.textContent = `Catalog could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
}
