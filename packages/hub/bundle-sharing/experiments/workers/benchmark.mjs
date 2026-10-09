import { performance } from 'node:perf_hooks'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { startHarness, artifactRoot } from './harness.mjs'

const { mf, origin, workerBytes } = await startHarness()
const measurements = []
try {
  for (const pages of [5, 50, 100]) {
    const markdown = Array.from({ length: pages }, (_, i) => `# Page ${i + 1}\n\n<div v-click class="bg-indigo-600 text-white p-4">Click ${i + 1}</div>\n\n- One\n- Two`).join('\n\n---\n\n')
    for (const phase of ['compile', 'cached']) {
      const start = performance.now()
      const response = await fetch(`${origin}/api/decks/bench-${pages}`, { method: 'POST', body: JSON.stringify({ markdown }) })
      const result = await response.json()
      if (!response.ok) throw new Error(JSON.stringify(result))
      measurements.push({ pages, phase, wallMs: performance.now() - start, cached: result.cached })
    }
  }
  const result = {
    environment: 'Local Miniflare/workerd; synthetic heading/list/v-click decks',
    timingMeaning: 'HTTP wall time including local R2/DO I/O; not production CPU usage or peak memory',
    workerBytes, workerGzipBytes: gzipSync(await readFile(resolve(artifactRoot, 'worker.mjs'))).length,
    measurements,
  }
  await writeFile(resolve(artifactRoot, 'benchmark.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally { await mf.dispose() }
