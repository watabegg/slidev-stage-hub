import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-chromium';

const root = new URL('../', import.meta.url);
const output = new URL('apps/slive/src-tauri/icons/', root);
await mkdir(output, { recursive: true });
const svg = await readFile(new URL('apps/slive/src/slive.svg', root), 'utf8');
const browser = await chromium.launch({ headless: true });
const pngs = new Map();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
    );
    pngs.set(size, await page.screenshot({ omitBackground: true }));
  }
} finally {
  await browser.close();
}
for (const [size, name] of [
  [32, '32x32.png'],
  [128, '128x128.png'],
  [256, '128x128@2x.png'],
  [512, 'icon.png'],
]) {
  await writeFile(new URL(name, output), pngs.get(size));
}

// ICO embeds PNG images so each OS can select its display size without resampling.
const sizes = [16, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  const png = pngs.get(size);
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(
  new URL('icon.ico', output),
  Buffer.concat([header, ...sizes.map((size) => pngs.get(size))]),
);

const chunks = [
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
].map(([size, tag]) => {
  const png = pngs.get(size);
  const chunk = Buffer.alloc(8);
  chunk.write(tag);
  chunk.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([chunk, png]);
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns');
icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(new URL('icon.icns', output), Buffer.concat([icnsHeader, ...chunks]));
console.log(`Generated Slive icons in ${fileURLToPath(output)}`);
