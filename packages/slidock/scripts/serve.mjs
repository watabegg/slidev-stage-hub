import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createServerService } from '../dist/node/internal/serve.mjs';

export function createServer(siteRoot) {
  return createServerService(resolve(siteRoot));
}

function main() {
  const [siteRootArgument, portArgument] = process.argv.slice(2);
  if (!siteRootArgument) throw new Error('usage: node scripts/serve.mjs <site-root> [port=4173]');
  const siteRoot = resolve(siteRootArgument);
  if (!existsSync(siteRoot)) throw new Error('site root does not exist: ' + siteRoot);
  const port = portArgument === undefined ? 4173 : Number(portArgument);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('invalid port: ' + portArgument);

  const server = createServer(siteRoot);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    console.log('Serving ' + siteRoot + ' at http://127.0.0.1:' + address.port + '/');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
