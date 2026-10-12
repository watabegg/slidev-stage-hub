import path from 'node:path';
import type { ValidatedPlayerDocument } from '@slidock/protocol/contracts';
import type { RemoteStageConfig } from './config.js';
import { StageToolsError, withConfigLock, writeConfigAtomically } from './config.js';
import { readAuthHeadersFile } from './auth-headers.mjs';
import { fetchPlayerDocument, normalizeOrigin } from './connect-core.mjs';

export type ConnectStageOptions = {
  origin: string;
  configPath: string;
  headersFile?: string;
  fetchImpl?: typeof fetch;
};
export type ConnectStageResult = {
  config: RemoteStageConfig;
  configPath: string;
  unsupportedDecks: Array<{ id: string; reason: string }>;
};

type FetchPlayerDocumentOptions = {
  fetchImpl?: typeof fetch;
  requestHeaders?: Record<string, string>;
};

function requireAbsolutePath(name: string, value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw new StageToolsError('INVALID_INPUT', `${name} must be an absolute path`);
  return path.resolve(value);
}

/** Fetch and validate remote metadata before atomically changing the selected config. */
export async function connectStage(options: ConnectStageOptions): Promise<ConnectStageResult> {
  try {
    const configInput = requireAbsolutePath('configPath', options.configPath);
    const headersFile =
      options.headersFile === undefined
        ? undefined
        : requireAbsolutePath('headersFile', options.headersFile);
    const origin = normalizeOrigin(options.origin);

    return await withConfigLock(configInput, async (configPath) => {
      const auth =
        headersFile === undefined
          ? undefined
          : await readAuthHeadersFile(headersFile, origin, normalizeOrigin);
      const fetchRemote = fetchPlayerDocument as (
        origin: string,
        options: FetchPlayerDocumentOptions,
      ) => Promise<unknown>;
      const result = (await fetchRemote(origin, {
        fetchImpl: options.fetchImpl,
        requestHeaders: auth?.headers,
      })) as ValidatedPlayerDocument;
      const config: RemoteStageConfig = {
        schemaVersion: 1,
        decks: result.decks,
        notes: {},
        approvedSourceRoot: path.dirname(configPath),
        viewerOrigin: origin,
        ...(auth === undefined ? {} : { authHeadersFile: auth.absolutePath }),
      };
      await writeConfigAtomically(configPath, config);
      return { config, configPath, unsupportedDecks: result.unsupportedDecks };
    });
  } catch (error) {
    if (error instanceof StageToolsError) throw error;
    const message = error instanceof Error ? error.message : 'stage connection failed';
    if (options?.headersFile === undefined)
      throw new StageToolsError('CONNECT_FAILED', message, { cause: error });
    throw new StageToolsError('CONNECT_FAILED', message);
  }
}
