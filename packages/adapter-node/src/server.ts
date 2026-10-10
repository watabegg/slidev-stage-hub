import { serve } from '@hono/node-server';
import type { Server } from 'node:http';

export interface StartHubServerOptions {
  server: { fetch(request: Request): Promise<Response> };
  host?: string;
  port?: number;
}

export interface RunningHubServer {
  origin: string;
  close(): Promise<void>;
}

export async function startHubServer({
  server: handler,
  host = '127.0.0.1',
  port = 4180,
}: StartHubServerOptions): Promise<RunningHubServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('port must be an integer from 0 to 65535');
  }

  const listener = serve({
    fetch: handler.fetch.bind(handler),
    hostname: host,
    port,
  }) as Server;

  try {
    await new Promise<void>((resolve, reject) => {
      if (listener.listening) {
        resolve();
        return;
      }
      const onError = (error: Error) => {
        listener.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        listener.off('error', onError);
        resolve();
      };
      listener.once('error', onError);
      listener.once('listening', onListening);
    });
  } catch (error) {
    try {
      listener.close();
    } catch {
      // A failed listen may already leave the server closed.
    }
    throw error;
  }

  const address = listener.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    throw new Error('Node server did not expose a TCP address');
  }

  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  let closed = false;
  return {
    origin: `http://${displayHost}:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
