import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { startHarness, artifactRoot, experiment } from './harness.mjs'

const apiOnly = process.argv.includes('--api-only')
async function runtimeHash() {
  const site = resolve(artifactRoot, 'site')
  const files = (await readdir(site, { recursive: true, withFileTypes: true })).filter(file => file.isFile()).map(file => resolve(file.parentPath, file.name)).sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(file.slice(site.length)).update(await readFile(file))
  return hash.digest('hex')
}
const beforeRuntimeHash = apiOnly ? null : await runtimeHash()
const markdown = await readFile(resolve(experiment, 'fixtures/deck.md'), 'utf8')
const assets = JSON.parse(await readFile(resolve(experiment, 'fixtures/assets.json'), 'utf8'))
const { mf, origin, workerBytes, profileDigest } = await startHarness()
const checks = [], timings = [], errors = []
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS', label) }
const publish = async (text, id = 'poc/demo', suppliedAssets = assets) => {
  const started = performance.now()
  const response = await fetch(`${origin}/api/decks/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown: text, assets: suppliedAssets }) })
  const result = await response.json()
  timings.push({ status: response.status, wallMs: performance.now() - started, cached: result.cached })
  return { response, result }
}
const current = async (id = 'poc/demo') => (await fetch(`${origin}/api/decks/${encodeURIComponent(id)}`)).json()
let browser
try {
  const first = await publish(markdown)
  assert.equal(first.response.status, 200, JSON.stringify(first.result))
  const original = first.result
  check('workerd compiles all five pages', original.slides.length === 5)
  check('title and actual theme metadata retained', original.title === 'Workers compile PoC' && original.frontmatter.theme === 'watabegg')
  const source = await (await fetch(origin + original.slides[2].module)).text()
  const css = await (await fetch(origin + original.slides[2].css)).text()
  check('generated ESM uses shared runtime', source.includes('/_runtime/vue.js') && source.includes('/_runtime/bridge.js'))
  check('new UnoCSS and scoped styles generated', css.includes('fuchsia') && css.includes('data-v-'))
  check('private presenter note absent', !JSON.stringify(original).includes('PRIVATE_PRESENTER_NOTE') && !source.includes('PRIVATE_PRESENTER_NOTE'))
  const image = original.slides[3].frontmatter.images[0].src
  check('relative component image resolves to revision asset', image.startsWith(`/releases/poc/demo/${original.revision}/assets/`) && (await fetch(origin + image)).status === 200)
  const repeat = await publish(markdown)
  check('identical source reuses revision artifacts', repeat.result.cached && repeat.result.revision === original.revision)
  const failed = await publish(markdown + '\n<script>alert("unsupported")</script>')
  check('unsupported source fails without changing published version', failed.response.status === 400 && (await current()).revision === original.revision)
  const unknown = await publish('# Unknown component\n\n<NeverRegisteredComponent />')
  check('unregistered theme component is rejected', unknown.response.status === 400 && (await current()).revision === original.revision)
  const thumb = await fetch(`${origin}/api/thumbnail/poc%2Fdemo`, { method: 'POST' })
  check('missing Browser Run returns explicit fallback status', thumb.status === 503 && (await thumb.json()).status === 'unavailable')
  const bucket = await mf.getR2Bucket('FILES')
  check('source is stored privately', Boolean(await bucket.head(`private/poc/demo/${original.revision}.json`)))
  check('private source is not a public route', !(await (await fetch(origin + `/private/poc/demo/${original.revision}.json`)).text()).includes('PRIVATE_PRESENTER_NOTE'))
  const namespace = await mf.getDurableObjectNamespace('VERSIONS')
  const coordinator = namespace.get(namespace.idFromName('coordination-test'))
  const earlier = await coordinator.begin()
  const later = await coordinator.begin()
  check('latest publication commits', await coordinator.commit(later, { revision: 'latest' }))
  check('late completion cannot roll current backwards', !(await coordinator.commit(earlier, { revision: 'earlier' })) && (await coordinator.current()).revision === 'latest')

  let page
  if (!apiOnly) {
    const themePath = resolve(process.env.SLIDEV_THEME_PATH || '/home/watabegg/slidev-watabegg')
    const require = createRequire(resolve(themePath, 'package.json'))
    const { chromium } = require('playwright-chromium')
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome', headless: true })
    page = await browser.newPage({ viewport: { width: 1200, height: 675 } })
    page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message) })
    page.on('console', msg => { if (msg.type() === 'error') { errors.push(msg.text()); console.error('BROWSER', msg.text()) } })
    await page.goto(origin + original.entry)
    await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('.slidev-page[data-slidev-no="1"]').getByRole('heading', { name: 'Workers compile PoC', exact: true }).waitFor()
    check('real Slidev cover renders Worker output', (await page.locator('.slidev-page[data-slidev-no="1"]').innerText()).includes('Workers compile PoC'))
    await page.keyboard.press('Enter')
    await page.locator('.slidev-page[data-slidev-no="2"]').waitFor({ state: 'visible' })
    await page.locator('.slidev-page[data-slidev-no="2"]').getByRole('heading', { name: 'Runtime reuse', exact: true }).waitFor()
    check('theme Enter shortcut advances once to section layout', new URL(page.url()).pathname.endsWith('/2'))
    await page.keyboard.press('Enter')
    await page.locator('.slidev-page[data-slidev-no="3"]').waitFor({ state: 'visible' })
    const clickOne = page.locator('.slidev-page[data-slidev-no="3"] [data-testid="click-one"]')
    await clickOne.waitFor({ state: 'attached' })
    check('v-click initially hidden', await clickOne.evaluate(el => getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).opacity === '0'))
    await page.keyboard.press('Enter')
    await page.waitForTimeout(350)
    check('v-click revealed without changing slide', new URL(page.url()).pathname.endsWith('/3') && await clickOne.evaluate(el => getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0'))
    check('generated UnoCSS applies in browser', await clickOne.evaluate(el => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'))
    check('scoped CSS applies', await page.locator('.slidev-page[data-slidev-no="3"] .scoped-probe').evaluate(el => getComputedStyle(el).borderTopWidth === '3px'))
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.locator('.slidev-page[data-slidev-no="4"]').waitFor({ state: 'visible' })
    await page.locator('.slidev-page[data-slidev-no="4"] img').first().waitFor()
    check('prebuilt FigureGrid loads revision image', await page.locator('.slidev-page[data-slidev-no="4"] img').first().evaluate(async el => { await el.decode(); return el.naturalWidth === 600 }))
    await page.screenshot({ path: resolve(artifactRoot, 'figure-grid.png') })
    check('router preserves pinned revision', new URL(page.url()).searchParams.get('revision') === original.revision)
  }

  const changed = await publish(markdown.replaceAll('Workers compile PoC', 'Updated without runtime build'))
  check('MD update creates and publishes a new revision', changed.response.status === 200 && changed.result.revision !== original.revision && (await current()).revision === changed.result.revision)
  check('old revision remains retrievable', (await fetch(origin + original.slides[0].module)).status === 200)
  check('old manifest remains pinned', (await (await fetch(`${origin}/api/decks/poc%2Fdemo?revision=${original.revision}`)).json()).title === original.title)
  const changedImage = await publish(markdown, 'poc/demo', { ...assets, 'diagram.svg': assets['diagram.svg'].replace('#132a36', '#254838') })
  check('asset-only change changes revision', changedImage.result.revision !== original.revision)
  const added = await publish('# A new deck after runtime build', 'poc/added', {})
  check('new deck added without runtime rebuild', added.response.status === 200 && (await (await fetch(origin + '/api/catalog')).json()).decks.length === 2)
  if (page) {
    await page.reload()
    await page.locator('.slidev-page[data-slidev-no="4"]').waitFor({ state: 'visible' })
    check('open session still uses original revision after publication', new URL(page.url()).searchParams.get('revision') === original.revision)
    await page.goto(origin + changed.result.entry)
    await page.locator('.slidev-page[data-slidev-no="1"]').waitFor({ state: 'visible' })
    await page.locator('.slidev-page[data-slidev-no="1"]').getByRole('heading', { name: 'Updated without runtime build', exact: true }).waitFor()
    check('new version rendered by same prebuilt runtime', (await page.locator('.slidev-page[data-slidev-no="1"]').innerText()).includes('Updated without runtime build'))
    await page.screenshot({ path: resolve(artifactRoot, 'updated-cover.png') })
    check('no browser runtime exceptions', errors.length === 0)
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(resource => resource.name))
    check('browser downloads no compiler', !resources.some(url => /compiler-sfc|compiler-dom|worker\.mjs|unocss\/core/.test(url)))
    check('runtime files unchanged across publication and new deck', beforeRuntimeHash === await runtimeHash())
  }
  await mkdir(artifactRoot, { recursive: true })
  await writeFile(resolve(artifactRoot, apiOnly ? 'api-results.json' : 'verification.json'), JSON.stringify({ runtime: 'workerd', profileDigest, workerBytes, checks, timings, timingMeaning: 'Node-measured HTTP wall time, not Worker CPU time', errors }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, workerBytes, timings }))
} finally {
  await browser?.close()
  await mf.dispose()
}
