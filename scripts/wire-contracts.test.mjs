import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { validatePlayerDocument } from '@slidock/protocol';
import { repositoryRoot } from './runtime-environment.mjs';

for (const schemaVersion of [1, 2]) {
  const fixturesRoot = new URL(
    `../tests/fixtures/native-player/v${schemaVersion}/`,
    import.meta.url,
  );
  for (const file of (await readdir(fixturesRoot))
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const fixture = JSON.parse(await readFile(new URL(file, fixturesRoot), 'utf8'));
    test(`shared Rust/TS deck fixture: ${fixture.name}`, () => {
      if (!fixture.accepted) {
        assert.throws(() => validatePlayerDocument(fixture.document));
        return;
      }
      const result = validatePlayerDocument(fixture.document);
      assert.deepEqual(
        result.decks,
        fixture.document.decks.map(({ id, revision, entry, clickTotals, playback }) => ({
          id,
          revision,
          entry,
          clickTotals,
          ...(schemaVersion === 2
            ? { playback: { kind: playback.kind, parameter: playback.parameter } }
            : {}),
        })),
      );
      assert.deepEqual(result.unsupportedDecks, []);
    });
  }
}

for (const platform of ['browser', 'neutral']) {
  test(`public contracts bundle without Node dependencies for ${platform}`, async () => {
    const result = await build({
      absWorkingDir: repositoryRoot,
      stdin: {
        contents: "export * from '@slidock/protocol';",
        resolveDir: repositoryRoot,
        sourcefile: 'contract-consumer.js',
      },
      bundle: true,
      platform,
      conditions: platform === 'neutral' ? ['worker'] : ['browser'],
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.ok(inputs.some((name) => name.startsWith('packages/protocol/dist/contracts/')));
    assert.ok(
      inputs.every(
        (name) =>
          name === 'contract-consumer.js' || name.startsWith('packages/protocol/dist/contracts/'),
      ),
      inputs.join('\n'),
    );
    for (const output of Object.values(result.metafile.outputs))
      assert.deepEqual(output.imports, []);
    assert.doesNotMatch(result.outputFiles[0].text, /\b(?:Buffer|process|require)\b/);
  });
}

test('bridge export remains a standalone classic script', async () => {
  const bridge = await readFile(
    fileURLToPath(import.meta.resolve('@slidock/protocol/bridge')),
    'utf8',
  );
  assert.doesNotMatch(bridge, /^\s*(?:import|export)\s/m);
  assert.doesNotMatch(bridge, /\b(?:Buffer|process|require)\b/);
  assert.match(bridge, /nativeBridgeReady/);
  assert.match(bridge, /nativeState/);
});

test('protocol no longer exposes the Node-only parsing and manifest APIs', () => {
  for (const subpath of ['inspect-deck', 'native-player']) {
    assert.throws(() => import.meta.resolve(`@slidock/protocol/${subpath}`), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  }
});
