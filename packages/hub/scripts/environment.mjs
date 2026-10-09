import { themeDirectory } from '../../../scripts/runtime-environment.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const theme = resolve(themeDirectory());
function command(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    return { failed: true, status: error.status, stderr: error.stderr?.toString().trim() };
  }
}
const hashes = {};
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'artifacts'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile())
      hashes[relative(theme, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
visit(theme);
const result = {
  recordedAt: new Date().toISOString(),
  os: command('uname', ['-a']),
  versions: Object.fromEntries(
    ['node', 'pnpm', 'rustc', 'cargo'].map((bin) => [bin, command(bin, ['--version'])]),
  ),
  display: Object.fromEntries(
    ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'DISPLAY'].map((key) => [
      key,
      process.env[key] || null,
    ]),
  ),
  libraries: Object.fromEntries(
    ['gtk+-3.0', 'webkit2gtk-4.1'].map((lib) => [
      lib,
      command('pkg-config', ['--modversion', lib]),
    ]),
  ),
  theme: {
    path: theme,
    head: command('git', ['-C', theme, 'rev-parse', 'HEAD']),
    status: command('git', ['-C', theme, 'status', '--porcelain=v1']),
    hashes,
  },
};
const out = resolve(process.argv[2] || 'artifacts/environment.json');
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(out);
