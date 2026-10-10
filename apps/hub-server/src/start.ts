import { startHubServer } from '@slidev-stage-hub/adapter-node';
import { createConfiguredHub } from './config.js';

const port = Number(process.env.PORT ?? '4180');
if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
  throw new Error('PORT must be an integer from 0 to 65535');
const app = await createConfiguredHub();
try {
  const http = await startHubServer({
    server: app.server,
    host: process.env.HOST ?? '127.0.0.1',
    port,
  });
  console.log(JSON.stringify({ event: 'hub.listening', origin: http.origin }));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await http.close();
    await app.close();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void close().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
} catch (error) {
  await app.close();
  throw error;
}
