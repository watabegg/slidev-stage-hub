import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const stage = join(repository, 'apps/slive');
const evidence = join(repository, 'artifacts/step4');
const checks = [];
async function run(name, command, args, cwd = repository) {
  console.log(`Stage verification: ${name}`);
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_AT_BRIDGE: process.env.NO_AT_BRIDGE ?? '1', CARGO_BUILD_JOBS: '2' },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? accept() : reject(new Error(`${name} failed (${code})`)),
    );
  });
  checks.push(name);
}

await mkdir(evidence, { recursive: true });
const emptyCwd = await mkdtemp(join(tmpdir(), 'stage-native-cwd-'));
try {
  if (process.platform !== 'linux' || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY))
    throw new Error(
      'Native WebKit ready gate requires a Linux desktop display; native QA was not run',
    );
  await run('prepare', process.execPath, [join(stage, 'scripts/prepare.mjs')]);
  await run(
    'desktop build',
    'bash',
    [
      '-c',
      'source "$1"; exec nice -n 10 cargo build --locked -p slive --features desktop',
      'stage-build',
      join(stage, 'scripts/desktop-env.sh'),
    ],
    stage,
  );
  await run('HTTP/HTTPS bridge', process.execPath, [join(stage, 'scripts/verify-remote.mjs')]);
  await run('persistent iframe', process.execPath, [join(stage, 'scripts/verify-flicker.mjs')]);
  await run('native WebKit from empty cwd', 'python3', [
    join(stage, 'scripts/verify.py'),
    '--config',
    join(stage, 'artifacts/local-config.json'),
    '--cwd',
    emptyCwd,
    '--log',
    join(evidence, 'native-qa.log'),
  ]);
  await writeFile(
    join(evidence, 'gate.json'),
    JSON.stringify({ status: 'passed', checks }, null, 2) + '\n',
  );
} catch (error) {
  await writeFile(
    join(evidence, 'gate.json'),
    JSON.stringify({ status: 'failed', checks, error: error.message }, null, 2) + '\n',
  );
  throw error;
} finally {
  await rm(emptyCwd, { recursive: true, force: true });
}
