import { createHubServer } from '@slidev-stage-hub/server';
import { createCloudflareOptions } from '@slidev-stage-hub/adapter-cloudflare';
import type { WorkerEnv } from './types.js';
import { DeckVersions } from './versions.js';

export { DeckVersions };

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return createHubServer(createCloudflareOptions(env)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
