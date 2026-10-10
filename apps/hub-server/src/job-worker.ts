import {
  runPublicationJob,
  runPublicationJobCleanup,
  type HubServerOptions,
} from '@slidev-stage-hub/server';

export function startPublicationJobWorker(
  options: HubServerOptions,
  settings: {
    concurrency?: number;
    pollIntervalMs?: number;
    run?: typeof runPublicationJob;
    cleanup?: typeof runPublicationJobCleanup;
    onError?: () => void;
  } = {},
): { close(): Promise<void> } {
  if (!options.jobs) throw new Error('A publication job store is required');
  const concurrency = settings.concurrency ?? 2;
  const pollIntervalMs = settings.pollIntervalMs ?? 1000;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error('Job concurrency must be an integer from 1 to 16');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
    throw new Error('Job poll interval must be a positive integer');
  const controller = new AbortController();
  const run = settings.run ?? runPublicationJob;
  const cleanup = settings.cleanup ?? runPublicationJobCleanup;
  const wait = () =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, pollIntervalMs);
      controller.signal.addEventListener('abort', finish, { once: true });
      if (controller.signal.aborted) finish();
    });
  const loops = Array.from({ length: concurrency }, async () => {
    while (!controller.signal.aborted) {
      let worked = false;
      try {
        worked = await run(options, { signal: controller.signal });
      } catch {
        settings.onError?.();
      }
      if (!controller.signal.aborted) {
        try {
          worked = (await cleanup(options, { signal: controller.signal })) || worked;
        } catch {
          settings.onError?.();
        }
      }
      if (!worked && !controller.signal.aborted) await wait();
    }
  });
  return {
    async close() {
      controller.abort();
      await Promise.all(loops);
    },
  };
}
