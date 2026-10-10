import { createPublicationJobClient } from '@slidev-stage-hub/hub/client';
import { mountJobStatus } from '@slidev-stage-hub/hub/frontend';

const stylesheetUrl = new URL('../../../packages/hub/src/frontend/job-status.css', import.meta.url)
  .href;

export function bootJobStatus(): void {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = stylesheetUrl;
  document.head.append(stylesheet);

  const parameters = new URLSearchParams(window.location.search);
  const deckId = parameters.get('deckId') ?? '';
  const jobId = parameters.get('jobId') ?? '';
  const target = document.createElement('div');
  target.id = 'hub-job-status-root';
  document.body.replaceChildren(target);
  document.title = '公開ジョブ · Slide Library';

  try {
    const client = createPublicationJobClient({ baseUrl: window.location.origin });
    mountJobStatus(target, { client, deckId, jobId });
  } catch {
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = '確認リンクを開けませんでした。資料一覧からもう一度お試しください。';
    target.replaceChildren(message);
  }
}
