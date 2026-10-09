import { DurableObject } from 'cloudflare:workers'
import { compileDeck } from './compiler.mjs'
import { captureThumbnail, validatePng } from './thumbnail.mjs'

const encoder = new TextEncoder()
const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
const validId = id => /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(id)
const validRevision = revision => /^[a-f0-9]{64}$/.test(revision || '')
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('')
}
async function mutationAuth(request, env) {
  if (!env.PUBLISH_TOKEN) {
    const hostname = new URL(request.url).hostname
    if (env.LOCAL_MUTATIONS === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return null
    return json({ error: 'Publishing API disabled' }, 403)
  }
  const supplied = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
  if (!supplied || supplied.length > 512) return json({ error: 'Authentication required' }, 401)
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(env.PUBLISH_TOKEN)),
  ])
  return crypto.subtle.timingSafeEqual(actual, expected) ? null : json({ error: 'Authentication required' }, 401)
}

async function boundedBody(request, limit) {
  if (!request.body) return new Uint8Array()
  const chunks = []; let size = 0
  const reader = request.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) { await reader.cancel(); throw new Error('Request is too large') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

// Only metadata coordination runs in this DO. Compilation and R2 I/O do not
// hold blockConcurrencyWhile across network calls.
export class DeckVersions extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, current TEXT)')
    ctx.storage.sql.exec('INSERT OR IGNORE INTO state VALUES (1, 0, NULL)')
  }
  begin() {
    this.ctx.storage.sql.exec('UPDATE state SET generation = generation + 1 WHERE id = 1')
    return this.ctx.storage.sql.exec('SELECT generation FROM state WHERE id = 1').one().generation
  }
  current() {
    const value = this.ctx.storage.sql.exec('SELECT current FROM state WHERE id = 1').one().current
    return value ? JSON.parse(value) : null
  }
  commit(generation, manifest) {
    const row = this.ctx.storage.sql.exec('SELECT generation FROM state WHERE id = 1').one()
    if (row.generation !== generation) return false
    this.ctx.storage.sql.exec('UPDATE state SET current = ? WHERE id = 1', JSON.stringify(manifest))
    return true
  }
}

