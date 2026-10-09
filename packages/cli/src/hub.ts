import { stat } from 'node:fs/promises';
import { createServer } from '@slidev-stage-hub/hub/serve';
import {
  buildHub,
  generateThumbnails,
  normalizeHubConfig,
  type HubBuildOptions,
} from '@slidev-stage-hub/hub/node';
import { resolve } from 'node:path';
import { type ParseArgsOptionsConfig } from 'node:util';
import { CliFailure, failInput, failRuntime } from './errors.js';
import { emitSuccess } from './output.js';
import {
  callerPath,
  isRecord,
  requireString,
  CLI_VERSION,
  optionBoolean,
  optionString,
  parseCommand,
  resolveOptionalConfig,
  resolveConfigPathValue,
  type JsonRecord,
  type ParsedCommand,
} from './args.js';

type NormalizedHubConfig = Awaited<ReturnType<typeof normalizeHubConfig>>;

const HUB_CONFIG_KEYS = new Set([
  'schemaVersion',
  'frontendEntry',
  'navigation',
  'sourceRoot',
  'outDir',
  'dependencyRoot',
  'theme',
  'decks',
  'profiles',
  'offline',
  'chromiumExecutable',
  'bootstrap',
  'isolateDecks',
]);
const HUB_PATH_KEYS = [
  'sourceRoot',
  'outDir',
  'dependencyRoot',
  'theme',
  'chromiumExecutable',
  'frontendEntry',
];

function ensureKnownKeys(value: JsonRecord, allowed: Set<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    failInput(
      `${label} contains an unsupported key; use schemaVersion 1 fields (see docs/guides/cli.md)`,
      'INVALID_CONFIG',
    );
}

function validateHubConfig(value: unknown): JsonRecord {
  if (!isRecord(value) || value.schemaVersion !== 1)
    failInput('Hub config must be a JSON object with schemaVersion 1', 'INVALID_CONFIG');
  ensureKnownKeys(value, HUB_CONFIG_KEYS, 'Hub config');
  for (const key of HUB_PATH_KEYS)
    if (value[key] !== undefined) requireString(value[key], `Hub config ${key}`);
  for (const key of ['offline', 'isolateDecks'])
    if (value[key] !== undefined && typeof value[key] !== 'boolean')
      failInput(`Hub config ${key} must be boolean`, 'INVALID_CONFIG');
  if (value.bootstrap !== undefined && value.bootstrap !== 'sync' && value.bootstrap !== 'tla')
    failInput('Hub config bootstrap must be sync or tla', 'INVALID_CONFIG');
  if (value.navigation !== undefined) {
    if (!isRecord(value.navigation))
      failInput('Hub navigation must be an object', 'INVALID_CONFIG');
    ensureKnownKeys(
      value.navigation,
      new Set(['enabled', 'homeHref', 'homeLabel']),
      'Hub navigation',
    );
    if (value.navigation.enabled !== undefined && typeof value.navigation.enabled !== 'boolean')
      failInput('Hub navigation.enabled must be boolean', 'INVALID_CONFIG');
    for (const key of ['homeHref', 'homeLabel'])
      if (value.navigation[key] !== undefined)
        requireString(value.navigation[key], `Hub navigation.${key}`);
  }
  if (value.decks !== undefined) {
    if (!Array.isArray(value.decks) || value.decks.length === 0)
      failInput('Hub config decks must be a non-empty array', 'INVALID_CONFIG');
    for (const deck of value.decks) {
      if (!isRecord(deck)) failInput('Hub config deck entries must be objects', 'INVALID_CONFIG');
      ensureKnownKeys(deck, new Set(['id', 'entry', 'profile']), 'Hub config deck');
      requireString(deck.id, 'Hub config deck id');
      requireString(deck.entry, 'Hub config deck entry');
      if (deck.profile !== undefined) requireString(deck.profile, 'Hub config deck profile');
    }
  }
  if (value.profiles !== undefined) {
    if (!isRecord(value.profiles) || Object.keys(value.profiles).length === 0)
      failInput('Hub config profiles must be a non-empty object', 'INVALID_CONFIG');
    for (const profile of Object.values(value.profiles)) {
      if (!isRecord(profile))
        failInput('Hub config profiles must contain objects', 'INVALID_CONFIG');
      ensureKnownKeys(profile, new Set(['dependencyRoot', 'theme']), 'Hub config profile');
      requireString(profile.dependencyRoot, 'Hub config profile dependencyRoot');
      requireString(profile.theme, 'Hub config profile theme');
    }
  }
  return value;
}

