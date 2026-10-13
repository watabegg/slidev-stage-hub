import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { buildProtocol } from '@slidock/protocol/build';

const stageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function buildNativeUi() {
  let compiler;
  try {
    compiler = require.resolve('typescript/bin/tsc');
  } catch {
    throw new Error(
      'TypeScript is missing. Run pnpm install --frozen-lockfile at the repository root.',
    );
  }
  buildProtocol();
  execFileSync(
    process.execPath,
    [compiler, '--noEmit', '-p', resolve(stageRoot, 'tsconfig.json')],
    {
      stdio: 'inherit',
    },
  );
  mkdirSync(resolve(stageRoot, 'dist'), { recursive: true });
  for (const [entry, output] of [
    ['frame-controller.ts', 'frame-controller.js'],
    ['app.ts', 'app.js'],
    ['qa.ts', 'qa.js'],
  ]) {
    buildSync({
      entryPoints: [resolve(stageRoot, 'src', entry)],
      outfile: resolve(stageRoot, 'dist', output),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
    });
  }
  for (const name of ['index.html', 'style.css', 'slive.svg'])
    copyFileSync(resolve(stageRoot, 'src', name), resolve(stageRoot, 'dist', name));
  copyFileSync(
    fileURLToPath(import.meta.resolve('@slidock/protocol/bridge')),
    resolve(stageRoot, 'dist/deck-bridge.js'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildNativeUi();
