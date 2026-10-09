import { createSlideRoutes } from './routes'
import { showCatalog } from './catalog'
import { deckBase, deckId } from '/@lab/selection'
import baseConfig from '/@lab/base-config'

type DeckManifest = {
  id: string
  revision: string
  title?: string
  frontmatter?: Record<string, any>
  slides: Array<{ no: number, frontmatter?: Record<string, unknown>, module: string, css?: string }>
}

const runtimeOnlyConfig = [
  'title',
  'titleTemplate',
  'author',
  'keywords',
  'info',
  'seoMeta',
  'themeConfig',
  'lang',
]

function mergeConfig(manifest: DeckManifest) {
  const config = { ...baseConfig }
  const source = manifest.frontmatter || {}
  for (const key of runtimeOnlyConfig) {
    if (source[key] !== undefined)
      config[key] = source[key]
  }
  config.themeConfig = {
    ...(baseConfig.themeConfig || {}),
    ...(source.themeConfig || {}),
  }
  config.title = manifest.title || source.title || 'Slidev'
  const titleTemplate = typeof config.titleTemplate === 'string' ? config.titleTemplate : '%s - Slidev'
  config.slidesTitle = titleTemplate.replace('%s', String(config.title))
  config.htmlAttrs = source.lang ? { ...config.htmlAttrs, lang: source.lang } : config.htmlAttrs
  return config
}

function pinRevision(revision: string) {
  const url = new URL(location.href)
  if (url.searchParams.get('revision') === revision)
    return
  url.searchParams.set('revision', revision)
  history.replaceState(history.state, '', url)
}

function addCatalogLink() {
  if (new URLSearchParams(location.search).get('labThumbnail') === 'true')
    return
  const link = document.createElement('a')
  link.href = '/'
  link.textContent = '資料一覧へ'
  link.setAttribute('aria-label', 'Slidev Lab の資料一覧へ戻る')
  link.style.cssText = 'position:fixed;z-index:10000;top:12px;right:12px;padding:8px 12px;border-radius:999px;background:#132a36;color:#fff;font:600 13px/1.2 system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 10px #0003'
  document.body.append(link)
}

async function boot() {
  if (!deckId) {
    await showCatalog()
    return
  }

  const requestedRevision = new URL(location.href).searchParams.get('revision')
  const query = requestedRevision ? `?revision=${encodeURIComponent(requestedRevision)}` : ''
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}${query}`, { cache: 'no-store' })
  if (!response.ok)
    throw new Error(`Deck ${deckId} is unavailable (${response.status})`)
  const manifest = await response.json() as DeckManifest
  if (manifest.id !== deckId || !manifest.revision || !Array.isArray(manifest.slides))
    throw new Error(`Deck manifest for ${deckId} is invalid`)
  if (requestedRevision && manifest.revision !== requestedRevision)
    throw new Error(`Requested revision ${requestedRevision} does not match the returned deck revision`)

  pinRevision(manifest.revision)
  addCatalogLink()
  ;(window as any).__slidevLabData = {
    configs: mergeConfig(manifest),
    slides: createSlideRoutes(manifest),
  }
  ;(window as any).__workersPoc = { id: deckId, revision: manifest.revision, deckBase }

  // Config/slides facades are read synchronously when Slidev's client is
  // evaluated, so publish the manifest before importing the real app.
  await import('@slidev/client/main.ts')
}

function showError(error: unknown) {
  console.error('[slidev-workers] startup failed', error)
  const container = document.createElement('pre')
  container.setAttribute('role', 'alert')
  container.style.cssText = 'margin:2rem;padding:1rem;white-space:pre-wrap;color:#8a1024;background:#fff4f4;border:1px solid #df9aa5'
  container.textContent = `Slidev could not load this deck.\n${error instanceof Error ? error.message : String(error)}`
  document.body.replaceChildren(container)
}

void boot().catch(showError)
