import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, '..');
const outputDirectory = resolve(packageDirectory, 'dist');
const require = createRequire(import.meta.url);

export function buildProtocol() {
  rmSync(outputDirectory, { recursive: true, force: true });
  const compiler = require.resolve('typescript/bin/tsc');
  execFileSync(
    process.execPath,
    [compiler, '-p', resolve(packageDirectory, 'tsconfig.build.json')],
    {
      stdio: 'inherit',
    },
  );
  buildSync({
    entryPoints: [resolve(packageDirectory, 'src/bridge/deck-bridge.ts')],
    outfile: resolve(outputDirectory, 'deck-bridge.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildProtocol();