function normalizedToOptions(config: NormalizedHubConfig): HubBuildOptions {
  return {
    sourceRoot: config.sourceRoot,
    outDir: config.outDir,
    dependencyRoot: config.dependencyRoot,
    theme: config.theme,
    frontendEntry: config.frontendEntry,
    navigation: config.navigation,
    decks: config.decks.map(({ id, entry, profile }) => ({
      id,
      entry,
      ...(profile === undefined ? {} : { profile }),
    })),
    ...(config.profiles === undefined ? {} : { profiles: config.profiles }),
    offline: config.offline,
    ...(config.chromiumExecutable === undefined
      ? {}
      : { chromiumExecutable: config.chromiumExecutable }),
    bootstrap: config.bootstrap,
    isolateDecks: config.isolateDecks,
  };
}

async function loadHubOptions(
  cwd: string,
  values: ParsedCommand['values'],
): Promise<{ options: HubBuildOptions; configFile?: JsonRecord }> {
  const loaded = await resolveOptionalConfig(
    cwd,
    optionString(values, 'config'),
    'hub.config.json',
  );
  const configFile = loaded.value === undefined ? undefined : validateHubConfig(loaded.value);
  const options: HubBuildOptions = { baseDir: cwd };
  if (loaded.path) options.configPath = loaded.path;

  const pathFlags: Array<[string, keyof HubBuildOptions]> = [
    ['source-root', 'sourceRoot'],
    ['out-dir', 'outDir'],
    ['dependency-root', 'dependencyRoot'],
    ['theme', 'theme'],
    ['frontend-entry', 'frontendEntry'],
    ['chromium-executable', 'chromiumExecutable'],
  ];
  for (const [flag, key] of pathFlags) {
    const value = optionString(values, flag);
    if (value !== undefined) Object.assign(options, { [key]: callerPath(cwd, value) });
  }
  if (!configFile || !Object.hasOwn(configFile, 'sourceRoot'))
    options.sourceRoot ??= resolve(cwd, 'slides');
  if (!configFile || !Object.hasOwn(configFile, 'outDir')) options.outDir ??= resolve(cwd, 'dist');

  const offline = optionBoolean(values, 'offline');
  const noOffline = optionBoolean(values, 'no-offline');
  const isolateDecks = optionBoolean(values, 'isolate-decks');
  if (offline !== undefined && noOffline !== undefined)
    failInput('use either --offline or --no-offline');
  if (offline !== undefined) options.offline = offline;
  if (noOffline !== undefined) options.offline = !noOffline;
  if (isolateDecks !== undefined) options.isolateDecks = isolateDecks;
  const bootstrap = optionString(values, 'bootstrap');
  if (bootstrap !== undefined) {
    if (bootstrap !== 'sync' && bootstrap !== 'tla') failInput('--bootstrap must be sync or tla');
    options.bootstrap = bootstrap;
  }
  return { options, ...(configFile === undefined ? {} : { configFile }) };
}

function hubBuildOptions(): ParseArgsOptionsConfig {
  return {
    config: { type: 'string' },
    'source-root': { type: 'string' },
    'out-dir': { type: 'string' },
    'dependency-root': { type: 'string' },
    theme: { type: 'string' },
    'frontend-entry': { type: 'string' },
    'chromium-executable': { type: 'string' },
    offline: { type: 'boolean' },
    'no-offline': { type: 'boolean' },
    'isolate-decks': { type: 'boolean' },
    bootstrap: { type: 'string' },
  };
}

