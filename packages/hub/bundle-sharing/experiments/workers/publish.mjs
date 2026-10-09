import { readFile } from 'node:fs/promises';

const [origin, id, source, assetsFile] = process.argv.slice(2);
if (!origin || !id || !source)
  throw new Error(
    'Usage: node publish.mjs http://127.0.0.1:4180 category/deck source.md [assets.json]',
  );
const result = await fetch(new URL(`/api/decks/${encodeURIComponent(id)}`, origin), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    markdown: await readFile(source, 'utf8'),
    assets: assetsFile ? JSON.parse(await readFile(assetsFile, 'utf8')) : {},
  }),
});
const data = await result.json();
if (!result.ok) throw new Error(JSON.stringify(data));
console.log(
  JSON.stringify(
    {
      entry: new URL(data.entry, origin).href,
      revision: data.revision,
      cached: data.cached,
      pages: data.slides.length,
      warnings: data.warnings || [],
    },
    null,
    2,
  ),
);
