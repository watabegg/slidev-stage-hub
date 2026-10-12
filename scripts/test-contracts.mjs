import { spawnSync } from 'node:child_process';
import { repositoryRoot } from './runtime-environment.mjs';

// Keep the Rust fixture check serial with the package build and JS checks.
for (const [command, args] of [
  ['pnpm', ['build:packages']],
  ['pnpm', ['--filter', '@slidock/protocol', 'test']],
  ['pnpm', ['--filter', '@slidock/slidev-adapter', 'test']],
  ['node', ['--test', 'scripts/wire-contracts.test.mjs']],
  [
    'cargo',
    [
      'test',
      '--locked',
      '--manifest-path',
      'apps/slive/Cargo.toml',
      '-p',
      'slive-core',
      '--test',
      'wire_contracts',
    ],
  ],
]) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
