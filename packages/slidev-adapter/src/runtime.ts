import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SlidevParseSync } from './inspect-deck.js';

export const supportedVersions = new Set(['52.15.2', '53.0.0']);

export type SlidevCliApi = Record<string, unknown> & {
  resolveOptions: (...args: unknown[]) => unknown;
  ViteSlidevPlugin: (...args: unknown[]) => unknown;
};

export type SlidevRuntime = {
  cliEntry: string;
  cliRequire: ReturnType<typeof createRequire>;
  cliVersion: string;
  clientVersion: string;
  clientRoot: string;
  api: SlidevCliApi;
};

export type SlidevParserModule = Record<string, unknown> & { parseSync: SlidevParseSync };

export function assertSupportedVersions(cliVersion: string, clientVersion: string): void {
  if (cliVersion !== clientVersion || !supportedVersions.has(cliVersion)) {
    throw new Error(
      `Internal adapters support exact CLI/client 52.15.2 or 53.0.0 pairs; found ${cliVersion}/${clientVersion}`,
    );
  }
}

function assertCliApi(api: Record<string, unknown>, version: string): SlidevCliApi {
  if (typeof api.resolveOptions !== 'function' || typeof api.ViteSlidevPlugin !== 'function')
    throw new Error(
      `Internal adapters require resolveOptions and ViteSlidevPlugin from Slidev CLI ${version}`,
    );
  return api as SlidevCliApi;
}

type SlidevInstallation = {
  cliEntry: string;
  cliRequire: ReturnType<typeof createRequire>;
  cliVersion: string;
  clientVersion: string;
  clientRoot: string;
};

async function resolveSlidevInstallation(dependencyRoot: string): Promise<SlidevInstallation> {
  const requireFromRoot = createRequire(join(dependencyRoot, 'package.json'));
  const cliEntry = await realpath(requireFromRoot.resolve('@slidev/cli/dist/index.mjs'));
  const cliRequire = createRequire(cliEntry);
  const cliPackage = cliRequire.resolve('@slidev/cli/package.json');
  const clientPackage = cliRequire.resolve('@slidev/client/package.json');
  const cliVersion = JSON.parse(await readFile(cliPackage, 'utf8')).version as string;
  const clientVersion = JSON.parse(await readFile(clientPackage, 'utf8')).version as string;
  assertSupportedVersions(cliVersion, clientVersion);
  return {
    cliEntry,
    cliRequire,
    cliVersion,
    clientVersion,
    clientRoot: dirname(clientPackage),
  };
}

export async function resolveRuntime(dependencyRoot: string): Promise<SlidevRuntime> {
  const installation = await resolveSlidevInstallation(dependencyRoot);
  const api = await import(pathToFileURL(installation.cliEntry).href);
  return {
    ...installation,
    api: assertCliApi(api, installation.cliVersion),
  };
}

export async function loadSlidevParser(dependencyRoot: string): Promise<SlidevParserModule> {
  const installation = await resolveSlidevInstallation(dependencyRoot);
  const parserPath = installation.cliRequire.resolve('@slidev/parser/core');
  const parser = await import(pathToFileURL(parserPath).href);
  if (typeof parser.parseSync !== 'function')
    throw new Error('Internal adapters require parseSync from @slidev/parser/core');
  return parser as SlidevParserModule;
}
