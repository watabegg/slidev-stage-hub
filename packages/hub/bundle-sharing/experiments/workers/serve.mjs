import { startHarness } from './harness.mjs'

const { mf, origin, profileDigest, workerBytes } = await startHarness({ port: Number(process.env.PORT || 4180), persist: true })
console.log(JSON.stringify({ origin, profileDigest, workerBytes, runtime: 'workerd', storage: 'local R2 and SQLite Durable Objects', browserRun: 'unbound' }))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await mf.dispose(); process.exit(0) })
