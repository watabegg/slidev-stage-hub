#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { connectStage } from '@slidock/slive-tools';

export { connectStage } from '@slidock/slive-tools';
export {
  fetchPlayerDocument,
  normalizeOrigin,
  validatePlayerDocument,
} from '@slidock/slive-tools/node';

const nativeAppRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultConfigPath = path.join(nativeAppRoot, 'artifacts/local-config.json');

export function connect(origin, options = {}) {
  return connectStage({
    origin,
    configPath: path.resolve(options.configPath ?? defaultConfigPath),
    headersFile: options.headersFile === undefined ? undefined : path.resolve(options.headersFile),
    fetchImpl: options.fetchImpl,
  });
}

export function parseConnectArgs(
  argv,
  { cwd = process.cwd(), defaultConfig = defaultConfigPath } = {},
) {
  const usage =
    'usage: node apps/slive/scripts/connect.mjs <origin> [--headers-file <path>] [--config <path>]';
  if (!Array.isArray(argv) || argv.length === 0) throw new Error(usage);
  const [origin, ...rest] = argv;
  if (!origin || origin.startsWith('-')) throw new Error(usage);
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option !== '--headers-file' && option !== '--config') throw new Error(usage);
    const value = rest[++index];
    if (!value || value.startsWith('--') || values.has(option)) throw new Error(usage);
    values.set(option, value);
  }
  return {
    origin,
    headersFile: values.get('--headers-file'),
    configPath: path.resolve(cwd, values.get('--config') ?? defaultConfig),
  };
}

export async function runConnectCli(argv = process.argv.slice(2)) {
  const args = parseConnectArgs(argv);
  const { config, configPath, unsupportedDecks } = await connectStage({
    origin: args.origin,
    configPath: args.configPath,
    headersFile: args.headersFile === undefined ? undefined : path.resolve(args.headersFile),
  });
  console.log(
    `Connected to ${config.viewerOrigin}; loaded ${config.decks.length} supported deck(s).`,
  );
  for (const deck of unsupportedDecks)
    console.warn(`Skipped unsupported deck ${deck.id}: ${deck.reason}`);
  if (config.authHeadersFile) console.log(`Authentication header file: ${config.authHeadersFile}`);
  console.log(`Native config written to ${configPath}`);
  return { config, configPath, unsupportedDecks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runConnectCli().catch((error) => {
    console.error(`Connection failed: ${error.message}`);
    process.exitCode = 1;
  });
}
