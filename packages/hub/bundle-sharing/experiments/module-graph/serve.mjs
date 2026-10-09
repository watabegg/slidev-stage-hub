import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../artifacts', process.env.SLIDEV_LAB_ARTIFACT_NAME || 'module-graph', 'site')
const port = Number(process.env.PORT || 4310)
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    let file = resolve(root, `.${path}`)
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(404).end(); return }
    if (!await stat(file).then(value => value.isFile()).catch(() => false)) {
      if (extname(path)) { res.writeHead(404).end(); return }
      file = resolve(root, 'index.html')
    }
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' })
    res.end(await readFile(file))
  } catch { res.writeHead(500).end() }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port} ${root}`))
