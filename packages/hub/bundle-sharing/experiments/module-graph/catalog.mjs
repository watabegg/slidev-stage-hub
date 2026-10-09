import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'

const excludedDirectories = new Set(['node_modules', 'assets', 'public'])
const excludedDocuments = new Set(['README.md', 'AGENTS.md'])
const publicFields = ['title', 'subtitle', 'author', 'date', 'description', 'tags']
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0
const reserved = /[\u0000-\u001f\u007f\\:?#[\]@!$&'()*+,;=%]/u

export const encodeDeckPath = id => id.split('/').map(encodeURIComponent).join('/')

/** Discover independent Markdown entries without traversing generated assets. */
export async function discoverDecks(fixturesRoot) {
  const root = resolve(fixturesRoot)
  const discovered = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !excludedDirectories.has(entry.name)) await visit(path)
      } else if (entry.isFile() && extname(entry.name) === '.md' && !excludedDocuments.has(entry.name)) {
        const source = relative(root, path).split(sep).join('/')
        const stem = source.slice(0, -3)
        const id = basename(stem) === 'slides' && dirname(stem) !== '.' ? dirname(stem) : stem
        if (id.split('/').some(segment => !segment || segment === '.' || segment === '..' || reserved.test(segment))) {
          throw new Error(`Invalid deck id "${id}" from ${path}: use names without URL-reserved characters`)
        }
        discovered.push({ id, entry: path, categoryPath: id.split('/').slice(0, -1) })
      }
    }
  }
  await visit(root)
  discovered.sort((left, right) => compare(left.id, right.id))
  if (!discovered.length) throw new Error(`No Slidev decks found in ${root}`)
  const byId = new Map()
  for (const deck of discovered) {
    const previous = byId.get(deck.id)
    if (previous) throw new Error(`Duplicate deck id "${deck.id}": ${previous.entry} and ${deck.entry}`)
    byId.set(deck.id, deck)
  }
  return discovered
}

/** Clone only plain JSON data; omit unsupported values and undefined fields. */
function plainJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object' || ancestors.has(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return undefined
  const branch = new Set(ancestors).add(value)
  if (Array.isArray(value)) return value.map(item => plainJson(item, branch)).filter(item => item !== undefined)
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const cloned = plainJson(item, branch)
    return cloned === undefined ? [] : [[key, cloned]]
  }))
}

/** Headmatter is private by default; only these presentation fields are public. */
export function publicFrontmatter(headmatter) {
  return Object.fromEntries(publicFields.flatMap(key => {
    const value = plainJson(headmatter?.[key])
    return value === undefined ? [] : [[key, value]]
  }))
}

export function categoriesForDecks(decks) {
  const categories = new Map()
  for (const deck of decks) {
    for (let count = 1; count <= deck.categoryPath.length; count++) {
      const path = deck.categoryPath.slice(0, count)
      const id = path.join('/')
      categories.set(id, { id, name: path.at(-1), path, parentId: count === 1 ? null : path.slice(0, -1).join('/') })
    }
  }
  return [...categories.values()].sort((left, right) => compare(left.id, right.id))
}
