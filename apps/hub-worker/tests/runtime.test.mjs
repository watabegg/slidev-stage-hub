import test from 'node:test';
import assert from 'node:assert/strict';
import { validatedRevisionModuleUrl, validateDeckManifest } from '../runtime/manifest.ts';

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
