import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkBoundaries } from './check-boundaries.mjs';

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'slidev-boundaries-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, 'package.json'), {
    name: 'fixture-root',
    private: true,
    type: 'module',
  });
  await writeFile(
    path.join(root, 'pnpm-workspace.yaml'),
    [
      'packages:',
      '  - apps/*',
      '  - packages/*',
      '  - packages/hub/bundle-sharing/experiments/workers',
      '  - examples/slidev52',
      '',
    ].join('\n'),
  );

  return {
    root,
    async package(relativeDir, manifest) {
      const dir = path.join(root, relativeDir);
      await mkdir(dir, { recursive: true });
      await writeJson(path.join(dir, 'package.json'), {
        private: true,
        type: 'module',
        ...manifest,
      });
      return dir;
    },
    async file(relativeFile, content) {
      const fullPath = path.join(root, relativeFile);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
      return fullPath;
    },
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function rules(result) {
  return result.violations.map((violation) => violation.rule);
}

test('allows a declared workspace dependency through a public export', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('packages/protocol', {
    name: '@fixture/protocol',
    exports: { './public': './src/public.ts' },
  });
  await fixture.package('apps/consumer', {
    name: '@fixture/consumer',
    dependencies: { '@fixture/protocol': 'workspace:*' },
  });
  await fixture.file('packages/protocol/src/public.ts', 'export const value = 1;\n');
  await fixture.file(
    'apps/consumer/src/index.ts',
    "import { value } from '@fixture/protocol/public';\nexport { value } from '@fixture/protocol/public';\nvoid value;\n",
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.exceptionsUsed, []);
});

test('rejects a bare import that reaches a private workspace path', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('packages/protocol', {
    name: '@fixture/protocol',
    exports: { './public': './src/public.ts' },
  });
  await fixture.package('apps/consumer', {
    name: '@fixture/consumer',
    dependencies: { '@fixture/protocol': 'workspace:*' },
  });
  await fixture.file('packages/protocol/src/private.ts', 'export const secret = 1;\n');
  await fixture.file(
    'apps/consumer/src/index.ts',
    "import { secret } from '@fixture/protocol/src/private.ts';\nvoid secret;\n",
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.ok(rules(result).includes('workspace-private-import'));
});

test('rejects an undeclared workspace dependency even when its export is public', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('packages/protocol', {
    name: '@fixture/protocol',
    exports: { './public': './src/public.ts' },
  });
  await fixture.package('apps/consumer', { name: '@fixture/consumer' });
  await fixture.file('packages/protocol/src/public.ts', 'export const value = 1;\n');
  await fixture.file(
    'apps/consumer/src/index.cjs',
    "const { value } = require('@fixture/protocol/public');\nvoid value;\n",
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.ok(rules(result).includes('workspace-undeclared-dependency'));
});

test('reports a cycle between workspace packages', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('packages/alpha', {
    name: '@fixture/alpha',
    exports: { '.': './src/index.ts' },
    dependencies: { '@fixture/beta': 'workspace:*' },
  });
  await fixture.package('packages/beta', {
    name: '@fixture/beta',
    exports: { '.': './src/index.ts' },
    dependencies: { '@fixture/alpha': 'workspace:*' },
  });
  await fixture.file(
    'packages/alpha/src/index.ts',
    "import { beta } from '@fixture/beta';\nexport const alpha = beta;\n",
  );
  await fixture.file(
    'packages/beta/src/index.ts',
    "import { alpha } from '@fixture/alpha';\nexport const beta = alpha;\n",
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.equal(rules(result).filter((rule) => rule === 'workspace-cycle').length, 1);
});

test('finds a Node builtin imported transitively from a Vue script setup block', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('packages/hub', { name: '@fixture/hub' });
  await fixture.file(
    'packages/hub/frontend/Widget.vue',
    [
      '<script setup lang="ts">',
      "import { load } from '../src/internal/helper'",
      'void load',
      '</script>',
      '',
    ].join('\n'),
  );
  await fixture.file(
    'packages/hub/src/internal/helper.ts',
    "import { readFile } from 'node:fs';\nexport const load = readFile;\n",
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  const builtinViolation = result.violations.find(
    (violation) => violation.rule === 'production-node-builtin',
  );
  assert.equal(builtinViolation?.file, 'packages/hub/src/internal/helper.ts');
  assert.equal(builtinViolation?.specifier, 'node:fs');
});

test('follows a Vue script src to detect a transitive Node builtin', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('apps/stage', { name: '@fixture/stage' });
  await fixture.package('packages/hub', { name: '@fixture/hub' });
  await fixture.file(
    'apps/stage/src/RemoteScript.vue',
    '<script lang="ts" src="../../../packages/hub/src/boot.ts"></script>\n<template><div /></template>\n',
  );
  await fixture.file(
    'packages/hub/src/boot.ts',
    "import { readFile } from 'node:fs';\nexport const boot = readFile;\n",
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.rule === 'production-node-builtin' &&
        violation.file === 'packages/hub/src/boot.ts' &&
        violation.specifier === 'node:fs',
    ),
  );
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.file === 'apps/stage/src/RemoteScript.vue' &&
        violation.rule === 'cross-package-relative-import',
    ),
  );
});

