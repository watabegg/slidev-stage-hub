import { readFile, stat } from 'node:fs/promises';
import { validatePlayerDocument } from '@slidock/protocol/contracts';
import { normalizeOrigin, readAuthHeadersFile } from '@slidock/slive-tools/node';
import { connectStage, prepareStage, type StageToolsError } from '@slidock/slive-tools';
import { dirname, isAbsolute, resolve } from 'node:path';
import { type ParseArgsOptionsConfig } from 'node:util';
import { CliFailure, failInput, failRuntime, type DoctorCheck } from './errors.js';
import { emitSuccess, emitDoctorResult } from './output.js';
import {
  callerPath,
  isRecord,
  optionBoolean,
  optionString,
  parseCommand,
  requireString,
  resolveOptionalConfig,
  CLI_VERSION,
  type JsonRecord,
  type ParsedCommand,
} from './args.js';

const STAGE_SETTINGS_KEYS = new Set([
  'schemaVersion',
  'site',
  'fixturesRoot',
  'outputConfig',
  'receiptPath',
  'legacySourceRoot',
  'dependencyRoot',
  'origin',
  'headersFile',
]);

function validateStageSettings(value: unknown): JsonRecord {
  if (!isRecord(value) || value.schemaVersion !== 1)
    failInput('Stage CLI settings must be a JSON object with schemaVersion 1', 'INVALID_CONFIG');
  if (Object.keys(value).some((key) => !STAGE_SETTINGS_KEYS.has(key)))
    failInput(
      'Stage settings contain an unsupported key; generated runtime configs belong in --output-config',
      'INVALID_CONFIG',
    );
  for (const key of [
    'site',
    'fixturesRoot',
    'outputConfig',
    'receiptPath',
    'legacySourceRoot',
    'dependencyRoot',
    'origin',
    'headersFile',
  ])
    if (value[key] !== undefined) requireString(value[key], `Stage settings ${key}`);
  return value;
}

function resolveStageSettingsPath(value: string | undefined, baseDir: string): string | undefined {
  if (value === undefined) return undefined;
  return resolve(baseDir, value);
}

async function loadStageSettings(
  cwd: string,
  values: ParsedCommand['values'],
): Promise<{ settings: JsonRecord; settingsPath?: string; settingsDir: string }> {
  const loaded = await resolveOptionalConfig(
    cwd,
    optionString(values, 'config'),
    'stage.config.json',
  );
  const settings = loaded.value === undefined ? {} : validateStageSettings(loaded.value);
  return {
    settings,
    settingsDir: loaded.path ? dirname(loaded.path) : cwd,
  };
}

function stagePath(
  flagValue: string | undefined,
  settingValue: unknown,
  settingsDir: string,
  cwd: string,
  fallback: string | undefined,
): string | undefined {
  if (flagValue !== undefined) return callerPath(cwd, flagValue);
  if (settingValue !== undefined)
    return resolveStageSettingsPath(requireString(settingValue, 'Stage path'), settingsDir);
  return fallback === undefined ? undefined : resolve(cwd, fallback);
}

function stageOptions(command: string): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = { config: { type: 'string' } };
  if (command === 'prepare') {
    Object.assign(options, {
      site: { type: 'string' },
      'fixtures-root': { type: 'string' },
      'output-config': { type: 'string' },
      receipt: { type: 'string' },
      'legacy-source-root': { type: 'string' },
      'dependency-root': { type: 'string' },
    });
  } else if (command === 'connect') {
    Object.assign(options, {
      'output-config': { type: 'string' },
      origin: { type: 'string' },
      'headers-file': { type: 'string' },
    });
  } else if (command === 'doctor') {
    Object.assign(options, { 'output-config': { type: 'string' } });
  }
  return options;
}

function doctorCheck(checks: DoctorCheck[], name: string, ok: boolean, message: string): void {
  checks.push({ name, ok, message });
}

function validRuntimeNotes(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((note) => {
    if (!isRecord(note)) return false;
    if (
      typeof note.source !== 'string' ||
      !isAbsolute(note.source) ||
      typeof note.revision !== 'string' ||
      note.revision.length === 0 ||
      !Array.isArray(note.slots)
    )
      return false;
    return note.slots.every((slot) => {
      if (slot === null) return true;
      return (
        isRecord(slot) &&
        Number.isSafeInteger(slot.start) &&
        Number.isSafeInteger(slot.end) &&
        (slot.start as number) >= 0 &&
        (slot.end as number) >= (slot.start as number)
      );
    });
  });
}

