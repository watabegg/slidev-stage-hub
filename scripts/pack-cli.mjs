import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
export const packageNames = ['protocol', 'slidev-adapter', 'slidock', 'slive-tools', 'cli'];

export function runProcess(command, args, { cwd = repository, env = process.env } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.once('error', reject);
    child.once('close', (code) => accept({ code, stdout, stderr }));
  });
}

export async function packPackages(destination, names = packageNames) {
  const output = resolve(destination);
  await mkdir(join(output, 'tarballs'), { recursive: true });
  const dependencies = {};
  for (const name of names) {
    const directory = join(repository, 'packages', name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const filename = `slidock-${name}-${manifest.version}.tgz`;
    const result = await runProcess('pnpm', ['pack', '--out', join(output, 'tarballs', filename)], {
      cwd: directory,
    });
    if (result.code !== 0) throw new Error(`Packing ${name} failed: ${result.stderr}`);
    dependencies[manifest.name] = `file:./tarballs/${filename}`;
  }
  await writeFile(
    join(output, 'package.json'),
    JSON.stringify(
      {
        name: 'slidock-private-install',
        private: true,
        type: 'module',
        packageManager: 'pnpm@12.3.4',
        engines: { node: '>=24.15.0' },
        dependencies,
      },
      null,
      2,
    ) + '\n',
  );
  // Keep the tested Slidev toolchain pins in the standalone installation as well.
  const workspace = await readFile(join(repository, 'pnpm-workspace.yaml'), 'utf8');
  const toolchainOverrides = workspace.slice(
    workspace.indexOf('\noverrides:\n') + '\noverrides:\n'.length,
  );
  if (!workspace.includes('\noverrides:\n'))
    throw new Error('Workspace toolchain overrides missing');
  const localOverrides = Object.entries(dependencies)
    .map(([name, value]) => `  '${name}': '${value}'`)
    .join('\n');
  await writeFile(
    join(output, 'pnpm-workspace.yaml'),
    `allowBuilds:\n  esbuild: true\n  playwright-chromium: false\noverrides:\n${localOverrides}\n${toolchainOverrides}`,
  );
  return { output, packages: Object.keys(dependencies) };
}

export function packCli(destination) {
  return packPackages(destination);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await packCli(join(repository, 'artifacts/cli-package'))));
}
