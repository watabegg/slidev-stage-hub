import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NativeDeck } from '@slidock/protocol/contracts';

export type StageToolsErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIG_LOCKED'
  | 'CONFIG_WRITE_FAILED'
  | 'PREPARE_FAILED'
  | 'CONNECT_FAILED';

export class StageToolsError extends Error {
  readonly code: StageToolsErrorCode;

  constructor(code: StageToolsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StageToolsError';
    this.code = code;
  }
}

export type StageNoteSlot = { start: number; end: number } | null;

export type StageDeckNotes = {
  source: string;
  revision: string;
  slots: StageNoteSlot[];
};

export type LocalStageConfig = {
  schemaVersion: 1;
  decks: NativeDeck[];
  notes: Record<string, StageDeckNotes>;
  approvedSourceRoot: string;
  siteRoot: string;
};

export type RemoteStageConfig = {
  schemaVersion: 1;
  decks: NativeDeck[];
  notes: Record<string, never>;
  approvedSourceRoot: string;
  viewerOrigin: string;
  authHeadersFile?: string;
};

export type StageConfig = LocalStageConfig | RemoteStageConfig;

function absolutePath(value: string): string {
  if (!path.isAbsolute(value) || value.includes('\0'))
    throw new StageToolsError('INVALID_INPUT', 'config path must be an absolute path');
  return path.resolve(value);
}

async function canonicalConfigPath(configPath: string): Promise<string> {
  const absolute = absolutePath(configPath);
  const directory = path.dirname(absolute);
  await fs.mkdir(directory, { recursive: true });
  const realDirectory = await fs.realpath(directory);
  return path.join(realDirectory, path.basename(absolute));
}

export async function withConfigLock<T>(
  configPath: string,
  operation: (canonicalPath: string) => Promise<T>,
): Promise<T> {
  const canonicalPath = await canonicalConfigPath(configPath);
  const lockPath = `${canonicalPath}.lock`;
  let handle;
  try {
    handle = await fs.open(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.chmod(0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new StageToolsError(
        'CONFIG_LOCKED',
        `native config is already being updated: ${canonicalPath}`,
        {
          cause: error,
        },
      );
    throw new StageToolsError(
      'CONFIG_WRITE_FAILED',
      `could not lock native config ${canonicalPath}`,
      {
        cause: error,
      },
    );
  }

  try {
    return await operation(canonicalPath);
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

export async function writeConfigAtomically(
  configPath: string,
  config: StageConfig,
): Promise<void> {
  const destination = absolutePath(configPath);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw new StageToolsError(
      'CONFIG_WRITE_FAILED',
      `could not write native config ${destination}`,
      {
        cause: error,
      },
    );
  }
}
