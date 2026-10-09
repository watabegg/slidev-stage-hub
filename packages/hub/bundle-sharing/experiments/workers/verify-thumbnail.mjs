import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { artifactRoot, experiment } from './harness.mjs'

const origin = process.argv[2] || 'http://127.0.0.1:4180'
const { stdout } = await promisify(execFile)(process.execPath, [resolve(experiment, 'local-thumbnail.mjs'), origin, 'poc/demo'])
const capture = JSON.parse(stdout)
const response = await fetch(origin + capture.src)
assert.equal(response.status, 200)
const bytes = Buffer.from(await response.arrayBuffer())
assert.equal(bytes.readUInt32BE(16), 1200)
assert.equal(bytes.readUInt32BE(20), 675)
await writeFile(resolve(artifactRoot, 'thumbnail.png'), bytes)
const cached = await (await fetch(origin + '/api/thumbnail/poc%2Fdemo', { method: 'POST' })).json()
assert.equal(cached.status, 'cached')
const { chromium } = createRequire(resolve(process.env.SLIDEV_THEME_PATH || '/home/watabegg/slidev-watabegg', 'package.json'))('playwright-chromium')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  await page.goto(origin)
  const demoImage = page.locator('.deck').filter({ has: page.getByRole('link', { name: 'Workers compile PoC', exact: true }) }).locator('img')
  await demoImage.waitFor({ state: 'visible' })
  await demoImage.evaluate(img => img.decode())
  await page.screenshot({ path: resolve(artifactRoot, 'catalog.png') })
  await page.getByRole('link', { name: 'Workers compile PoC', exact: true }).click()
  await page.locator('.slidev-page[data-slidev-no="1"] h1').waitFor()
  await page.getByRole('link', { name: 'Slidev Lab の資料一覧へ戻る', exact: true }).click()
  await demoImage.waitFor({ state: 'visible' })
  const result = { ...capture, pngBytes: bytes.length, width: 1200, height: 675, cache: cached.status, catalogVisible: true, homeReturn: true }
  await writeFile(resolve(artifactRoot, 'thumbnail-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { await browser.close() }
