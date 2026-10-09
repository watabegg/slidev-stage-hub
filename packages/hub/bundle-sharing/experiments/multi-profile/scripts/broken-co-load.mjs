import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../../../scripts/serve.mjs'

const experiment = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(experiment, '../../..')
const artifact = resolve(root, 'artifacts/multi-profile')
const out = resolve(artifact, 'browser')
await mkdir(out, { recursive: true })
const bSetup = await readFile(resolve(experiment, 'themes/b/setup/main.ts'), 'utf8')
const bCss = await readFile(resolve(experiment, 'themes/b/styles/style.css'), 'utf8')
const server = createServer(resolve(artifact, 'site'))
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const themePath = resolve(process.env.SLIDEV_THEME_PATH || '/home/watabegg/slidev-watabegg')
const { chromium } = createRequire(resolve(themePath, 'package.json'))('playwright-chromium')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 675 } })
  // Expose the router only. This is deliberately not the native host bridge:
  // there is no capture/interception layer to suppress competing theme keys.
  await context.addInitScript(() => { window.__nativeSlidevBridge = { experiment: 'router-only' } })
  const page = await context.newPage()
  await page.goto(origin + '/v53/a1/3')
  await page.locator('.slidev-page[data-slidev-no="3"]').waitFor({ state: 'visible' })
  const before = await page.evaluate(() => ({ themes: window.__hostileThemeInitializations, color: getComputedStyle(document.body).backgroundColor }))
  assert.deepEqual(before.themes, ['A'])
  assert.equal(before.color, 'rgb(163, 25, 40)')
  // Execute the actual synthetic B setup source and stylesheet alongside A.
  // Setup source is valid JS despite its .ts extension; generated/hash-named
  // production assets are never modified by this reproduction.
  await page.evaluate(async ({ setupSource, stylesheet }) => {
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)
    const url = URL.createObjectURL(new Blob([setupSource], { type: 'text/javascript' }))
    try { (await import(url)).default({ router: window.__slidevLabNative.router }) }
    finally { URL.revokeObjectURL(url) }
  }, { setupSource: bSetup, stylesheet: bCss })
  await page.keyboard.down('Enter')
  await page.waitForTimeout(150)
  const afterKeydown = new URL(page.url()).pathname
  await page.keyboard.up('Enter')
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => ({ themes: window.__hostileThemeInitializations, color: getComputedStyle(document.body).backgroundColor, consumers: window.__hostileKeyEvents, route: location.pathname, component: document.querySelector('[data-component-theme]')?.getAttribute('data-component-theme') }))
  assert.deepEqual(after.themes, ['A', 'B'])
  assert.equal(after.color, 'rgb(22, 76, 181)')
  for (const label of ['A', 'B']) for (const phase of ['keydown', 'keyup']) for (const target of ['window', 'document']) assert(after.consumers.some(event => event.label === label && event.phase === phase && event.target === target))
  const result = { status: 'expected-broken', reproduction: 'Theme A page with actual Theme B global CSS/setup source deliberately co-loaded; marker exposes router but provides no native key interception', before, afterKeydown, after, violations: ['A-selected page has B global color', 'Both A/B consume Enter on window/document capture in both phases'], isolatedProof: 'result.json covers8 decks with only selected theme active and foreign graph requests0' }
  await page.screenshot({ path: resolve(out, 'broken-co-load.png') })
  await writeFile(resolve(out, 'broken-co-load.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)) }
