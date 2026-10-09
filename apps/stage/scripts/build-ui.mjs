import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProtocol } from '../../../packages/protocol/scripts/build.mjs';

const stageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildNativeUi() {
  const compiler = resolve(stageRoot, '../../node_modules/typescript/bin/tsc');
  if (!existsSync(compiler))
    throw new Error('TypeScript is missing. Run pnpm install --frozen-lockfile at the repository root.');
  buildProtocol();
  execFileSync(process.execPath, [compiler, '-p', resolve(stageRoot, 'tsconfig.json')], { stdio: 'inherit' });
  mkdirSync(resolve(stageRoot, 'dist'), { recursive: true });
  for (const name of ['index.html', 'style.css'])
    copyFileSync(resolve(stageRoot, 'src', name), resolve(stageRoot, 'dist', name));
  copyFileSync(
    resolve(stageRoot, '../../packages/protocol/dist/deck-bridge.js'),
    resolve(stageRoot, 'dist/deck-bridge.js'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildNativeUi();
