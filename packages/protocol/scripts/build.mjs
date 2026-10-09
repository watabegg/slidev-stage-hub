import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function buildProtocol() {
  execFileSync(process.execPath, [resolve(root, '../../node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')], { stdio: 'inherit' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildProtocol();
