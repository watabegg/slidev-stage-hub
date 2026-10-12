#!/usr/bin/env node
// Local-only authentication fixture; generates fake credentials, never user tokens.
import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createServer } from '@slidock/slidock/serve';
const [siteArgument, outArgument, portArgument = '4180', certArgument, keyArgument] =
  process.argv.slice(2);
if (!siteArgument || !outArgument || !!certArgument !== !!keyArgument)
  throw new Error(
    'usage: node apps/slive/scripts/serve-auth-fixture.mjs <site> <output-dir> [port=4180] [cert key]',
  );
const site = resolve(siteArgument),
  output = resolve(outArgument);
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
await mkdir(output, { recursive: true, mode: 0o700 });
const log = join(output, 'requests.ndjson'),
  credentialFile = join(output, 'credentials.json');
const router = createServer(site);
const listener = async (request, response) => {
  const expected = JSON.parse(await readFile(credentialFile, 'utf8'));
  const authorized = Object.entries(expected.headers).every(
    ([name, value]) => request.headers[name.toLowerCase()] === value,
  );
  await appendFile(
    log,
    JSON.stringify({
      method: request.method,
      path: new URL(request.url, expected.origin).pathname,
      authorized,
      tls: !!request.socket.encrypted,
      headerNames: Object.keys(request.headers),
    }) + '\n',
  );
  if (!authorized) {
    response.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('Fixture credentials required');
    return;
  }
  router.emit('request', request, response);
};
const callback = (req, res) => {
  listener(req, res).catch(() => {
    res.writeHead(500);
    res.end('Fixture failure');
  });
};
const server = certArgument
  ? https({ cert: await readFile(certArgument), key: await readFile(keyArgument) }, callback)
  : http(callback);
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const origin = `${certArgument ? 'https://localhost' : 'http://127.0.0.1'}:${server.address().port}`;
await writeFile(
  credentialFile,
  JSON.stringify(
    {
      origin,
      headers: {
        Authorization: `Bearer fixture-${randomBytes(16).toString('hex')}`,
        'CF-Access-Client-Id': `fixture-client-${randomBytes(8).toString('hex')}`,
        'CF-Access-Client-Secret': `fixture-secret-${randomBytes(16).toString('hex')}`,
      },
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
await writeFile(
  join(output, 'connection.json'),
  JSON.stringify({ origin, credentialFile, site }, null, 2) + '\n',
);
console.log(JSON.stringify({ origin, credentialFile, site }));