async function requireDirectory(path: string, label: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory())
      failInput(`${label} must be an existing directory`, 'INVALID_PATH');
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    failInput(`${label} must be an existing directory`, 'INVALID_PATH');
  }
}

async function runStageDoctor(parsed: ParsedCommand, cwd: string, json: boolean): Promise<void> {
  if (parsed.positionals.length !== 0)
    failInput('slive doctor does not accept positional arguments');
  const { settings, settingsDir } = await loadStageSettings(cwd, parsed.values);
  const outputConfig = stagePath(
    optionString(parsed.values, 'output-config'),
    settings.outputConfig,
    settingsDir,
    cwd,
    '.slidev-stage/local-config.json',
  )!;
  const checks: DoctorCheck[] = [];
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const nodeReady = major > 24 || (major === 24 && (minor > 15 || (minor === 15 && patch >= 0)));
  doctorCheck(
    checks,
    'node-version',
    nodeReady,
    nodeReady ? `Node.js ${process.versions.node}` : 'Node.js 24.15.0 or newer is required',
  );

  let runtime: unknown;
  try {
    runtime = JSON.parse(await readFile(outputConfig, 'utf8')) as unknown;
    doctorCheck(checks, 'runtime-config', true, 'Runtime config is readable JSON');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    doctorCheck(
      checks,
      'runtime-config',
      false,
      missing ? 'Runtime config is missing' : 'Runtime config could not be read or parsed',
    );
  }

  if (runtime === undefined) {
    doctorCheck(checks, 'schema', false, 'Runtime config schema could not be checked');
    doctorCheck(checks, 'native-decks', false, 'Native decks could not be checked');
    doctorCheck(checks, 'playback', false, 'Playback target could not be checked');
    doctorCheck(checks, 'source-root', false, 'Approved source root could not be checked');
  } else if (!isRecord(runtime)) {
    doctorCheck(checks, 'schema', false, 'Runtime config must be a JSON object');
    doctorCheck(checks, 'native-decks', false, 'Native decks could not be checked');
    doctorCheck(checks, 'playback', false, 'Playback target could not be checked');
    doctorCheck(checks, 'source-root', false, 'Approved source root could not be checked');
  } else {
    const notesOk = validRuntimeNotes(runtime.notes);
    doctorCheck(
      checks,
      'notes',
      notesOk,
      notesOk ? 'Runtime notes map is valid' : 'Runtime notes map is invalid',
    );
    const schemaOk = runtime.schemaVersion === undefined || runtime.schemaVersion === 1;
    doctorCheck(
      checks,
      'schema',
      schemaOk,
      schemaOk
        ? runtime.schemaVersion === undefined
          ? 'Legacy config schema is supported'
          : 'Runtime schemaVersion 1 is supported'
        : 'Runtime schemaVersion is unsupported',
    );
    try {
      if (!Array.isArray(runtime.decks)) throw new Error('invalid decks');
      validatePlayerDocument({
        schemaVersion: 1,
        protocolVersion: 1,
        decks: runtime.decks,
        unsupportedDecks: [],
      });
      doctorCheck(checks, 'native-decks', true, `Validated ${runtime.decks.length} native decks`);
    } catch {
      doctorCheck(checks, 'native-decks', false, 'Runtime native deck registry is invalid');
    }

    const siteConfigured = runtime.siteRoot !== undefined;
    const remoteConfigured = runtime.viewerOrigin !== undefined;
    const legacyLocal = runtime.schemaVersion === undefined && !remoteConfigured;
    if (siteConfigured === remoteConfigured && !legacyLocal) {
      doctorCheck(
        checks,
        'playback',
        false,
        'Config must select exactly one local site or remote origin',
      );
      doctorCheck(checks, 'source-root', false, 'Approved source root could not be checked');
    } else {
      const isRemote = remoteConfigured;
      let normalizedOrigin: string | undefined;
      let targetReady = false;
      if (isRemote) {
        try {
          normalizedOrigin = normalizeOrigin(runtime.viewerOrigin);
          targetReady = true;
        } catch {
          targetReady = false;
        }
      } else {
        const siteRoot =
          legacyLocal && !siteConfigured
            ? resolve(dirname(outputConfig), 'site')
            : runtime.siteRoot;
        if (typeof siteRoot === 'string' && isAbsolute(siteRoot) && !siteRoot.includes('\0')) {
          try {
            targetReady = (await stat(siteRoot)).isDirectory();
          } catch {
            targetReady = false;
          }
        }
      }
      doctorCheck(
        checks,
        'playback',
        targetReady,
        targetReady
          ? isRemote
            ? 'Remote origin is valid'
            : 'Local site directory exists'
          : isRemote
            ? 'Remote origin is invalid'
            : 'Local site directory is missing or invalid',
      );

      const approvedRoot = runtime.approvedSourceRoot;
      let sourceReady =
        typeof approvedRoot === 'string' &&
        isAbsolute(approvedRoot) &&
        !approvedRoot.includes('\0');
      if (sourceReady && !isRemote) {
        try {
          sourceReady = (await stat(approvedRoot as string)).isDirectory();
        } catch {
          sourceReady = false;
        }
      }
      doctorCheck(
        checks,
        'source-root',
        sourceReady,
        sourceReady
          ? isRemote
            ? 'Approved source root path is absolute'
            : 'Approved source directory exists'
          : 'Approved source root is missing or invalid',
      );

      if (runtime.authHeadersFile !== undefined) {
        if (
          !isRemote ||
          typeof runtime.authHeadersFile !== 'string' ||
          !isAbsolute(runtime.authHeadersFile) ||
          !normalizedOrigin
        ) {
          doctorCheck(checks, 'auth-headers', false, 'Authentication header config is invalid');
        } else {
          try {
            await readAuthHeadersFile(runtime.authHeadersFile, normalizedOrigin, normalizeOrigin);
            doctorCheck(
              checks,
              'auth-headers',
              true,
              'Authentication header file is valid and private',
            );
          } catch {
            doctorCheck(
              checks,
              'auth-headers',
              false,
              'Authentication header file is invalid or inaccessible',
            );
          }
        }
      } else {
        doctorCheck(checks, 'auth-headers', true, 'No authentication header file is configured');
      }
    }
  }

  const ready = checks.every((check) => check.ok);
  emitDoctorResult('slive doctor', ready, checks, json);
  if (!ready) process.exitCode = 1;
}

