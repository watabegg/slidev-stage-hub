import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const experiment = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(experiment, '../../..')
const theme = process.env.SLIDEV_THEME_PATH || process.env.SLIDEV_LAB_THEME || '/home/watabegg/slidev-watabegg'
const store = join(theme, 'node_modules/.pnpm')
const candidates = (await readdir(store)).filter(name => name.startsWith('@slidev+cli@52.15.2_')).sort()
if (candidates.length !== 1) throw new Error(`Expected one installed CLI52.15.2 variant in ${store}; found ${candidates.length}`)
const cli = join(store, candidates[0], 'node_modules/@slidev/cli')
const client = resolve(cli, '../client')
const dependencyRoot = resolve(root, 'artifacts/dependencies/slidev52')
await mkdir(join(dependencyRoot, 'node_modules/@slidev'), { recursive: true })
for (const [name, source] of [['cli', cli], ['client', client]]) {
  try { await symlink(source, join(dependencyRoot, 'node_modules/@slidev', name), 'dir') }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@slidev/cli': '52.15.2', '@slidev/client': '52.15.2' } }, null, 2) + '\n')
await writeFile(join(dependencyRoot, 'store-provenance.json'), JSON.stringify({ source: 'existing local theme pnpm store (no package installation)', cli, client, packageHashes: await Promise.all([cli, client].map(async directory => ({ directory, sha256: createHash('sha256').update(await readFile(join(directory, 'package.json'))).digest('hex') }))), themeLockSha256: createHash('sha256').update(await readFile(join(theme, 'pnpm-lock.yaml'))).digest('hex') }, null, 2) + '\n')
console.log(JSON.stringify({ dependencyRoot, cli, client }, null, 2))
