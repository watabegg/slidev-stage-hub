import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(join(fileURLToPath(import.meta.url), '../..'));
const CSS_HOST = 'fonts.googleapis.com';
const FONT_HOST = 'fonts.gstatic.com';
const MAX_CONCURRENT_DOWNLOADS = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function walkSiteFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '_fonts') visit(path);
      } else if (entry.isFile()) {
        if (['.css', '.htm', '.html'].includes(extname(entry.name).toLowerCase())) files.push(path);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`symbolic links are not accepted in the site tree: ${path}`);
      }
    }
  }
  visit(root);
  return files;
}

function decodeHtmlUrl(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&#38;', '&').replaceAll('&#x26;', '&');
}

function normalizeUrl(value, baseUrl) {
  try {
    const url = new URL(decodeHtmlUrl(value.trim()), baseUrl);
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function isGoogleCssUrl(value, baseUrl) {
  const url = normalizeUrl(value, baseUrl);
  return url && url.protocol === 'https:' && url.hostname === CSS_HOST && /^\/css2?$/.test(url.pathname)
    ? url.href
    : null;
}

function isGoogleFontUrl(value, baseUrl) {
  const url = normalizeUrl(value, baseUrl);
  return url && url.protocol === 'https:' && url.hostname === FONT_HOST ? url.href : null;
}

function forEachCssImport(css, callback) {
  const pattern = /@import\s+(?:url\(\s*)?(?:(['"])(.*?)\1|([^\s);]+))\s*\)?([^;]*);/gi;
  return css.replace(pattern, (whole, quote, quotedUrl, unquotedUrl, media = '') => {
    const url = quotedUrl ?? unquotedUrl;
    const replacement = callback(url, media, whole);
    return replacement ?? whole;
  });
}

function findFontFaceBlocks(css) {
  const blocks = [];
  const startPattern = /@font-face\b/gi;
  let match;
  while ((match = startPattern.exec(css))) {
    const open = css.indexOf('{', match.index + match[0].length);
    if (open < 0) throw new Error('malformed @font-face rule: missing opening brace');
    let depth = 0;
    let quote = null;
    let escaped = false;
    let comment = false;
    let close = -1;
    for (let index = open; index < css.length; index++) {
      const character = css[index];
      const next = css[index + 1];
      if (comment) {
        if (character === '*' && next === '/') {
          comment = false;
          index++;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '/' && next === '*') {
        comment = true;
        index++;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '{') {
        depth++;
      } else if (character === '}' && --depth === 0) {
        close = index + 1;
        break;
      }
    }
    if (close < 0) throw new Error('malformed @font-face rule: missing closing brace');
    blocks.push({ start: match.index, end: close });
    startPattern.lastIndex = close;
  }
  return blocks;
}

const CSS_URL_PATTERN = /url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi;

function fontUrlsFromCss(css, stylesheetUrl) {
  const urls = new Set();
  for (const block of findFontFaceBlocks(css)) {
    const text = css.slice(block.start, block.end);
    let match;
    CSS_URL_PATTERN.lastIndex = 0;
    while ((match = CSS_URL_PATTERN.exec(text))) {
      const raw = (match[2] ?? match[3] ?? '').trim();
      const url = isGoogleFontUrl(raw, stylesheetUrl);
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

function rewriteFontUrls(css, stylesheetUrl, fontFiles) {
  const blocks = findFontFaceBlocks(css);
  let output = '';
  let previous = 0;
  for (const block of blocks) {
    output += css.slice(previous, block.start);
    const text = css.slice(block.start, block.end).replace(CSS_URL_PATTERN, (whole, quote, quotedUrl, unquotedUrl) => {
      const raw = (quotedUrl ?? unquotedUrl ?? '').trim();
      const url = isGoogleFontUrl(raw, stylesheetUrl);
      const file = url && fontFiles.get(url);
      return file ? `url("${file.path}")` : whole;
    });
    output += text;
    previous = block.end;
  }
  output += css.slice(previous);
  return output;
}

function htmlAttribute(tag, name) {
  const pattern = new RegExp(`\\b(${name}\\s*=\\s*)(["'])(.*?)\\2`, 'i');
  const match = tag.match(pattern);
  return match ? { pattern, prefix: match[1], quote: match[2], value: match[3] } : null;
}

function rewriteGoogleCssLinks(html, resolveStylesheet) {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = htmlAttribute(tag, 'rel')?.value.toLowerCase().split(/\s+/) ?? [];
    if (!rel.includes('stylesheet')) return tag;
    const attr = htmlAttribute(tag, 'href');
    if (!attr) return tag;
    const url = isGoogleCssUrl(attr.value);
    if (!url) return tag;
    if (/\bintegrity\s*=/i.test(tag)) throw new Error(`cannot rewrite Google Fonts link with integrity metadata: ${url}`);
    const local = resolveStylesheet(url);
    return tag.replace(attr.pattern, `${attr.prefix}${attr.quote}${local}${attr.quote}`);
  });
}

function rewriteCssImports(css, baseUrl, resolveStylesheet) {
  return forEachCssImport(css, (raw, media) => {
    const url = isGoogleCssUrl(raw, baseUrl);
    if (!url) return undefined;
    const local = resolveStylesheet(url);
    return `@import url("${local}")${media};`;
  });
}

function rewriteHtml(html, resolveStylesheet) {
  let output = rewriteGoogleCssLinks(html, resolveStylesheet);
  output = output.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_whole, start, css, end) =>
    `${start}${rewriteCssImports(css, undefined, resolveStylesheet)}${end}`,
  );
  return output;
}

function googleCssReferences(text, extension) {
  const references = [];
  if (extension === '.css') {
    forEachCssImport(text, (raw) => {
      const url = isGoogleCssUrl(raw);
      if (url) references.push(url);
      return undefined;
    });
  } else {
    for (const tag of text.matchAll(/<link\b[^>]*>/gi)) {
      const rel = htmlAttribute(tag[0], 'rel')?.value.toLowerCase().split(/\s+/) ?? [];
      const href = htmlAttribute(tag[0], 'href')?.value;
      if (!rel.includes('stylesheet') || !href) continue;
      const url = isGoogleCssUrl(href);
      if (url) references.push(url);
    }
    for (const style of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
      forEachCssImport(style[1], (raw) => {
        const url = isGoogleCssUrl(raw);
        if (url) references.push(url);
        return undefined;
      });
    }
  }
  return references;
}

async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  const errors = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await callback(items[index]); }
      catch (error) { errors.push(error); }
    }
  });
  await Promise.all(workers);
  if (errors.length) throw new AggregateError(errors, `${errors.length} download(s) failed`);
  return results;
}

async function fetchRemote(url, type) {
  const expectedHost = type === 'css' ? CSS_HOST : FONT_HOST;
  const initial = new URL(url);
  if (initial.protocol !== 'https:' || initial.hostname !== expectedHost)
    throw new Error(`refusing unexpected ${type} origin: ${url}`);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: type === 'css' ? 'text/css,*/*;q=0.1' : '*/*',
        'user-agent': USER_AGENT,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`${type} download failed for ${url}: ${error.message}`);
  }
  if (!response.ok) throw new Error(`${type} download returned HTTP ${response.status} for ${url}`);
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== expectedHost)
    throw new Error(`${type} download redirected to an unexpected origin: ${finalUrl.href}`);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`${type} download returned an empty body for ${url}`);
  if (bytes.subarray(0, 32).toString('ascii').trimStart().toLowerCase().startsWith('<!doctype html')
    || bytes.subarray(0, 32).toString('ascii').trimStart().toLowerCase().startsWith('<html'))
    throw new Error(`${type} download returned HTML instead of an asset for ${url}`);
  if (type === 'css' && contentType !== 'text/css')
    throw new Error(`CSS download returned unexpected Content-Type ${contentType || '(missing)'} for ${url}`);
  if (type === 'css' && !/@font-face\b/i.test(bytes.toString('utf8')))
    throw new Error(`CSS response contains no @font-face rule: ${url}`);
  return { url, finalUrl: finalUrl.href, contentType, bytes };
}

