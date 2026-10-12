export interface MountNavigationOptions {
  homeHref?: string;
  homeLabel?: string;
  enabled?: boolean;
}

const navigationStyle = `
.slide-library-home{position:fixed;top:12px;left:12px;z-index:2147483647;display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fffffff2;color:#334155;font:12px/1.4 system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px #0000000d}
.slide-library-home:hover{background:#e6f1fc;color:#0965b8}.slide-library-home:focus-visible{outline:3px solid #2089eb;outline-offset:3px}
@media print{.slide-library-home{display:none!important}}`;

export function mountNavigation(options: MountNavigationOptions = {}): () => void {
  const query = new URLSearchParams(location.search);
  const embedded =
    window.parent !== window ||
    query.get('embedded') === 'true' ||
    query.get('labThumbnail') === 'true';
  const style = document.createElement('style');
  style.textContent = embedded ? '.watabegg-back-link{display:none!important}' : navigationStyle;
  document.head.append(style);

  let link: HTMLAnchorElement | undefined;
  if (!embedded && options.enabled !== false) {
    link = document.createElement('a');
    link.className = 'slide-library-home';
    link.href = options.homeHref ?? '/';
    link.textContent = options.homeLabel ?? '← ホームへ戻る';
    link.setAttribute('aria-label', options.homeLabel ?? '資料ライブラリのホームへ戻る');
    document.body.append(link);
  }

  return () => {
    link?.remove();
    style.remove();
  };
}
