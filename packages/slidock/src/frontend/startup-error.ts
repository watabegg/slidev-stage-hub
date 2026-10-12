// Keep this independent of Vue and styles: either may have failed to load.
export function showStartupError(error: unknown): void {
  console.error('Slidock startup failed', error);
  const panel = document.createElement('main');
  panel.setAttribute('role', 'alert');
  panel.style.cssText =
    'max-width:48rem;margin:10vh auto;padding:2rem;font:16px/1.6 system-ui;color:#172033;background:white';
  const heading = document.createElement('h1');
  heading.textContent = '画面を読み込めませんでした';
  const message = document.createElement('p');
  message.textContent =
    '必要なファイルの読み込みに失敗しました。再読み込みするか、ホームから資料を開き直してください。';
  const retry = document.createElement('button');
  retry.textContent = '再読み込み';
  retry.onclick = () => location.reload();
  const home = document.createElement('a');
  home.href = '/';
  home.textContent = 'ホームへ戻る';
  home.style.marginLeft = '1rem';
  panel.append(heading, message, retry, home);
  (document.querySelector('#app') || document.body).replaceChildren(panel);
}
