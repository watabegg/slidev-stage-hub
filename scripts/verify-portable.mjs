import { spawnSync } from 'node:child_process';
import { repositoryRoot } from './runtime-environment.mjs';

// Run in a fresh checkout/container after install and browser:install.
// No inherited theme/toolchain/browser override may mask a local dependency.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('SLIDEV_') || key === 'CHROMIUM_EXECUTABLE' || key === 'NODE_PATH')
    delete env[key];
}
const commands = [
  ['pnpm', ['typecheck']],
  ['pnpm', ['test']],
  ['pnpm', ['build:slidock']],
  ['pnpm', ['verify:slidock']],
  ['pnpm', ['verify:web-customization']],
  ['pnpm', ['build:slidock:fixtures']],
  ['pnpm', ['verify:slidock:fixtures']],
  ['pnpm', ['slive:prepare']],
  ['pnpm', ['build:slive-ui']],
  ['node', ['apps/slive/scripts/verify-remote.mjs']],
  ['pnpm', ['build:example:watabegg']],
  ['pnpm', ['verify:example:watabegg']],
  ['pnpm', ['verify:workers']],
  ['pnpm', ['--filter', '@slidock/workers', 'verify:fixtures']],
  ['pnpm', ['--filter', '@slidock/workers', 'verify:auth']],
];
for (const [command, args] of commands) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
