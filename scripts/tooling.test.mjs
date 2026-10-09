import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(tool, args) {
  return spawnSync(path.join(root, 'node_modules', '.bin', tool), args, {
    cwd: root,
    encoding: 'utf8',
  });
}
for (const extension of ['ts', 'mjs', 'vue']) {
  test(`tooling checks and formats ${extension} source`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'stage-hub-tooling-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, `probe.${extension}`);
    // Vue no-unused-vars is unsupported; duplicate keys exercise its script parser.
    const source =
      extension === 'vue'
        ? '<script lang="ts">\nexport default {setup(){return {value:1,value:2}}}\n</script>\n<template><div>probe</div></template>'
        : 'export function probe(){const unused=1;return 2}';
    await writeFile(filename, source);
    const lint = run('oxlint', [
      '-c',
      path.join(root, '.oxlintrc.json'),
      '--deny-warnings',
      filename,
    ]);
    assert.equal(lint.status, 1, lint.stderr);
    assert.match(lint.stdout, extension === 'vue' ? /no-dupe-keys/ : /no-unused-vars/);
    const flags = ['-c', path.join(root, '.oxfmtrc.json')];
    assert.equal(run('oxfmt', [...flags, '--write', filename]).status, 0);
    assert.equal(run('oxfmt', [...flags, '--check', filename]).status, 0);
  });
}
test('formatter leaves Slidev Markdown byte-for-byte unchanged', async (t) => {
  const directory = await mkdtemp(path.join(root, '.tooling-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'slides.md');
  const source = '---\r\ntheme: default\r\n---\r\n# 日本語\r\n<!-- private note -->\r\n';
  await writeFile(filename, source);
  const result = run('oxfmt', [
    '-c',
    path.join(root, '.oxfmtrc.json'),
    '--no-error-on-unmatched-pattern',
    '--write',
    filename,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(filename, 'utf8'), source);
});