async function runHubBuildOrCheck(
  command: 'build' | 'check',
  parsed: ParsedCommand,
  cwd: string,
  json: boolean,
): Promise<void> {
  if (parsed.positionals.length !== 0)
    failInput(`hub ${command} does not accept positional arguments`);
  const { options } = await loadHubOptions(cwd, parsed.values);
  let normalized: NormalizedHubConfig;
  try {
    normalized = await normalizeHubConfig(options);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'CONFIG')
      failInput(
        'Hub configuration is invalid; check schema, source, output, theme, and dependency paths',
        'INVALID_CONFIG',
      );
    failRuntime('Hub configuration could not be checked', 'HUB_CHECK_FAILED');
  }

  if (command === 'check') {
    emitSuccess(
      'hub check',
      {
        deckCount: normalized.decks.length,
        deckIds: normalized.decks.map((deck) => deck.id),
        sourceRoot: normalized.sourceRoot,
        outDir: normalized.outDir,
        dependencyRoot: normalized.dependencyRoot,
        theme: normalized.theme,
        frontendEntry: normalized.frontendEntry,
        navigation: normalized.navigation,
        ...(normalized.chromiumExecutable === undefined
          ? {}
          : { chromiumExecutable: normalized.chromiumExecutable }),
      },
      json,
      `Hub config is valid (${normalized.decks.length} decks)`,
    );
    return;
  }

  if (normalized.chromiumExecutable !== undefined) {
    try {
      if (!(await stat(normalized.chromiumExecutable)).isFile())
        failInput('Chromium executable must be a file', 'INVALID_CONFIG');
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      failInput('Chromium executable could not be found', 'INVALID_CONFIG');
    }
  }

  try {
    const result = await buildHub({
      ...normalizedToOptions(normalized),
      onProgress: ({ phase }) => process.stderr.write(`hub build: ${phase}\n`),
    });
    emitSuccess(
      'hub build',
      {
        output: result.output,
        receiptPath: result.receiptPath,
        deckCount: result.receipt.decks.length,
      },
      json,
      `Built ${result.receipt.decks.length} decks to ${result.output}`,
    );
  } catch {
    failRuntime(
      'Hub build failed; inspect the Hub build inputs and local toolchain',
      'BUILD_FAILED',
    );
  }
}

async function loadHubServingConfig(
  cwd: string,
  values: ParsedCommand['values'],
): Promise<{ config?: JsonRecord; configPath?: string }> {
  const loaded = await resolveOptionalConfig(
    cwd,
    optionString(values, 'config'),
    'hub.config.json',
  );
  if (loaded.value === undefined) return {};
  const config = validateHubConfig(loaded.value);
  return { config, ...(loaded.path === undefined ? {} : { configPath: loaded.path }) };
}

async function hubServe(parsed: ParsedCommand, cwd: string, json: boolean): Promise<void> {
  if (parsed.positionals.length !== 0) failInput('hub serve does not accept positional arguments');
  const { config, configPath } = await loadHubServingConfig(cwd, parsed.values);
  const configuredSite = config?.outDir;
  const siteArg = optionString(parsed.values, 'site');
  const site = siteArg
    ? callerPath(cwd, siteArg)
    : configuredSite !== undefined && configPath
      ? resolveConfigPathValue(configuredSite as string, configPath)
      : resolve(cwd, 'dist');
  try {
    if (!(await stat(site)).isDirectory())
      failInput('Hub site must be a directory', 'INVALID_SITE');
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    failInput('Hub site directory does not exist', 'INVALID_SITE');
  }
  const portValue = optionString(parsed.values, 'port') ?? '4174';
  if (!/^\d+$/.test(portValue)) failInput('--port must be an integer from 0 to 65535');
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    failInput('--port must be an integer from 0 to 65535');
  const host = optionString(parsed.values, 'host') ?? '127.0.0.1';
  if (!host || host.includes('\0')) failInput('--host must be a non-empty hostname');

  let server;
  try {
    server = createServer(site);
  } catch {
    failInput('Hub site could not be opened', 'INVALID_SITE');
  }
  await new Promise<void>((accept, reject) => {
    let closing = false;
    const cleanup = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      server.off('error', runtimeError);
    };
    const shutdown = () => {
      if (closing) return;
      closing = true;
      server.close(() => {
        cleanup();
        accept();
      });
      server.closeAllConnections();
    };
    const runtimeError = () => {
      if (!server.listening) {
        cleanup();
        reject(new CliFailure('SERVER_START_FAILED', 'Hub server could not start', 1));
        return;
      }
      process.stderr.write('hub serve: server error\n');
      shutdown();
      process.exitCode = 1;
    };
    server.once('error', runtimeError);
    server.once('close', () => {
      cleanup();
      if (closing) accept();
    });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        shutdown();
        reject(new CliFailure('SERVER_START_FAILED', 'Hub server could not start', 1));
        return;
      }
      const urlHost = address.address.includes(':') ? `[${address.address}]` : address.address;
      const origin = `http://${urlHost}:${address.port}`;
      emitSuccess(
        'hub serve',
        { origin, host: address.address, port: address.port, site },
        json,
        `Serving ${site} at ${origin}`,
      );
    });
  });
}

