type CatalogDeck = {
  id: string;
  title?: string;
  revision: string;
};

function deckPath(id: string) {
  return `/${id.split('/').map(encodeURIComponent).join('/')}/1`;
}

function addStyles() {
  const style = document.createElement('style');
  style.textContent = `
    :root { color: #182a33; background: #f4f7f6; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; }
    main { box-sizing: border-box; max-width: 960px; margin: 0 auto; padding: 3rem 1.25rem; }
    h1 { margin: 0; font-size: clamp(2rem, 4vw, 3rem); letter-spacing: -.04em; }
    .intro { margin: .7rem 0 2rem; color: #54666d; }
    .decks { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
    .deck { overflow: hidden; border: 1px solid #d7e0de; border-radius: 14px; background: white; box-shadow: 0 8px 24px #15362c0a; }
    .deck img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #eaf0ee; }
    .deck a { display: block; padding: 1rem; color: inherit; font-weight: 650; text-decoration: none; }
    .deck a:hover { color: #087c67; }
    .empty, .error { padding: 1rem; border-radius: 10px; background: #fff; color: #52636a; }
  `;
  document.head.append(style);
}

function renderError(root: HTMLElement, message: string) {
  const error = document.createElement('p');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  error.textContent = message;
  root.replaceChildren(error);
}

/** Render the local PoC catalog without loading the Slidev app. */
export async function showCatalog() {
  document.title = 'Slidev Lab';
  addStyles();
  const root = document.querySelector<HTMLElement>('#app') ?? document.body;
  const main = document.createElement('main');
  const heading = document.createElement('h1');
  heading.textContent = 'Slidev Lab';
  const intro = document.createElement('p');
  intro.className = 'intro';
  intro.textContent = 'ローカルで公開した資料を選んでください。';
  const deckList = document.createElement('section');
  deckList.className = 'decks';
  deckList.setAttribute('aria-label', '資料一覧');
  main.append(heading, intro, deckList);
  root.replaceChildren(main);

  try {
    const response = await fetch('/api/catalog', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
    // The Worker catalog response is serialized from this deck shape.
    const result = (await response.json()) as { decks?: CatalogDeck[] };
    const decks = result.decks || [];
    if (!decks.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '資料はまだありません。';
      deckList.append(empty);
      return;
    }

    for (const deck of decks) {
      const article = document.createElement('article');
      article.className = 'deck';
      const link = document.createElement('a');
      const url = new URL(deckPath(deck.id), location.origin);
      url.searchParams.set('revision', deck.revision);
      link.href = url.pathname + url.search;
      link.textContent = deck.title || deck.id;
      const image = document.createElement('img');
      image.alt = '';
      image.hidden = true;
      image.src = `/releases/${deck.id.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(deck.revision)}/thumbnail.png`;
      image.onload = () => {
        image.hidden = false;
      };
      image.onerror = () => image.remove();
      article.append(image, link);
      deckList.append(article);
    }
  } catch (error) {
    renderError(deckList, error instanceof Error ? error.message : String(error));
  }
}
