import { createCatalogClient, createPaginatedCatalogSource } from '@slidev-stage-hub/hub/client';
import type { CatalogDeck, JsonValue } from '@slidev-stage-hub/protocol/contracts';

const text = (value: JsonValue | undefined): string =>
  Array.isArray(value)
    ? value.map(text).filter(Boolean).join('、')
    : typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '';

export function mountLibrary(options: {
  origin: string;
  decks: NativeDeck[];
  open: (id: string) => Promise<void>;
  title: (id: string, title: string) => void;
}): void {
  const grid = document.getElementById('library-grid')!;
  const search = document.getElementById('library-search') as HTMLInputElement;
  const status = document.getElementById('library-status')!;
  let catalog = new Map<string, CatalogDeck>();
  let loading = true;
  let failed = false;
  const draw = (): void => {
    const query = search.value.trim().toLocaleLowerCase();
    const decks = options.decks.filter((deck) => {
      const item = catalog.get(deck.id);
      return [deck.id, item?.title, ...Object.values(item?.frontmatter ?? {}).map(text)]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query);
    });
    status.textContent = loading
      ? '資料を読み込み中…'
      : failed
        ? '表紙を読み込めませんでした。資料名から開けます。'
        : decks.length
          ? `${decks.length} 件の資料`
          : '一致する資料がありません';
    grid.replaceChildren(
      ...decks.map((deck) => {
        const item = catalog.get(deck.id);
        const button = document.createElement('button');
        button.className = 'deck-card';
        button.dataset.deckId = deck.id;
        const cover = document.createElement('div');
        cover.className = 'deck-cover';
        const fallback = document.createElement('span');
        fallback.className = 'cover-fallback';
        fallback.textContent = item?.title || deck.id;
        cover.append(fallback);
        if (item) {
          const src = new URL(item.thumbnail.src, options.origin);
          // Keep authenticated thumbnails on the same transport as the catalog.
          if (src.origin === new URL(options.origin).origin && !src.username && !src.password) {
            const image = document.createElement('img');
            image.alt = '';
            image.loading = 'lazy';
            image.src = src.href;
            image.onerror = () => image.remove();
            cover.append(image);
          }
        }
        const info = document.createElement('div');
        info.className = 'deck-info';
        const title = document.createElement('h2');
        title.textContent = item?.title || deck.id;
        const description = document.createElement('p');
        description.textContent = text(item?.frontmatter.subtitle || item?.frontmatter.description);
        const meta = document.createElement('div');
        meta.className = 'deck-meta';
        for (const value of [
          text(item?.frontmatter.author),
          text(item?.frontmatter.date),
          `${deck.clickTotals.length} ページ`,
        ]) {
          if (!value) continue;
          const span = document.createElement('span');
          span.textContent = value;
          meta.append(span);
        }
        const tags = document.createElement('div');
        tags.className = 'deck-tags';
        const values = item?.frontmatter.tags;
        for (const value of Array.isArray(values) ? values : values ? [values] : []) {
          if (!text(value)) continue;
          const tag = document.createElement('span');
          tag.textContent = text(value);
          tags.append(tag);
        }
        info.append(title, description, meta, tags);
        button.append(cover, info);
        button.onclick = async () => {
          button.disabled = true;
          try {
            await options.open(deck.id);
          } finally {
            button.disabled = false;
          }
        };
        return button;
      }),
    );
  };
  search.oninput = draw;
  draw();
  void createCatalogClient(
    createPaginatedCatalogSource({
      url: new URL('/catalog.json', options.origin).href,
      fetch: async (input) => {
        const url = new URL(String(input));
        const body = await window.__TAURI__.core.invoke('catalog_page', {
          cursor: url.searchParams.get('cursor'),
        });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      },
    }),
  )
    .getCatalog({ signal: AbortSignal.timeout(12000) })
    .then((result) => {
      catalog = new Map(result.decks.map((deck) => [deck.id, deck]));
      for (const deck of result.decks) options.title(deck.id, deck.title);
    })
    .catch(() => {
      failed = true;
    })
    .finally(() => {
      loading = false;
      draw();
    });
}
