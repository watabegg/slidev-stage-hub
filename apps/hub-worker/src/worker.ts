import { errorResponse } from './errors.ts';
import type { WorkerEnv } from './types.ts';
import { handleRequest } from './worker-handler.ts';
import { DeckVersions } from './versions.ts';

export { DeckVersions };

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;