function fontExtension(download) {
  const fromPath = extname(new URL(download.finalUrl).pathname).toLowerCase();
  if (['.woff2', '.woff', '.ttf', '.otf'].includes(fromPath)) return fromPath;
  if (download.contentType.includes('woff2')) return '.woff2';
  if (download.contentType.includes('woff')) return '.woff';
  if (download.contentType.includes('opentype')) return '.otf';
  if (download.contentType.includes('truetype')) return '.ttf';
  const signature = download.bytes.subarray(0, 4).toString('latin1');
  if (signature === 'wOF2') return '.woff2';
  if (signature === 'wOFF') return '.woff';
  if (signature === 'OTTO') return '.otf';
  if (signature === 'true' || download.bytes.readUInt32BE(0) === 0x00010000) return '.ttf';
  throw new Error(`could not determine font file extension for ${download.finalUrl}`);
}

function writeIfChanged(path, bytes) {
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (existing.equals(bytes)) return false;
    throw new Error(`content-hash path already exists with different bytes: ${path}`);
  }
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
  return true;
}

function assetsInFontsDirectory(siteRoot) {
  const root = join(siteRoot, '_fonts');
  if (!existsSync(root)) return [];
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else if (entry.isSymbolicLink()) throw new Error(`symbolic links are not accepted under _fonts: ${path}`);
    }
  }
  visit(root);
  return files.sort();
}

