import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectRequestedRevision,
  validatedRevisionModuleUrl,
  validateDeckManifest,
} from '../runtime/manifest.ts';
import { snapshotRuntime } from '../scripts/runtime-snapshot.mjs';
import {
  preserveReleaseAssetInLayoutHelper,
  preserveReleaseAssetInPreloader,
} from '../scripts/runtime-asset-paths.mjs';

test('accepts only exact same-origin immutable revision module paths', () => {
  const revision = 'a'.repeat(64);
  for (const page of [1, 2, 100]) {
    const moduleUrl = `/releases/group/deck/${revision}/${page}.js`;
    assert.equal(validatedRevisionModuleUrl(moduleUrl), moduleUrl);
  }

  for (const moduleUrl of [
    'https://example.com/releases/group/deck/' + revision + '/1.js',
    '//example.com/releases/group/deck/' + revision + '/1.js',
    '/releases/group/../deck/' + revision + '/1.js',
    '/releases/group/%2e%2e/deck/' + revision + '/1.js',
    '/releases/%67roup/deck/' + revision + '/1.js',
    '/releases/group/deck/' + revision.toUpperCase() + '/1.js',
    '/releases/group/deck/' + 'a'.repeat(63) + '/1.js',
    '/releases/group/deck/' + revision + '/0.js',
    '/releases/group/deck/' + revision + '/101.js',
    '/releases/group/deck/' + revision + '/01.js',
    '/releases/group/deck/' + revision + '/1.css',
    '/releases/group/deck/' + revision + '/1.js?download=1',
    '/releases/group/deck/' + revision + '/1.js#module',
    '/releases/group/deck/' + revision + '/1.js\n',
  ]) {
    assert.throws(() => validatedRevisionModuleUrl(moduleUrl), /Invalid revision module URL/);
  }
});

test('runtime only loads sequential modules from the selected immutable release', () => {
  const revision = 'a'.repeat(64);
  const manifest = {
    id: 'group/deck',
    revision,
    slides: [
      {
        no: 1,
        module: `/releases/group/deck/${revision}/1.js`,
        css: `/releases/group/deck/${revision}/1.css`,
      },
    ],
  };
  assert.equal(validateDeckManifest(manifest, manifest.id), manifest);
  for (const patch of [
    { module: 'https://example.com/code.js' },
    { module: `/releases/other/deck/${revision}/1.js` },
    { css: '/unexpected.css' },
    { no: 2 },
  ])
    assert.throws(() =>
      validateDeckManifest(
        { ...manifest, slides: [{ ...manifest.slides[0], ...patch }] },
        manifest.id,
      ),
    );
  assert.throws(() => validateDeckManifest(manifest, 'other'));
  assert.throws(() => validateDeckManifest({ ...manifest, slides: [] }, manifest.id));
});

test('manifest runtime id is optional for legacy builds and must match the selected runtime', () => {
  const revision = 'a'.repeat(64);
  const runtimeId = 'b'.repeat(64);
  const manifest = {
    id: 'group/deck',
    revision,
    runtimeId,
    slides: [{ no: 1, module: `/releases/group/deck/${revision}/1.js` }],
  };
  const legacyManifest = { ...manifest, runtimeId: undefined };
  assert.equal(validateDeckManifest(legacyManifest, manifest.id), legacyManifest);
  assert.equal(validateDeckManifest(manifest, manifest.id, runtimeId), manifest);
  assert.throws(() => validateDeckManifest(manifest, manifest.id, 'c'.repeat(64)));
  assert.throws(() => validateDeckManifest({ ...manifest, runtimeId: 'invalid' }, manifest.id));
  assert.throws(
    () => validateDeckManifest(legacyManifest, manifest.id, runtimeId),
    /Invalid deck manifest/,
  );
});

test('revision query wins over the injected revision meta, which supports URL pinning after load', () => {
  const current = 'a'.repeat(64);
  const injected = 'b'.repeat(64);
  assert.equal(
    selectRequestedRevision(new URL(`https://hub.example/deck/1?revision=${current}`), injected),
    current,
  );
  assert.equal(selectRequestedRevision(new URL('https://hub.example/deck/1'), injected), injected);
  assert.equal(
    selectRequestedRevision(new URL('https://hub.example/deck/1?revision='), injected),
    injected,
  );
});

