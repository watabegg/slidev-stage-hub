import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../../../scripts/serve.mjs'

const experiment = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(experiment, '../../..')
const artifact = resolve(root, 'artifacts', process.env.SLIDEV_LAB_ARTIFACT_NAME || 'multi-profile')
const site = resolve(artifact, 'site')
const manifest = JSON.parse(await readFile(resolve(site, 'manifest.json')))
const out = resolve(artifact, 'browser')
await mkdir(out, { recursive: true })
const themePath = resolve(process.env.SLIDEV_THEME_PATH || '/home/watabegg/slidev-watabegg')
const { chromium } = createRequire(resolve(themePath, 'package.json'))('playwright-chromium')
const server = createServer(site)
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome' })
const results = []
const errors = []
const checks = []
async function visible(page, number) {
  await page.locator(`.slidev-page[data-slidev-no="${number}"]`).waitFor({ state: 'visible' })
}
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 675 } })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  await page.locator('.deck-card').first().waitFor()
  assert.equal(await page.locator('.deck-card').count(), manifest.decks.length)
  checks.push('Unified Vue catalog lists all profiles')
  for (const deck of manifest.decks) {
    const label = deck.profile.startsWith('a') ? 'A' : 'B'
    await page.goto(origin + deck.entry.replace(/1$/, '3'))
    await visible(page, 3)
    const state = await page.evaluate(() => ({ themes: window.__hostileThemeInitializations, runtime: document.querySelector('meta[property="slidev:version"]')?.content, component: document.querySelector('.slidev-page[data-slidev-no="3"] [data-component-theme]')?.getAttribute('data-component-theme'), color: getComputedStyle(document.body).backgroundColor, native: typeof window.__slidevLabNative, resources: performance.getEntriesByType('resource').map(r => r.name) }))
    assert.deepEqual(state.themes, [label])
    assert.equal(state.component, label)
    assert.equal(state.runtime, deck.runtimeVersion)
    assert.equal(state.native, 'undefined')
    assert.equal(state.color, label === 'A' ? 'rgb(163, 25, 40)' : 'rgb(22, 76, 181)')
    const foreign = state.resources.filter(url => url.includes('/_profiles/') && !url.includes(`/_profiles/${deck.group}/`))
    assert.deepEqual(foreign, [])
    const graph = JSON.parse(await readFile(resolve(artifact, 'groups', deck.group, 'chunk-graph.json')))
    const requested = new Set(state.resources.map(url => new URL(url).pathname.replace(`/_profiles/${deck.group}/`, '')))
    const loadedClientModules = graph.filter(c => requested.has(c.fileName)).flatMap(c => c.modules).filter(id => id.includes('/@slidev/client/') && !id.includes('?'))
    assert(loadedClientModules.length > 0)
    assert(loadedClientModules.every(id => id.includes(`@slidev+client@${deck.runtimeVersion}_`)))
    await page.keyboard.down('Enter')
    await visible(page, label === 'A' ? 4 : 2)
    await page.keyboard.up('Enter')
    await visible(page, label === 'A' ? 5 : 1)
    const consumers = await page.evaluate(() => window.__hostileKeyEvents)
    for (const phase of ['keydown', 'keyup']) for (const target of ['window', 'document']) assert(consumers.some(event => event.label === label && event.phase === phase && event.target === target))
    results.push({ id: deck.id, runtimeVersion: state.runtime, theme: label, loadedClientModules: loadedClientModules.length, foreignGroups: foreign, enter: label === 'A' ? '3 →4 keydown →5 keyup' : '3 →2 keydown →1 keyup', consumers })
    if (deck.id.endsWith('1')) await page.screenshot({ path: resolve(out, `${deck.id.replaceAll('/', '-')}.png`) })
  }
  checks.push('Both versions use their actual client modules', 'Same-named layout/component and global CSS stay within selected theme', 'Browser Enter preserves opposite theme semantics in both event phases', 'Full-document deck switches request no other group graph')
  const one = manifest.decks.find(deck => deck.id === 'v53/a1')
  const two = manifest.decks.find(deck => deck.id === 'v53/a2')
  const other = await context.newPage()
  await page.goto(origin + one.entry.replace(/1$/, '3'))
  await other.goto(origin + two.entry.replace(/1$/, '3'))
  await visible(page, 3)
  await visible(other, 3)
  await page.keyboard.down('Enter')
  await visible(page, 4)
  await page.keyboard.up('Enter')
  await visible(page, 5)
  await other.waitForTimeout(350)
  assert(await other.locator('.slidev-page[data-slidev-no="3"]').isVisible())
  checks.push('Duplicate titles do not synchronize distinct deck IDs')
  const native = await browser.newContext()
  await native.addInitScript(() => { window.__nativeSlidevBridge = { experiment: true } })
  const nativePage = await native.newPage()
  for (const deck of manifest.decks.filter(deck => deck.id.endsWith('1'))) {
    await nativePage.goto(origin + deck.entry)
    await visible(nativePage, 1)
    assert(await nativePage.evaluate(() => Array.isArray(window.__slidevLabNative.slides) && window.__slidevLabNative.slides.every(slide => typeof slide.load === 'function')))
    await nativePage.evaluate(async () => { await window.__slidevLabNative.slides[2].load(); await window.__slidevLabNative.router.replace('/3') })
    await visible(nativePage, 3)
  }
  checks.push('Marker-only native router/slides array works in all four theme/version profiles')
  assert.deepEqual(errors, [])
  await writeFile(resolve(out, 'result.json'), JSON.stringify({ status: 'pass', checks, errors, results }, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'pass', checks, decks: results.length }, null, 2))
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)) }
