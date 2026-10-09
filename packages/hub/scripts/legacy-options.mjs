import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { discoverDecks } from '../dist/node/internal/catalog.mjs';
import { dependencyDirectory, fixtureDirectory, themeDirectory } from './runtime-environment.mjs';

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function legacyEnvironmentOptions(env) {
  const options = {
    dependencyRoot: dependencyDirectory(env),
    theme: themeDirectory(env),
    bootstrap: env.SLIDEV_LAB_BOOTSTRAP === 'tla' ? 'tla' : 'sync',
    isolateDecks: env.SLIDEV_LAB_ISOLATE_DECKS === '1',
  };
  if (env.SLIDEV_LAB_FIXTURES_ROOT) options.sourceRoot = fixtureDirectory(env);
  if (env.CHROMIUM_EXECUTABLE) options.chromiumExecutable = resolve(env.CHROMIUM_EXECUTABLE);
  return options;
}

function configuredOutput(config, configRoot) {
  return typeof config.outDir === 'string' ? resolve(configRoot, config.outDir) : undefined;
}

async function convertProfileConfig(config, configPath, env) {
  if (
    config.schemaVersion !== 1 ||
    !config.fixturesRoot ||
    !record(config.profiles) ||
    !record(config.decks)
  )
    throw new Error(
      'Legacy profile config requires schemaVersion:1, fixturesRoot, profiles and deck assignments',
    );
  const configRoot = dirname(configPath);
  const sourceRoot = resolve(configRoot, config.fixturesRoot);
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([id, profile]) => {
      if (
        !/^[A-Za-z0-9_-]+$/.test(id) ||
        !profile?.dependencyRoot ||
        !profile?.theme ||
        Object.keys(profile).some((key) => !['dependencyRoot', 'theme'].includes(key))
      )
        throw new Error(`Profile ${id} requires exactly dependencyRoot and theme`);
      return [
        id,
        {
          dependencyRoot: resolve(configRoot, profile.dependencyRoot),
          theme: resolve(configRoot, profile.theme),
        },
      ];
    }),
  );
  const discovered = await discoverDecks(sourceRoot);
  const decks = discovered.map((deck) => {
    const profile = config.decks[deck.id];
    if (!profiles[profile])
      throw new Error(`Deck ${deck.id} requires an existing profile assignment`);
    return { id: deck.id, entry: deck.entry, profile };
  });
  for (const id of Object.keys(config.decks))
    if (!decks.some((deck) => deck.id === id))
      throw new Error(`Configured deck ${id} was not discovered`);
  const options = {
    ...legacyEnvironmentOptions(env),
    sourceRoot,
    profiles,
    decks,
  };
  const outDir = configuredOutput(config, configRoot);
  if (outDir) options.outDir = outDir;
  return options;
}

export async function legacyOptions(env = process.env) {
  const configValue = env.SLIDEV_LAB_CONFIG;
  if (!configValue) return { ...legacyEnvironmentOptions(env), sourceRoot: fixtureDirectory(env) };

  const configPath = resolve(configValue);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!record(config)) throw new Error('Hub build config must be a JSON object');
  if ('fixturesRoot' in config) return convertProfileConfig(config, configPath, env);

  const options = { configPath };
  const overrides = legacyEnvironmentOptions(env);
  if (env.SLIDEV_LAB_FIXTURES_ROOT) options.sourceRoot = overrides.sourceRoot;
  if (env.SLIDEV_LAB_DEPENDENCY_ROOT) options.dependencyRoot = overrides.dependencyRoot;
  if (env.SLIDEV_THEME_PATH || env.SLIDEV_LAB_THEME || env.SLIDEV_THEME_DIR)
    options.theme = overrides.theme;
  if (env.SLIDEV_LAB_BOOTSTRAP !== undefined) options.bootstrap = overrides.bootstrap;
  if (env.SLIDEV_LAB_ISOLATE_DECKS !== undefined) options.isolateDecks = overrides.isolateDecks;
  if (env.CHROMIUM_EXECUTABLE) options.chromiumExecutable = overrides.chromiumExecutable;
  const outDir = configuredOutput(config, dirname(configPath));
  if (outDir) options.outDir = outDir;
  return options;
}
