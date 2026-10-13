import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateThumbnails } from '@slidock/slidock';

test('thumbnails wait for CSS background images and reject broken backgrounds', async (t) => {
  let delivered = false;
  const images = createServer((request, response) => {
    if (request.url === '/missing') {
      response.writeHead(404).end();
      return;
    }
    setTimeout(() => {
      delivered = true;
      response.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',
      });
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="68"><rect width="120" height="68" fill="red"/></svg>',
      );
    }, 1500);
  });
  await new Promise((resolve) => images.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => images.close(resolve)));
  const root = await mkdtemp(join(tmpdir(), 'slidock-background-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({ decks: [{ id: 'demo', entry: '/demo/1', pages: 1 }] }),
  );
  const markup = (path) =>
    `<style>body{margin:0}.slidev-page{width:100vw;height:100vh;background-image:url("http://127.0.0.1:${images.address().port}/${path}")}</style><div class="slidev-page" data-slidev-no="1"></div>`;
  await writeFile(join(root, 'index.html'), markup('slow'));
  await generateThumbnails({
    siteRoot: root,
    outputWidth: 120,
    outputHeight: 68,
    chromiumExecutable: process.env.CHROMIUM_EXECUTABLE,
  });
  assert.equal(delivered, true, 'background must finish before capture returns');
  await writeFile(join(root, 'index.html'), markup('missing'));
  await assert.rejects(
    generateThumbnails({
      siteRoot: root,
      outputWidth: 120,
      outputHeight: 68,
      chromiumExecutable: process.env.CHROMIUM_EXECUTABLE,
    }),
    /Background image failed|browser request errors/,
  );
});