async function putArtifacts(bucket, objects) {
  // R2 round trips dominate remote publication time. Keep at most six writes
  // in flight and only publish the manifest after every artifact succeeded.
  for (let offset = 0; offset < objects.length; offset += 6) {
    const batch = await Promise.allSettled(objects.slice(offset, offset + 6).map(([key, value, options]) => bucket.put(key, value, options)))
    const failure = batch.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}

async function publish(request, env, id) {
  const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 512 * 1024)))
  if (typeof input.markdown !== 'string' || !input.markdown.trim()) throw new Error('markdown is required')
  // Small text assets are enough for the initial PoC. Binary asset ingestion is
  // intentionally separate from the source format rather than silently decoded.
  const assets = input.assets || {}
  if (typeof assets !== 'object' || Array.isArray(assets)) throw new Error('assets must be a filename/content object')
  for (const [name, value] of Object.entries(assets)) {
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(svg|txt|css)$/.test(name) || typeof value !== 'string') throw new Error('Unsupported asset')
  }
  const orderedAssets = Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b)))
  const revision = await digest(JSON.stringify([env.PROFILE_DIGEST, input.markdown, orderedAssets]))
  const versions = env.VERSIONS.getByName(id)
  const generation = await versions.begin()
  const prefix = `releases/${id}/${revision}`
  const existing = await env.FILES.get(`${prefix}/manifest.json`)
  let manifest
  if (existing) manifest = await existing.json()
  else {
    const result = await compileDeck({ markdown: input.markdown, deckId: id, assetBase: `/${prefix}/assets/` })
    if (result.slides.length > 100) throw new Error('PoC supports at most 100 slides')
    if (result.frontmatter.theme && !['watabegg', 'slidev-theme-watabegg'].includes(result.frontmatter.theme)) throw new Error('This PoC has only the prebuilt watabegg theme profile')
    const layouts = new Set(JSON.parse(env.PROFILE_LAYOUTS || '["cover","default","section"]'))
    const components = new Set(['LabSlideLayout', ...JSON.parse(env.PROFILE_COMPONENTS || '["FigureGrid"]')].map(name => name.replace(/-/g, '').toLowerCase()))
    for (const slide of result.slides) {
      const layout = slide.frontmatter.layout || result.frontmatter.defaults?.layout || (slide.no === 1 ? 'cover' : 'default')
      if (!layouts.has(layout)) throw new Error(`Layout is not registered in this runtime: ${layout}`)
      for (const [, name] of slide.code.matchAll(/resolveComponent\("([^"\\]+)"\)/g)) {
        if (!components.has(name.replace(/-/g, '').toLowerCase())) throw new Error(`Component is not registered in this runtime: ${name}`)
      }
    }
    const objects = [[`private/${id}/${revision}.json`, JSON.stringify(input)]]
    for (const [name, value] of Object.entries(orderedAssets)) {
      objects.push([`${prefix}/assets/${name}`, value, { httpMetadata: { contentType: name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.css') ? 'text/css' : 'text/plain' } }])
    }
    for (const slide of result.slides) {
      objects.push([`${prefix}/${slide.no}.js`, slide.code, { httpMetadata: { contentType: 'text/javascript; charset=utf-8' } }])
      objects.push([`${prefix}/${slide.no}.css`, slide.css, { httpMetadata: { contentType: 'text/css; charset=utf-8' } }])
    }
    await putArtifacts(env.FILES, objects)
    manifest = {
      id, revision, profileDigest: env.PROFILE_DIGEST, title: result.title,
      frontmatter: result.frontmatter, warnings: result.warnings,
      entry: `/${id}/1?revision=${revision}`,
      slides: result.slides.map(slide => ({ no: slide.no, title: slide.title, frontmatter: slide.frontmatter, module: `/${prefix}/${slide.no}.js`, css: `/${prefix}/${slide.no}.css` })),
    }
    await env.FILES.put(`${prefix}/manifest.json`, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } })
  }
  // The single synchronous DO transaction is the publication point. Failed or
  // superseded builds never replace a successful current revision.
  const published = await versions.commit(generation, manifest)
  if (published) await env.FILES.put(`index/${id}.json`, JSON.stringify({ id }))
  return json({ ...manifest, published, cached: Boolean(existing) }, published ? 200 : 409)
}

async function fetchManifest(env, id, revision) {
  if (revision) {
    if (!validRevision(revision)) return null
    const object = await env.FILES.get(`releases/${id}/${revision}/manifest.json`)
    return object ? object.json() : null
  }
  return env.VERSIONS.getByName(id).current()
}

async function handler(request, env) {
  const url = new URL(request.url)
  if (url.pathname === '/api/catalog' && request.method === 'GET') {
    const listed = await env.FILES.list({ prefix: 'index/' })
    const decks = []
    for (const object of listed.objects) {
      const id = object.key.slice(6, -5)
      const manifest = await env.VERSIONS.getByName(id).current()
      if (manifest) decks.push(manifest)
    }
    return json({ decks, truncated: listed.truncated })
  }
  const match = url.pathname.match(/^\/api\/decks\/(.+)$/)
  if (match) {
    const id = decodeURIComponent(match[1])
    if (!validId(id)) return json({ error: 'Invalid deck id' }, 400)
    if (request.method === 'GET') {
      const manifest = await fetchManifest(env, id, url.searchParams.get('revision'))
      return manifest ? json(manifest) : json({ error: 'Deck not found' }, 404)
    }
    // Cloud mutations require a dedicated publish secret; the opt-in local
    // bypass is restricted to loopback URLs.
    const authError = await mutationAuth(request, env)
    if (authError) return authError
    if (request.method === 'POST') return publish(request, env, id)
  }
  if (url.pathname.startsWith('/api/thumbnail/') && ['POST', 'PUT'].includes(request.method)) {
    const authError = await mutationAuth(request, env)
    if (authError) return authError
    const id = decodeURIComponent(url.pathname.slice('/api/thumbnail/'.length))
    if (!validId(id)) return json({ error: 'Invalid deck id' }, 400)
    const manifest = await fetchManifest(env, id, url.searchParams.get('revision'))
    if (!manifest) return json({ error: 'Deck not found' }, 404)
    const key = `releases/${id}/${manifest.revision}/thumbnail.png`
    if (await env.FILES.head(key)) return json({ status: 'cached', src: `/${key}` })
    if (request.method === 'PUT') {
      const bytes = await boundedBody(request, 4 * 1024 * 1024)
      validatePng(bytes)
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: 'image/png' }, onlyIf: { etagDoesNotMatch: '*' } })
      return json({ status: 'uploaded', src: `/${key}` })
    }
    if (!env.BROWSER) return json({ status: 'unavailable', reason: 'Browser Run is not bound; use the local thumbnail uploader.' }, 503)
    const target = new URL(manifest.entry + '&embedded=true&labThumbnail=true', request.url)
    const thumbnail = await captureThumbnail({ browser: env.BROWSER, url: target.href })
    await env.FILES.put(key, thumbnail.bytes, { httpMetadata: { contentType: 'image/png' } })
    return json({ status: 'created', src: `/${key}`, usedMs: thumbnail.usedMs })
  }
  if (url.pathname.startsWith('/releases/') && request.method === 'GET') {
    const key = url.pathname.slice(1)
    const object = await env.FILES.get(key)
    if (!object) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
    const headers = new Headers({ 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' })
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    return new Response(object.body, { headers })
  }
  return env.STATIC.fetch(request)
}

export default {
  async fetch(request, env) {
    try { return await handler(request, env) }
    catch (error) {
      console.log(JSON.stringify({ event: 'request-failed', message: String(error.message).slice(0, 300) }))
      return json({ error: String(error.message).slice(0, 300) }, 400)
    }
  },
}
