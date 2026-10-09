#!/usr/bin/env node
// Local HTTPS fixture using the same read-only routing as the ordinary server.
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { createServer } from '../../../packages/hub/scripts/serve.mjs'

const [site, certificate, key, portArgument = '4179'] = process.argv.slice(2)
if (!site || !certificate || !key)
  throw new Error('usage: node apps/stage/scripts/serve-https.mjs <site> <certificate.pem> <key.pem> [port=4179]')
const port = Number(portArgument)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port')
const router = createServer(site)
const server = createHttpsServer({ cert: readFileSync(certificate), key: readFileSync(key) },
  (request, response) => router.emit('request', request, response))
server.listen(port, '127.0.0.1', () => console.log(`Serving ${site} at https://localhost:${server.address().port}/`))