async function runStagePrepareOrConnect(
  command: 'prepare' | 'connect',
  parsed: ParsedCommand,
  cwd: string,
  json: boolean,
): Promise<void> {
  const { settings, settingsDir } = await loadStageSettings(cwd, parsed.values);
  const outputConfig = stagePath(
    optionString(parsed.values, 'output-config'),
    settings.outputConfig,
    settingsDir,
    cwd,
    '.slidev-stage/local-config.json',
  )!;
  if (command === 'prepare') {
    if (parsed.positionals.length !== 0)
      failInput('slive prepare does not accept positional arguments');
    const site = stagePath(
      optionString(parsed.values, 'site'),
      settings.site,
      settingsDir,
      cwd,
      'dist',
    )!;
    const fixturesRoot = stagePath(
      optionString(parsed.values, 'fixtures-root'),
      settings.fixturesRoot,
      settingsDir,
      cwd,
      'slides',
    )!;
    const receiptPath = stagePath(
      optionString(parsed.values, 'receipt'),
      settings.receiptPath,
      settingsDir,
      cwd,
      undefined,
    );
    const legacySourceRoot = stagePath(
      optionString(parsed.values, 'legacy-source-root'),
      settings.legacySourceRoot,
      settingsDir,
      cwd,
      undefined,
    );
    const dependencyRoot = stagePath(
      optionString(parsed.values, 'dependency-root'),
      settings.dependencyRoot,
      settingsDir,
      cwd,
      undefined,
    );
    await requireDirectory(site, 'Stage site');
    await requireDirectory(fixturesRoot, 'Stage fixtures root');
    if (legacySourceRoot !== undefined)
      await requireDirectory(legacySourceRoot, 'Legacy source root');
    if (dependencyRoot !== undefined) await requireDirectory(dependencyRoot, 'Dependency root');
    try {
      const result = await prepareStage({
        site,
        fixturesRoot,
        configPath: outputConfig,
        ...(receiptPath === undefined ? {} : { receiptPath }),
        ...(legacySourceRoot === undefined ? {} : { legacySourceRoot }),
        ...(dependencyRoot === undefined ? {} : { dependencyRoot }),
        onProgress: ({ phase }) => process.stderr.write(`slive prepare: ${phase}\n`),
      });
      emitSuccess(
        'slive prepare',
        {
          configPath: result.configPath,
          siteRoot: result.siteRoot,
          deckCount: result.config.decks.length,
        },
        json,
        `Prepared ${result.config.decks.length} decks at ${result.configPath}`,
      );
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      const code = isStageError(error) ? error.code : 'PREPARE_FAILED';
      failRuntime(
        `Stage prepare failed (${code}); check the site, receipt, approved source root, and parser dependencies`,
        'PREPARE_FAILED',
      );
    }
    return;
  }

  if (parsed.positionals.length > 1)
    failInput('slive connect accepts one origin positional argument');
  const originFlag = optionString(parsed.values, 'origin');
  const positionalOrigin = parsed.positionals[0];
  if (originFlag !== undefined && positionalOrigin !== undefined)
    failInput('provide the connect origin either positionally or with --origin, not both');
  const rawOrigin = originFlag ?? positionalOrigin ?? (settings.origin as string | undefined);
  if (rawOrigin === undefined) failInput('slive connect requires an origin or --origin');
  let origin: string;
  try {
    origin = normalizeOrigin(rawOrigin);
  } catch {
    failInput('Stage origin must be an HTTPS root or exact HTTP loopback origin', 'INVALID_ORIGIN');
  }
  const headersFile = stagePath(
    optionString(parsed.values, 'headers-file'),
    settings.headersFile,
    settingsDir,
    cwd,
    undefined,
  );
  if (headersFile !== undefined) {
    try {
      await readAuthHeadersFile(headersFile, origin, normalizeOrigin);
    } catch {
      failInput('Stage authentication header file is invalid or inaccessible', 'INVALID_AUTH_FILE');
    }
  }
  try {
    const result = await connectStage({
      origin,
      configPath: outputConfig,
      ...(headersFile === undefined ? {} : { headersFile }),
    });
    const unsupportedDeckIds = result.unsupportedDecks.map((deck) => deck.id);
    emitSuccess(
      'slive connect',
      { configPath: result.configPath, deckCount: result.config.decks.length, unsupportedDeckIds },
      json,
      `Connected ${result.config.decks.length} decks at ${result.configPath}`,
    );
  } catch (error) {
    const code = isStageError(error) ? error.code : 'CONNECT_FAILED';
    failRuntime(
      `Stage connect failed (${code}); check the endpoint, network, and authentication-header settings`,
      'CONNECT_FAILED',
    );
  }
}

