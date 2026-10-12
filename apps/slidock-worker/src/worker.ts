import { createHubServer } from '@slidock/server';
import { createCloudflareOptions } from '@slidock/adapter-cloudflare';
import type { WorkerEnv } from './types.js';
import { DeckVersions } from './versions.js';

export { DeckVersions };

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return createHubServer(createCloudflareOptions(env)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
