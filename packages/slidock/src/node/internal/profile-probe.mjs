import { readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from '@slidock/slidev-adapter/runtime';
import { compileContract, stableJson } from './profile-contract.mjs';

async function contentRevision(root) {
  const hash = createHash('sha256');
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) hash.update(relative(root, file)).update(await readFile(file));
    }
  }
  await walk(root);
  return hash.digest('hex');
}

export async function probeProfile(job) {
  const runtime = await resolveRuntime(job.profile.dependencyRoot);
  const options = await runtime.api.resolveOptions(
    { entry: job.deck.entry, theme: job.profile.theme, withoutNotes: true, routerMode: 'history' },
    'build',
  );
  if (options.addonRoots?.length)
    throw new Error(`Deck ${job.deck.id}: addons are unsupported in the multi-profile PoC`);
  const rootPaths = new Set([options.userRoot]);
  let directory = dirname(job.deck.entry);
  while (
    directory === job.sourceRoot ||
    (relative(job.sourceRoot, directory) && !relative(job.sourceRoot, directory).startsWith('..'))
  ) {
    rootPaths.add(directory);
    if (directory === job.sourceRoot) break;
    directory = dirname(directory);
  }
  for (const localRoot of rootPaths) {
    const entries = await readdir(localRoot, { withFileTypes: true });
    const unsupported = entries.find(
      (entry) =>
        ['setup', 'components', 'layouts', 'styles'].includes(entry.name) ||
        /^(?:global-(?:top|bottom)|custom-nav-controls)\.vue$|^(?:vite|uno)\.config\./.test(
          entry.name,
        ),
    );
    if (unsupported)
      throw new Error(
        `Deck ${job.deck.id}: local ${join(localRoot, unsupported.name)} is unsupported; shared setup/components/layouts must live in its declared theme`,
      );
  }
  const themeRoot = await realpath(job.profile.theme);
  const themePackage = JSON.parse(await readFile(join(themeRoot, 'package.json'), 'utf8'));
  const contract = {
    cliVersion: runtime.cliVersion,
    clientVersion: runtime.clientVersion,
    cliEntry: runtime.cliEntry,
    themeRoot,
    themeRevision: await contentRevision(themeRoot),
    compile: compileContract(options),
  };
  return {
    runtimeVersion: runtime.cliVersion,
    theme: `${themePackage.name}@${themePackage.version}`,
    contract,
    signature: createHash('sha256').update(stableJson(contract)).digest('hex'),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const jobPath = process.argv[2];
  if (!jobPath || !isAbsolute(jobPath))
    throw new Error('profile probe requires an absolute job JSON path');
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  await writeFile(job.output, JSON.stringify(await probeProfile(job), null, 2));
}