function isStageError(error: unknown): error is StageToolsError {
  return isRecord(error) && typeof error.code === 'string';
}

function stageHelp(): string {
  return [
    'Usage: slive <prepare|connect|doctor> [options] [origin]',
    '',
    'Commands:',
    '  prepare     Copy a Hub site into a local Stage runtime',
    '  connect     Fetch and validate a remote native-player.json',
    '  doctor      Read and validate the configured Stage runtime',
    '',
    'Common options: --config PATH, --json, --help (-h), --version',
    'prepare: --site PATH --fixtures-root PATH --output-config PATH --receipt PATH',
    '         --legacy-source-root PATH --dependency-root PATH',
    'connect: ORIGIN (or --origin ORIGIN) --headers-file PATH --output-config PATH',
    'doctor:  --output-config PATH (read-only; no native OS/binary readiness check)',
    '--config reads CLI settings; --output-config selects the generated runtime config.',
    'Default runtime config: ./.slidev-stage/local-config.json',
    'Settings file: ./stage.config.json (schemaVersion 1)',
  ].join('\n');
}

export async function runStage(
  command: string | undefined,
  args: string[],
  cwd: string,
): Promise<void> {
  if (command === undefined) {
    emitSuccess('stage', { help: stageHelp() }, args.includes('--json'), stageHelp());
    return;
  }
  const parsed = parseCommand('stage', command, args, stageOptions(command));
  const json = optionBoolean(parsed.values, 'json') ?? false;
  if (optionBoolean(parsed.values, 'help')) {
    emitSuccess(`slive ${command}`, { help: stageHelp() }, json, stageHelp());
    return;
  }
  if (optionBoolean(parsed.values, 'version')) {
    emitSuccess(`slive ${command}`, { version: CLI_VERSION }, json, CLI_VERSION);
    return;
  }
  if (!['prepare', 'connect', 'doctor'].includes(command))
    failInput('unknown stage command', 'UNKNOWN_COMMAND');
  if (command === 'doctor') {
    await runStageDoctor(parsed, cwd, json);
    return;
  }
  await runStagePrepareOrConnect(command as 'prepare' | 'connect', parsed, cwd, json);
}
