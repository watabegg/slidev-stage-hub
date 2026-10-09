import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const artifactRoot = resolve(root, 'artifacts', process.env.SLIDEV_LAB_ARTIFACT_NAME || 'module-graph')
const graph = JSON.parse(await readFile(resolve(artifactRoot, 'chunk-graph.json'), 'utf8'))
const manifest = JSON.parse(await readFile(resolve(artifactRoot, 'site/manifest.json'), 'utf8'))
const owners = chunk => manifest.decks.filter(deck => chunk.modules.some(id => id.startsWith(`/@lab/decks/${deck.id}/`) || (id.includes(`/fixtures/${deck.id}/`) && !id.includes('/node_modules/')))).map(deck => deck.id)
const ownership = graph.filter(chunk => owners(chunk).length).map(chunk => ({ fileName: chunk.fileName, owners: owners(chunk), css: chunk.css, assets: chunk.assets }))
const collisions = ownership.filter(chunk => chunk.owners.length !== 1)
const canonicalClientModules = new Set(graph.flatMap(chunk => chunk.modules.filter(id => id.includes('/@slidev/client/') && !id.includes('?'))))
const canonicalThemeRoot = resolve(process.env.SLIDEV_THEME_PATH || process.env.SLIDEV_LAB_THEME || '/home/watabegg/slidev-watabegg') + '/'
const canonicalThemeModules = new Set(graph.flatMap(chunk => chunk.modules.filter(id => id.startsWith(canonicalThemeRoot) && !id.includes('/node_modules/') && !id.includes('?'))))
const result = { collisions, clientModuleCount: canonicalClientModules.size, themeModuleCount: canonicalThemeModules.size, ownership, notes: 'Only selected-deck metadata/Markdown/assets count as deck data. Generated import-glob modules below cache roots are shared setup infrastructure.' }
const browserPath = process.argv[2]
if (browserPath) {
  const browser = JSON.parse(await readFile(resolve(browserPath), 'utf8'))
  result.browserStatus = browser.status
  result.requests = browser.decks.map(deck => {
    const resources = deck.before.resources.filter(resource => new URL(resource.url).origin === browser.origin)
    const requested = new Set(resources.map(resource => new URL(resource.url).pathname.slice(1)))
    const unexpected = ownership.filter(chunk => requested.has(chunk.fileName) && chunk.owners.some(id => id !== deck.id))
    return { id: deck.id, unexpectedDeckChunks: unexpected, transferredBytes: resources.reduce((n, resource) => n + resource.transfer, 0), decodedBytes: resources.reduce((n, resource) => n + resource.decoded, 0), cachedResourceCount: resources.filter(resource => resource.transfer === 0 && resource.decoded > 0).length, requestedDeckChunks: ownership.filter(chunk => requested.has(chunk.fileName)) }
  })
}
await writeFile(resolve(artifactRoot, 'graph-analysis.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
if (collisions.length || result.requests?.some(row => row.unexpectedDeckChunks.length)) process.exitCode = 1