test('turns Vue template assets and template src into package dependency edges', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('apps/stage', { name: '@fixture/stage' });
  await fixture.package('packages/hub', { name: '@fixture/hub' });
  await fixture.file(
    'apps/stage/src/TemplateAsset.vue',
    '<template><img src="../../../packages/hub/frontend/asset.svg"></template>\n',
  );
  await fixture.file(
    'apps/stage/src/ExternalTemplate.vue',
    '<template src="../../../packages/hub/frontend/template.html"></template>\n',
  );
  await fixture.file(
    'packages/hub/frontend/asset.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  );
  await fixture.file('packages/hub/frontend/template.html', '<img src="./asset.svg">\n');

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.file === 'apps/stage/src/TemplateAsset.vue' &&
        violation.rule === 'cross-package-relative-import',
    ),
  );
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.file === 'apps/stage/src/ExternalTemplate.vue' &&
        violation.rule === 'cross-package-relative-import',
    ),
  );
});

test('follows Vue style src and CSS @import dependency edges', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('apps/stage', { name: '@fixture/stage' });
  await fixture.package('packages/hub', { name: '@fixture/hub' });
  await fixture.file(
    'apps/stage/src/Styled.vue',
    '<template><div class="styled" /></template>\n<style src="./styles.css"></style>\n',
  );
  await fixture.file(
    'apps/stage/src/DirectStyle.vue',
    '<template><div class="direct-style" /></template>\n<style src="../../../packages/hub/frontend/direct-theme.css"></style>\n',
  );
  await fixture.file(
    'apps/stage/src/styles.css',
    '@import "../../../packages/hub/frontend/theme.css";\n.styled { color: red; }\n',
  );
  await fixture.file('packages/hub/frontend/theme.css', '.theme { color: blue; }\n');
  await fixture.file('packages/hub/frontend/direct-theme.css', '.direct-style { color: green; }\n');

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.file === 'apps/stage/src/styles.css' &&
        violation.specifier === '../../../packages/hub/frontend/theme.css' &&
        violation.rule === 'cross-package-relative-import',
    ),
  );
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.file === 'apps/stage/src/DirectStyle.vue' &&
        violation.specifier === '../../../packages/hub/frontend/direct-theme.css' &&
        violation.rule === 'cross-package-relative-import',
    ),
  );
});

test('includes Workers edge entrypoints in the production dependency graph', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('packages/hub', { name: '@fixture/hub' });
  await fixture.package('packages/hub/bundle-sharing/experiments/workers', {
    name: '@fixture/workers',
  });
  await fixture.file(
    'packages/hub/bundle-sharing/experiments/workers/worker.mjs',
    "import { start } from './edge-helper.mjs';\nexport default { fetch: start };\n",
  );
  await fixture.file(
    'packages/hub/bundle-sharing/experiments/workers/edge-helper.mjs',
    "import { createServer } from 'node:http';\nexport const start = createServer;\n",
  );
  await fixture.file(
    'packages/hub/bundle-sharing/experiments/workers/compiler.mjs',
    "import { readFile } from 'node:fs';\nexport const compile = readFile;\n",
  );
  await fixture.file(
    'packages/hub/bundle-sharing/experiments/workers/thumbnail.mjs',
    "import { Buffer } from 'node:buffer';\nexport const render = Buffer;\n",
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  const builtins = result.violations.filter(
    (violation) => violation.rule === 'production-node-builtin',
  );
  assert.ok(
    builtins.some(
      (violation) =>
        violation.file.endsWith('/edge-helper.mjs') && violation.specifier === 'node:http',
    ),
  );
  assert.ok(
    builtins.some(
      (violation) => violation.file.endsWith('/compiler.mjs') && violation.specifier === 'node:fs',
    ),
  );
  assert.ok(
    builtins.some(
      (violation) =>
        violation.file.endsWith('/thumbnail.mjs') && violation.specifier === 'node:buffer',
    ),
  );
});

test('includes Stage src files in the production dependency graph', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('apps/stage', { name: '@fixture/stage' });
  await fixture.file(
    'apps/stage/src/app.ts',
    "import { readFile } from 'node:fs';\nexport const load = readFile;\n",
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.rule === 'production-node-builtin' &&
        violation.file === 'apps/stage/src/app.ts' &&
        violation.specifier === 'node:fs',
    ),
  );
});

test('does not treat a type-only import from a Node builtin as a runtime dependency', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('apps/stage', { name: '@fixture/stage' });
  await fixture.file(
    'apps/stage/src/types.ts',
    "import { type Stats } from 'node:fs';\nexport type FileStats = Stats;\n",
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.equal(result.violations.length, 0);
});

test('requires an exception for a nonliteral import in the Workers production runtime', async (t) => {
  const fixture = await makeFixture(t);
  await fixture.package('packages/hub', { name: '@fixture/hub' });
  await fixture.package('packages/hub/bundle-sharing/experiments/workers', {
    name: '@fixture/workers',
  });
  await fixture.file(
    'packages/hub/bundle-sharing/experiments/workers/runtime/routes.ts',
    'export async function load(url: string) { return import(url); }\n',
  );

  const result = await checkBoundaries({ root: fixture.root, exceptions: [] });
  assert.ok(rules(result).includes('production-nonliteral-import'));
});

test('fails when a migration exception no longer matches a violation', async (t) => {
  const fixture = await makeFixture(t);
  const result = await checkBoundaries({
    root: fixture.root,
    exceptions: [
      {
        file: 'apps/missing/index.ts',
        specifier: 'node:fs',
        rule: 'production-node-builtin',
        owner: 'Hub',
        reason: 'Temporary fixture migration exception.',
        removeStep: 2,
      },
    ],
  });

  assert.ok(rules(result).includes('stale-exception'));
  assert.deepEqual(result.exceptionsUsed, []);
});
