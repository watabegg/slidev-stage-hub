import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { buildHub } from '@slidock/slidock';
import { repositoryRoot } from './runtime-environment.mjs';

const require = createRequire(import.meta.url);
const examples = join(repositoryRoot, 'examples/official-themes');
const { samples } = JSON.parse(await readFile(join(examples, 'sources.json'), 'utf8'));
const profiles = {};
const decks = [];
for (const sample of samples) {
  const entry = join(examples, sample.entry);
  const hash = createHash('sha256')
    .update(await readFile(entry))
    .digest('hex');
  if (hash !== sample.sha256) throw new Error(`Official sample changed: ${sample.entry}`);
  const theme = dirname(require.resolve(`${sample.package}/package.json`));
  const installed = JSON.parse(await readFile(join(theme, 'package.json'), 'utf8'));
  if (installed.version !== sample.version)
    throw new Error(`Theme version changed: ${sample.package}`);
  profiles[sample.profile] = { dependencyRoot: repositoryRoot, theme };
  decks.push({ id: sample.id, entry, profile: sample.profile });
}
const result = await buildHub({
  sourceRoot: join(examples, 'slides'),
  outDir: join(repositoryRoot, 'packages/slidock/artifacts/official-themes/site'),
  frontendEntry: join(examples, 'home.ts'),
  profiles,
  decks,
  offline: false,
  chromiumExecutable: process.env.CHROMIUM_EXECUTABLE,
  onProgress: ({ phase }) => console.log(`Slidock: ${phase}`),
});
console.log(result.output);
