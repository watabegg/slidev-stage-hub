import { createConfiguredHub } from './config.js';

if (process.env.HUB_PUBLICATIONS !== 'postgres')
  throw new Error('The separate worker requires HUB_PUBLICATIONS=postgres');
const app = await createConfiguredHub();
try {
  app.startWorker();
  console.log(JSON.stringify({ event: 'hub.worker.started' }));
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      void app.close().catch(() => {
        console.error(JSON.stringify({ event: 'hub.worker.close_failed' }));
        process.exitCode = 1;
      });
    });
} catch (error) {
  await app.close();
  throw error;
}
