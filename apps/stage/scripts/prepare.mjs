#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { prepareStage } from '@slidev-stage-hub/stage-tools';
import { canonicalEntryForId } from '@slidev-stage-hub/stage-tools/node';

export { prepareStage } from '@slidev-stage-hub/stage-tools';
export {
  canonicalEntryForId,
  inspectDeckSource,
  loadSlidevParser,
  readManifestIfPresent,
  resolveManifestSources,
  validateManifest,
} from '@slidev-stage-hub/stage-tools/node';

const nativeAppRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(nativeAppRoot, '../..');
const hubRoot = path.join(repoRoot, 'packages/hub');
const defaultSite = path.join(hubRoot, 'artifacts/module-graph-offline/site');
const defaultFixturesRoot = path.join(repoRoot, 'examples/fixtures');
const defaultConfig = path.join(nativeAppRoot, 'artifacts/local-config.json');
const fallbackIds = ['aaa/aaa1', 'aaa/aaa2', 'bbb/bbb1', 'bbb/bbb2'];

export function parseArgs(
  argv,
  {
    cwd = process.cwd(),
    defaultSitePath = defaultSite,
    defaultFixturesRootPath = defaultFixturesRoot,
    defaultConfigPath = defaultConfig,
  } = {},
) {
  if (!Array.isArray(argv)) throw new Error('arguments must be an array');
  const values = new Map();
  let positionalSite;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['--site', '--fixtures-root', '--config', '--receipt'].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
      if (values.has(argument)) throw new Error(`${argument} may only be provided once`);
      values.set(argument, value);
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      if (positionalSite !== undefined)
        throw new Error('only one positional site path is supported');
      positionalSite = argument;
    }
  }

  if (values.has('--site') && positionalSite !== undefined)
    throw new Error('provide the site with either --site or a positional path, not both');
  return {
    site: path.resolve(cwd, values.get('--site') ?? positionalSite ?? defaultSitePath),
    fixturesRoot: path.resolve(cwd, values.get('--fixtures-root') ?? defaultFixturesRootPath),
    configPath: path.resolve(cwd, values.get('--config') ?? defaultConfigPath),
    receiptPath: values.has('--receipt') ? path.resolve(cwd, values.get('--receipt')) : undefined,
  };
}

export async function runPrepareCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { config, configPath, siteRoot } = await prepareStage({
    ...args,
    legacySourceRoot: hubRoot,
    dependencyRoot: process.env.SLIDEV_LAB_DEPENDENCY_ROOT
      ? path.resolve(process.env.SLIDEV_LAB_DEPENDENCY_ROOT)
      : undefined,
    fallbackDecks: fallbackIds.map((id) => ({
      id,
      sourcePath: path.join(args.fixturesRoot, ...id.split('/'), 'slides.md'),
      entry: canonicalEntryForId(id),
    })),
  });
  console.log(
    JSON.stringify(
      {
        site: args.site,
        siteRoot,
        configPath,
        decks: config.decks.length,
        notes: Object.fromEntries(
          Object.entries(config.notes).map(([id, map]) => [id, map.slots.map(Boolean)]),
        ),
      },
      null,
      2,
    ),
  );
  return { config, configPath, siteRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPrepareCli().catch((error) => {
    console.error(`Preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