test('Slidev asset helpers preserve immutable release paths while applying runtime base to others', () => {
  const layoutHelper = `
export function resolveAssetUrl(url: string) {
  if (url.startsWith('/'))
    return import.meta.env.BASE_URL + url.slice(1)
  return url
}
`;
  const patchedLayout = preserveReleaseAssetInLayoutHelper(layoutHelper);
  assert.match(patchedLayout, /url\.startsWith\('\/releases\/'\) \? url/);
  assert.match(patchedLayout, /import\.meta\.env\.BASE_URL \+ url\.slice\(1\)/);

  const preloader = `
function resolveUrl(url: string): string {
  if (url.startsWith('http') || url.startsWith('//'))
    return url
  const base = (import.meta.env.BASE_URL || '/').replace(/\\/$/, '')
  return \`\${base}\${url.startsWith('/') ? url : \`/\${url}\`}\`
}
`;
  const patchedPreloader = preserveReleaseAssetInPreloader(preloader);
  assert.match(patchedPreloader, /url\.startsWith\('\/releases\/'\) \? url/);
  assert.match(patchedPreloader, /\$\{base\}\$\{url\.startsWith\('\/'\)/);
  assert.throws(
    () => preserveReleaseAssetInLayoutHelper('export function changed() {}'),
    /signature changed/,
  );
  assert.throws(
    () => preserveReleaseAssetInPreloader('function changed() {}'),
    /signature changed/,
  );
});

test('runtime snapshot copies public files, pins the snapshot index, and describes final bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-runtime-snapshot-'));
  try {
    await mkdir(join(root, 'assets'), { recursive: true });
    await mkdir(join(root, '_runtime'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'runtimes', 'old'), { recursive: true });
    const originalIndex =
      '<!doctype html><html><head><title>fixture</title></head><body></body></html>';
    const assets = {
      'index.html': originalIndex,
      'assets/app.js': 'export default 1;',
      'assets/app.css': 'body{color:red}',
      'assets/theme.woff2': 'font-bytes',
      '_runtime/vue.js': 'export const createElementVNode = () => {};',
      '_runtime/bridge.js': 'export const slideSetup = () => {};',
      'runtime-manifest.json': '{"stale":true}',
      'assets/app.js.map': '{"sources":[]}',
      'assets/source.ts': 'export const secret = true;',
      'src/private.js': 'private source',
      'runtimes/old/index.html': 'old snapshot',
    };
    for (const [path, content] of Object.entries(assets)) {
      const destination = join(root, ...path.split('/'));
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, content);
    }

    const id = 'd'.repeat(64);
    const descriptor = await snapshotRuntime({ siteRoot: root, id });
    assert.equal(descriptor.schemaVersion, 1);
    assert.equal(descriptor.id, id);
    assert.deepEqual(
      descriptor.files.map(({ path }) => path),
      [
        '_runtime/bridge.js',
        '_runtime/vue.js',
        'assets/app.css',
        'assets/app.js',
        'assets/theme.woff2',
        'index.html',
      ],
    );
    const snapshotIndex = await readFile(join(root, 'runtimes', id, 'index.html'), 'utf8');
    assert.match(snapshotIndex, /<head><base href="\/runtimes\/d{64}\/">/);
    assert.equal((snapshotIndex.match(/<base\b/g) ?? []).length, 1);
    assert.equal(await readFile(join(root, 'index.html'), 'utf8'), originalIndex);

    for (const file of descriptor.files) {
      const bytes = await readFile(join(root, 'runtimes', id, ...file.path.split('/')));
      assert.equal(file.size, bytes.byteLength);
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
    assert.equal(
      descriptor.files.find(({ path }) => path === 'assets/theme.woff2').contentType,
      'font/woff2',
    );
    const pinnedIndex = await readFile(join(root, 'runtimes', id, 'index.html'));
    assert.deepEqual(await snapshotRuntime({ siteRoot: root, id }), descriptor);
    await writeFile(join(root, 'assets', 'app.js'), 'export default 2;');
    await assert.rejects(snapshotRuntime({ siteRoot: root, id }), /snapshot collision/);
    assert.deepEqual(await readFile(join(root, 'runtimes', id, 'index.html')), pinnedIndex);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
