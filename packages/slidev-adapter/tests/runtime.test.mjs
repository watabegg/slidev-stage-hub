import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { inspectDeckSource } from '@slidock/slidev-adapter/inspect-deck';
import {
  assertSupportedVersions,
  loadSlidevParser,
  resolveRuntime,
} from '@slidock/slidev-adapter/runtime';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runtimes = [
  [repositoryRoot, '53.0.0'],
  [resolve(repositoryRoot, 'examples/slidev52'), '52.15.2'],
];

async function withRuntimeFixture(run, { cliVersion, clientVersion, cliSource = '' }) {
  const root = await mkdtemp(join(tmpdir(), 'slidev-adapter-runtime-'));
  const cliRoot = join(root, 'node_modules/@slidev/cli');
  const clientRoot = join(root, 'node_modules/@slidev/client');
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }));
    await mkdir(join(cliRoot, 'dist'), { recursive: true });
    await mkdir(clientRoot, { recursive: true });
    await writeFile(
      join(cliRoot, 'package.json'),
      JSON.stringify({ name: '@slidev/cli', version: cliVersion }),
    );
    await writeFile(join(cliRoot, 'dist/index.mjs'), cliSource);
    await writeFile(
      join(clientRoot, 'package.json'),
      JSON.stringify({ name: '@slidev/client', version: clientVersion }),
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [dependencyRoot, expectedVersion] of runtimes) {
  test(`Slidev ${expectedVersion} runtime and parser resolve as a supported pair`, async () => {
    const runtime = await resolveRuntime(dependencyRoot);
    assert.equal(runtime.cliVersion, expectedVersion);
    assert.equal(runtime.clientVersion, expectedVersion);
    assert.equal(typeof runtime.api.resolveOptions, 'function');
    assert.equal(typeof runtime.api.ViteSlidevPlugin, 'function');

    const { parseSync } = await loadSlidevParser(dependencyRoot);
    const text = '# 日本語\r\n本文 🟦\r\n<!-- 発表者ノート 💬 -->\r\n---\r\n# 次の頁\r\n';
    const inspection = inspectDeckSource({
      id: 'version-fixture/deck',
      source: 'version-fixture.md',
      text,
      parseSync,
      expectedPages: 2,
    });
    assert.equal(inspection.pages, 2);
    assert.equal(
      Buffer.from(text).subarray(inspection.slots[0].start, inspection.slots[0].end).toString(),
      ' 発表者ノート 💬 ',
    );
  });
}

test('runtime version gate rejects mismatched or unsupported CLI/client pairs', () => {
  assert.doesNotThrow(() => assertSupportedVersions('52.15.2', '52.15.2'));
  assert.doesNotThrow(() => assertSupportedVersions('53.0.0', '53.0.0'));
  assert.throws(
    () => assertSupportedVersions('52.15.2', '53.0.0'),
    /exact CLI\/client 52\.15\.2 or 53\.0\.0 pairs; found 52\.15\.2\/53\.0\.0/,
  );
  assert.throws(
    () => assertSupportedVersions('54.0.0', '54.0.0'),
    /exact CLI\/client 52\.15\.2 or 53\.0\.0 pairs; found 54\.0\.0\/54\.0\.0/,
  );
});

test('runtime loading reports package-pair and private CLI API mismatches clearly', async () => {
  await withRuntimeFixture(
    async (root) => {
      await assert.rejects(
        resolveRuntime(root),
        /exact CLI\/client 52\.15\.2 or 53\.0\.0 pairs; found 52\.15\.2\/53\.0\.0/,
      );
      await assert.rejects(
        loadSlidevParser(root),
        /exact CLI\/client 52\.15\.2 or 53\.0\.0 pairs; found 52\.15\.2\/53\.0\.0/,
      );
    },
    { cliVersion: '52.15.2', clientVersion: '53.0.0' },
  );

  await withRuntimeFixture(
    async (root) => {
      await assert.rejects(
        resolveRuntime(root),
        /Internal adapters require resolveOptions and ViteSlidevPlugin from Slidev CLI 53\.0\.0/,
      );
    },
    { cliVersion: '53.0.0', clientVersion: '53.0.0', cliSource: 'export const changedApi = true;' },
  );
});