function updateManifest(siteRoot, fontAssets) {
  if (fontAssets.length === 0) return false;
  const manifestPath = join(siteRoot, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (Object.hasOwn(manifest, 'commonAssets') && !Array.isArray(manifest.commonAssets))
    throw new Error('manifest.json commonAssets must be an array to add local font resources');
  const current = Array.isArray(manifest.commonAssets) ? manifest.commonAssets : [];
  const next = [...new Set([...current, ...fontAssets])].sort();
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  manifest.commonAssets = next;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

async function processSite(siteRoot, evidencePath) {
  const root = realpathSync(siteRoot);
  if (!statSync(root).isDirectory()) throw new Error(`site root is not a directory: ${root}`);
  const sourceFiles = walkSiteFiles(root);
  const sourceText = new Map(sourceFiles.map((path) => [path, readFileSync(path, 'utf8')]));
  const referenceRecords = [];
  const stylesheetUrls = new Set();

  for (const [path, text] of sourceText) {
    const extension = extname(path).toLowerCase();
    const urls = googleCssReferences(text, extension);
    for (const url of urls) {
      stylesheetUrls.add(url);
      referenceRecords.push({ sourcePath: relative(root, path).split(sep).join('/'), url });
    }
  }

  const downloadedCssList = await mapWithConcurrency([...stylesheetUrls], MAX_CONCURRENT_DOWNLOADS, (url) => fetchRemote(url, 'css'));
  const downloadedCss = new Map(downloadedCssList.map((item) => [item.url, item]));
  const fontUrlSet = new Set();
  for (const stylesheet of downloadedCss.values()) {
    for (const url of fontUrlsFromCss(stylesheet.bytes.toString('utf8'), stylesheet.finalUrl)) fontUrlSet.add(url);
  }
  const downloadedFontList = await mapWithConcurrency([...fontUrlSet], MAX_CONCURRENT_DOWNLOADS, (url) => fetchRemote(url, 'font'));
  const downloadedFonts = new Map(downloadedFontList.map((item) => [item.url, item]));

  const generatedFontFiles = new Map();
  const fontUrlToFile = new Map();
  const fontRecords = downloadedFontList.map((download) => {
    const extension = fontExtension(download);
    const digest = sha256(download.bytes);
    const path = `/_fonts/${digest}${extension}`;
    const localPath = join(root, path.slice(1));
    generatedFontFiles.set(localPath, download.bytes);
    fontUrlToFile.set(download.url, { path, sha256: digest, bytes: download.bytes.length, extension });
    return {
      sourceUrl: download.url,
      finalUrl: download.finalUrl,
      sha256: digest,
      path,
      contentType: download.contentType,
      bytes: download.bytes.length,
    };
  });

  const generatedCssFiles = new Map();
  const cssUrlToFile = new Map();
  const cssRecords = [];
  for (const stylesheet of downloadedCss.values()) {
    const originalCss = stylesheet.bytes.toString('utf8');
    const rewrittenCss = rewriteFontUrls(originalCss, stylesheet.finalUrl, fontUrlToFile);
    const bytes = Buffer.from(rewrittenCss);
    const digest = sha256(bytes);
    const path = `/_fonts/${digest}.css`;
    generatedCssFiles.set(join(root, path.slice(1)), bytes);
    cssUrlToFile.set(stylesheet.url, path);
    cssRecords.push({
      sourceUrl: stylesheet.url,
      finalUrl: stylesheet.finalUrl,
      sha256: digest,
      path,
      downloadedBodyBytes: stylesheet.bytes.length,
      localBytes: bytes.length,
      fontUrls: fontUrlsFromCss(originalCss, stylesheet.finalUrl),
    });
  }

  const resolveStylesheet = (url) => {
    const path = cssUrlToFile.get(url);
    if (!path) throw new Error(`missing downloaded Google Fonts stylesheet mapping for ${url}`);
    return path;
  };

  const rewrittenFiles = new Map();
  for (const [path, text] of sourceText) {
    const extension = extname(path).toLowerCase();
    const rewritten = extension === '.css'
      ? rewriteCssImports(text, undefined, resolveStylesheet)
      : rewriteHtml(text, resolveStylesheet);
    if (rewritten !== text) rewrittenFiles.set(path, Buffer.from(rewritten));
  }

  // Fetches and rewrites are complete before any site file is changed.
  for (const [path, bytes] of generatedFontFiles) writeIfChanged(path, bytes);
  for (const [path, bytes] of generatedCssFiles) writeIfChanged(path, bytes);
  for (const [path, bytes] of rewrittenFiles) writeFileSync(path, bytes);

  const fontAssets = assetsInFontsDirectory(root).map((path) => `/${relative(root, path).split(sep).join('/')}`);
  const manifestUpdated = updateManifest(root, fontAssets);
  const actualFontBytes = [...generatedFontFiles.values()].reduce((total, bytes) => total + bytes.length, 0);
  const actualCssBytes = [...generatedCssFiles.values()].reduce((total, bytes) => total + bytes.length, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    siteRoot: root,
    concurrencyLimit: MAX_CONCURRENT_DOWNLOADS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    counts: {
      stylesheetReferences: referenceRecords.length,
      uniqueStylesheetsDownloaded: downloadedCss.size,
      uniqueFontFilesDownloaded: downloadedFonts.size,
      fontFaceReferences: [...downloadedCss.values()].reduce((total, sheet) =>
        total + fontUrlsFromCss(sheet.bytes.toString('utf8'), sheet.finalUrl).length, 0),
      stylesheetFilesGenerated: generatedCssFiles.size,
      fontFilesGenerated: generatedFontFiles.size,
      sourceFilesRewritten: rewrittenFiles.size,
      commonAssetsInManifest: fontAssets.length,
      manifestUpdated,
    },
    bytes: {
      downloadedCssBodyBytes: downloadedCssList.reduce((total, item) => total + item.bytes.length, 0),
      downloadedFontBodyBytes: downloadedFontList.reduce((total, item) => total + item.bytes.length, 0),
      generatedCssBytes: actualCssBytes,
      generatedFontBytes: actualFontBytes,
      generatedAssetBytes: actualCssBytes + actualFontBytes,
      fontDirectoryBytes: assetsInFontsDirectory(root).reduce((total, path) => total + statSync(path).size, 0),
    },
    rewrittenStylesheets: referenceRecords,
    stylesheets: cssRecords,
    fonts: fontRecords,
    notes: [
      'Only fonts.googleapis.com CSS stylesheet links/imports and fonts.gstatic.com URLs inside @font-face rules are rewritten.',
      'External URLs outside @font-face rules are left byte-for-byte unchanged.',
      'Existing hashed CSS files may have changed bytes while retaining their original names; run before publication or rebuild the CSS filename hash.',
    ],
  };
  mkdirSync(resolve(evidencePath, '..'), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  const [siteRootArgument, evidenceArgument] = process.argv.slice(2);
  if (!siteRootArgument) throw new Error('usage: node scripts/vendor-fonts.mjs <site-root> [evidence-json=artifacts/fonts/report.json]');
  const siteRoot = resolve(siteRootArgument);
  const evidencePath = resolve(REPO_ROOT, evidenceArgument || 'artifacts/fonts/report.json');
  const report = await processSite(siteRoot, evidencePath);
  console.log(JSON.stringify({ siteRoot: report.siteRoot, evidence: relative(REPO_ROOT, evidencePath), counts: report.counts, bytes: report.bytes }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`font vendoring failed: ${error.message}`);
    if (error instanceof AggregateError) for (const nested of error.errors) console.error(`- ${nested.message}`);
    process.exitCode = 1;
  });
}