async function hubThumbnail(parsed: ParsedCommand, cwd: string, json: boolean): Promise<void> {
  if (parsed.positionals.length !== 0)
    failInput('hub thumbnail does not accept positional arguments');
  const { config, configPath } = await loadHubServingConfig(cwd, parsed.values);
  const siteValue = optionString(parsed.values, 'site');
  if (siteValue === undefined) failInput('hub thumbnail requires --site');
  const site = callerPath(cwd, siteValue);
  try {
    if (!(await stat(site)).isDirectory())
      failInput('Hub site must be a directory', 'INVALID_SITE');
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    failInput('Hub site directory does not exist', 'INVALID_SITE');
  }
  const executableFlag = optionString(parsed.values, 'chromium-executable');
  const configuredExecutable = config?.chromiumExecutable;
  const chromiumExecutable = executableFlag
    ? callerPath(cwd, executableFlag)
    : configuredExecutable !== undefined && configPath
      ? resolveConfigPathValue(configuredExecutable as string, configPath)
      : undefined;
  if (chromiumExecutable !== undefined) {
    try {
      if (!(await stat(chromiumExecutable)).isFile())
        failInput('Chromium executable must be a file', 'INVALID_CONFIG');
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      failInput('Chromium executable could not be found', 'INVALID_CONFIG');
    }
  }
  try {
    const thumbnails = await generateThumbnails({
      siteRoot: site,
      ...(chromiumExecutable === undefined ? {} : { chromiumExecutable }),
    });
    emitSuccess(
      'hub thumbnail',
      { count: thumbnails.length, thumbnails },
      json,
      `Generated ${thumbnails.length} thumbnails`,
    );
  } catch {
    failRuntime(
      'Hub thumbnail generation failed; check the built site and Chromium installation or executable',
      'THUMBNAIL_FAILED',
    );
  }
}

function hubHelp(): string {
  return [
    'Usage: hub <build|check|serve|thumbnail|publish> [options]',
    '',
    'Commands:',
    '  build       Build the configured Hub site',
    '  check       Validate Hub config and report effective paths',
    '  serve       Serve a built site (default: ./dist, port 4174)',
    '  thumbnail   Generate thumbnails for a built site',
    '  publish     Reserved for Step 7',
    '',
    'Common options: --config PATH, --json, --help (-h), --version',
    'build/check: --source-root PATH --out-dir PATH --theme PATH --dependency-root PATH',
    '             --chromium-executable PATH --offline | --no-offline',
    '             --bootstrap sync|tla --isolate-decks --frontend-entry PATH',
    'serve:       --site PATH --host HOST --port PORT (0 selects an available port)',
    'thumbnail:   --site PATH --chromium-executable PATH',
    'Settings: ./hub.config.json; defaults: ./slides -> ./dist',
    'Examples: hub check --config ./hub.config.json; hub serve --site ./dist',
  ].join('\n');
}

function hubCommandOptions(command: string): ParseArgsOptionsConfig {
  if (command === 'build' || command === 'check') return hubBuildOptions();
  if (command === 'serve')
    return {
      config: { type: 'string' },
      site: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
    };
  if (command === 'thumbnail')
    return {
      config: { type: 'string' },
      site: { type: 'string' },
      'chromium-executable': { type: 'string' },
    };
  return {};
}

export async function runHub(
  command: string | undefined,
  args: string[],
  cwd: string,
): Promise<void> {
  if (command === undefined) {
    emitSuccess('hub', { help: hubHelp() }, args.includes('--json'), hubHelp());
    return;
  }
  const parsed = parseCommand('hub', command, args, hubCommandOptions(command));
  const json = optionBoolean(parsed.values, 'json') ?? false;
  if (optionBoolean(parsed.values, 'help')) {
    emitSuccess(`hub ${command}`, { help: hubHelp() }, json, hubHelp());
    return;
  }
  if (optionBoolean(parsed.values, 'version')) {
    emitSuccess(`hub ${command}`, { version: CLI_VERSION }, json, CLI_VERSION);
    return;
  }
  if (!['build', 'check', 'serve', 'thumbnail', 'publish'].includes(command))
    failInput('unknown hub command', 'UNKNOWN_COMMAND');
  if (command === 'publish')
    failInput(
      'Hub publish is unsupported until Step 7 defines the publication workflow',
      'UNSUPPORTED',
    );
  if (command === 'build' || command === 'check') {
    await runHubBuildOrCheck(command, parsed, cwd, json);
    return;
  }
  if (command === 'serve') {
    await hubServe(parsed, cwd, json);
    return;
  }
  await hubThumbnail(parsed, cwd, json);
}
