import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { startHarness, artifactRoot, experiment } from './harness.mjs'
await mkdir(artifactRoot, { recursive: true })
const directory = await mkdtemp(resolve(artifactRoot, 'stress-'))
const settings = { persist: true, statePath: resolve(directory, 'state'), workerPath: resolve(directory, 'worker.mjs') }
let harness = await startHarness(settings)
const checks = [], timings = []
const check = (name, value) => { checks.push({ name, passed: Boolean(value) }); console.log(value ? 'PASS' : 'FAIL', name) }
const publish = async (id, markdown, assets = {}) => {
  const start = performance.now()
  const response = await fetch(`${harness.origin}/api/decks/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown, assets }) })
  const data = await response.json()
  timings.push({ id, status: response.status, wallMs: Math.round(performance.now() - start), cached: data.cached })
  return { status: response.status, ...data }
}
const current = async id => (await fetch(`${harness.origin}/api/decks/${encodeURIComponent(id)}`)).json()
try {
  const initial = await publish('stress/same', '# Initial\n\nStable version')
  check('initial publication succeeds', initial.status === 200)
  for (const [name, source] of [
    ['script', '<script>throw new Error()</script>'],
    ['unknown component', '<MissingComponent />'],
    ['unknown layout', '---\nlayout: missing\n---\n# Unknown'],
    ['unknown theme', '---\ntheme: never-installed\n---\n# Unknown'],
    ['101 pages', Array.from({length:101},(_,i)=>`# Page ${i}`).join('\n\n---\n\n')],
    ['oversized request', '# Too big\n' + 'x'.repeat(512*1024)],
    ['invalid YAML', '---\ntitle: [\n---\n# Bad YAML'],
  ]) {
    const result = await publish('stress/same', source)
    check(`${name} rejected and old publication retained`, result.status === 400 && (await current('stress/same')).revision === initial.revision)
  }
  const raced = await Promise.all(Array.from({length:12}, (_,index) => publish('stress/same', `# Concurrent ${index}\n\n` + Array.from({length:12},(_,i)=>`## Item ${i}\n\n- ${index}-${i}`).join('\n'))))
  const raceCurrent = await current('stress/same')
  check('concurrent responses are published or superseded', raced.every(r=>[200,409].includes(r.status)))
  check('current revision belongs to a successful concurrent publication', raced.some(r=>r.status===200&&r.revision===raceCurrent.revision))
  const allVersions = await Promise.all(raced.map(r=>fetch(harness.origin+r.slides[0].module)))
  check('all concurrent generated revisions remain readable', allVersions.every(r=>r.status===200))
  const final = await publish('stress/same', '# Final after contention')
  check('explicit later update becomes current', final.status===200 && (await current('stress/same')).revision===final.revision)
  const duplicates = await Promise.all(Array.from({length:8},()=>publish('stress/same','# Final after contention')))
  check('concurrent identical updates preserve same immutable revision', duplicates.every(r=>r.revision===final.revision&&r.cached) && (await current('stress/same')).revision===final.revision)
  const svg = color => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${color}"/></svg>`
  const assetText = '# Same asset path\n\n![image](./assets/same.svg)'
  const pairs = await Promise.all(['red','blue'].map(color=>publish(`isolation/${color}`,assetText,{'assets/same.svg':svg(color)})))
  const modules = await Promise.all(pairs.map(async r=>(await fetch(harness.origin+r.slides[0].module)).text()))
  check('same relative asset path is isolated across decks', modules[0]!==modules[1])
  check('asset is scoped to its deck revision', (await(await fetch(harness.origin+`/releases/isolation/red/${pairs[0].revision}/assets/assets/same.svg`)).text()).includes('fill="red"'))
  const sortedA = await publish('assets/order','# Order',{'a.svg':svg('red'),'b.svg':svg('blue')})
  const sortedB = await publish('assets/order','# Order',{'b.svg':svg('blue'),'a.svg':svg('red')})
  check('asset map insertion order does not change revision',sortedA.revision===sortedB.revision && sortedB.cached)
  for(let batch=0;batch<5;batch++) await Promise.all(Array.from({length:4},(_,i)=>publish(`catalog/deck-${batch*4+i}`,`# 資料 ${batch*4+i}\n\n日本語 🦆`)))
  const catalog=await(await fetch(harness.origin+'/api/catalog')).json()
  check('catalog lists every independently published deck',catalog.decks.length===24 && !catalog.truncated)
  const oldBytes=await(await fetch(harness.origin+initial.slides[0].module)).text()
  const profile=harness.profileDigest
  await harness.mf.dispose()
  harness=await startHarness(settings)
  check('restart preserves runtime/compiler identity',harness.profileDigest===profile)
  check('restart preserves current revision',(await current('stress/same')).revision===final.revision)
  check('restart preserves old revision bytes',(await(await fetch(harness.origin+initial.slides[0].module)).text())===oldBytes)
  check('restart preserves catalog',(await(await fetch(harness.origin+'/api/catalog')).json()).decks.length===24)
  const result={scope:'Local workerd, R2 and SQLite DO; real HTTP concurrency and persisted restart',checks,timings,concurrentStatuses:raced.map(r=>r.status),failed:checks.filter(c=>!c.passed)}
  await writeFile(resolve(experiment,'results/stress.json'),JSON.stringify(result,null,2)+'\n')
  assert.equal(result.failed.length,0,JSON.stringify(result.failed))
} finally { await harness.mf.dispose(); await rm(directory,{recursive:true,force:true}) }
