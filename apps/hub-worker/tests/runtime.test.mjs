import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeckManifest } from '../runtime/manifest.ts';

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
