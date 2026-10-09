import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { failInput } from './errors.js';

export type Product = 'hub' | 'stage';
export const CLI_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export type JsonRecord = Record<string, unknown>;
export type ParsedCommand = {
  values: Record<string, string | boolean | string[]>;
  positionals: string[];
};

export const COMMON_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  json: { type: 'boolean' },
} satisfies ParseArgsOptionsConfig;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    failInput(`${label} must be a non-empty string`, 'INVALID_CONFIG');
  return value;
}

export function parseCommand(
  product: Product,
  command: string,
  args: string[],
  commandOptions: ParseArgsOptionsConfig,
): ParsedCommand {
  try {
    const parsed = parseArgs({
      args,
      options: { ...COMMON_OPTIONS, ...commandOptions },
      strict: true,
      allowPositionals: true,
      allowNegative: false,
    });
    return { values: parsed.values, positionals: parsed.positionals };
  } catch {
    failInput(`invalid ${product} ${command} arguments`);
  }
}

export function optionString(values: ParsedCommand['values'], name: string): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.includes('\0'))
    failInput(`--${name} requires a non-empty value`);
  return value;
}

export function optionBoolean(values: ParsedCommand['values'], name: string): boolean | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') failInput(`--${name} must be a boolean flag`);
  return value;
}

export function callerPath(cwd: string, value: string): string {
  return resolve(cwd, value);
}

export async function readJsonFile(path: string, label: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    failInput(`${label} could not be read`, 'INVALID_CONFIG');
  }
  try {
    return JSON.parse(source);
  } catch {
    failInput(`${label} must contain valid JSON`, 'INVALID_CONFIG');
  }
}

export async function resolveOptionalConfig(
  cwd: string,
  explicitPath: string | undefined,
  defaultName: string,
): Promise<{ path?: string; value?: unknown }> {
  const configPath = explicitPath ? callerPath(cwd, explicitPath) : resolve(cwd, defaultName);
  if (!explicitPath) {
    try {
      await stat(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      failInput('default configuration path could not be inspected', 'INVALID_CONFIG');
    }
  }
  return { path: configPath, value: await readJsonFile(configPath, 'configuration file') };
}

export function resolveConfigPathValue(value: string, configPath: string): string {
  return resolve(dirname(configPath), value);
}
