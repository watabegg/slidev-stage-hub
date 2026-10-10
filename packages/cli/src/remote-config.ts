import { chmod, lstat, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readAuthHeadersFile, normalizeOrigin } from '@slidev-stage-hub/stage-tools/node';
import { isPublicationJobsCapabilities } from '@slidev-stage-hub/protocol/contracts';
import type { PublicationJobsCapabilities } from '@slidev-stage-hub/protocol/contracts';
import { failInput, failRuntime } from './errors.js';
import { isRecord, optionString, type ParsedCommand } from './args.js';

const CANONICAL_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;
const MAX_CAPABILITIES_BYTES = 64 * 1024;
const CAPABILITIES_TIMEOUT_MS = 10_000;

interface HubRemoteProfile {
  schemaVersion: 1;
  origin: string;
  defaultDeckId?: string;
  headersFile?: string;
}

export interface HubRemoteSettings {
  origin: string;
  profilePath?: string;
  defaultDeckId?: string;
  headersFilePath?: string;
  headers: Record<string, string>;
}

export type HubCapabilitiesProbe =
  | { state: 'enabled'; capabilities: PublicationJobsCapabilities }
  | { state: 'disabled'; capabilities: PublicationJobsCapabilities }
  | { state: 'unsupported' };

export class HubCapabilitiesError extends Error {
  constructor(
    readonly code:
      | 'AUTH_FAILED'
      | 'REDIRECTED'
      | 'FETCH_FAILED'
      | 'HTTP_ERROR'
      | 'INVALID_RESPONSE',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HubCapabilitiesError';
  }
}

function normalizeAndValidateOrigin(value: string): string {
  try {
    return normalizeOrigin(value);
  } catch {
    failInput('Hub origin must be an HTTPS root or exact HTTP loopback origin', 'INVALID_ORIGIN');
  }
}

function validateProfile(value: unknown): HubRemoteProfile {
  if (!isRecord(value) || value.schemaVersion !== 1)
    failInput(
      'Hub remote config must be a JSON object with schemaVersion 1',
      'INVALID_REMOTE_CONFIG',
    );
  if (
    Object.keys(value).some(
      (key) => !['schemaVersion', 'origin', 'defaultDeckId', 'headersFile'].includes(key),
    )
  )
    failInput('Hub remote config contains unsupported fields', 'INVALID_REMOTE_CONFIG');
  if (typeof value.origin !== 'string')
    failInput('Hub remote config requires an origin', 'INVALID_REMOTE_CONFIG');
  const origin = normalizeAndValidateOrigin(value.origin);
  if (
    value.defaultDeckId !== undefined &&
    (typeof value.defaultDeckId !== 'string' || !CANONICAL_ID.test(value.defaultDeckId))
  )
    failInput('Hub remote defaultDeckId must be a canonical Hub ID', 'INVALID_REMOTE_CONFIG');
  if (
    value.headersFile !== undefined &&
    (typeof value.headersFile !== 'string' ||
      value.headersFile.length === 0 ||
      value.headersFile.includes('\0'))
  )
    failInput('Hub remote headersFile must be a non-empty path', 'INVALID_REMOTE_CONFIG');
  return {
    schemaVersion: 1,
    origin,
    ...(value.defaultDeckId === undefined ? {} : { defaultDeckId: value.defaultDeckId }),
    ...(value.headersFile === undefined ? {} : { headersFile: value.headersFile }),
  };
}

async function loadProfile(path: string): Promise<HubRemoteProfile | undefined> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    failInput('Hub remote config could not be read', 'INVALID_REMOTE_CONFIG');
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    failInput('Hub remote config must contain valid JSON', 'INVALID_REMOTE_CONFIG');
  }
  return validateProfile(value);
}

export async function loadHubRemoteSettings(
  cwd: string,
  values: ParsedCommand['values'],
  options: { requireProfile?: boolean } = {},
): Promise<HubRemoteSettings> {
  const explicitConfig = optionString(values, 'remote-config');
  const profilePath = resolve(cwd, explicitConfig ?? 'hub.remote.json');
  let exists = false;
  try {
    exists = (await stat(profilePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      failInput('Hub remote config could not be inspected', 'INVALID_REMOTE_CONFIG');
  }
  if (options.requireProfile && !exists)
    failInput(
      'Hub remote config does not exist; run hub init --origin URL',
      'REMOTE_CONFIG_REQUIRED',
    );
  if (explicitConfig !== undefined && !exists)
    failInput('Hub remote config does not exist', 'INVALID_REMOTE_CONFIG');

  const profile = exists ? await loadProfile(profilePath) : undefined;
  const originValue = optionString(values, 'origin') ?? profile?.origin;
  if (originValue === undefined)
    failInput('Hub origin is required; pass --origin or create hub.remote.json', 'INVALID_ORIGIN');
  const origin = normalizeAndValidateOrigin(originValue);
  const defaultDeckId = profile?.defaultDeckId;
  const headersFlag = optionString(values, 'headers-file');
  const headersFilePath = headersFlag
    ? resolve(cwd, headersFlag)
    : profile?.headersFile
      ? resolve(dirname(profilePath), profile.headersFile)
      : undefined;

  let headers: Record<string, string> = {};
  if (headersFilePath !== undefined) {
    try {
      ({ headers } = await readAuthHeadersFile(headersFilePath, origin, normalizeOrigin));
    } catch {
      failInput('Hub authentication header file is invalid or inaccessible', 'INVALID_AUTH_FILE');
    }
  }
  return {
    origin,
    ...(profile === undefined ? {} : { profilePath }),
    ...(defaultDeckId === undefined ? {} : { defaultDeckId }),
    ...(headersFilePath === undefined ? {} : { headersFilePath }),
    headers,
  };
}

export async function createHubRemoteProfile(path: string, originValue: string): Promise<void> {
  const origin = normalizeAndValidateOrigin(originValue);
  const contents = `${JSON.stringify({ schemaVersion: 1, origin }, null, 2)}\n`;
  const absolutePath = resolve(path);
  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    const handle = await open(absolutePath, 'wx', 0o644);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      failInput('Hub remote config already exists; it was not overwritten', 'REMOTE_CONFIG_EXISTS');
    failRuntime('Hub remote config could not be created', 'REMOTE_CONFIG_WRITE_FAILED');
  }
}

export async function probeHubCapabilities(
  settings: HubRemoteSettings,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<HubCapabilitiesProbe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAPABILITIES_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(new URL('/api/capabilities', settings.origin), {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: { accept: 'application/json', ...settings.headers },
        signal: controller.signal,
      });
    } catch {
      throw new HubCapabilitiesError(
        'FETCH_FAILED',
        controller.signal.aborted
          ? 'Hub capabilities check timed out'
          : 'Hub capabilities request failed',
      );
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { state: 'unsupported' };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new HubCapabilitiesError(
        'AUTH_FAILED',
        'Hub capabilities authentication failed',
        response.status,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new HubCapabilitiesError(
        'REDIRECTED',
        'Hub capabilities endpoint redirected',
        response.status,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HubCapabilitiesError(
        'HTTP_ERROR',
        `Hub capabilities API returned HTTP ${response.status}`,
        response.status,
      );
    }
    const length = response.headers.get('content-length');
    if (length && /^\d+$/u.test(length) && Number(length) > MAX_CAPABILITIES_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new HubCapabilitiesError('INVALID_RESPONSE', 'Hub capabilities response was invalid');
    }
    let value: unknown;
    try {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_CAPABILITIES_BYTES) throw new Error('response too large');
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new HubCapabilitiesError('INVALID_RESPONSE', 'Hub capabilities response was invalid');
    }
    if (!isPublicationJobsCapabilities(value))
      throw new HubCapabilitiesError('INVALID_RESPONSE', 'Hub capabilities response was invalid');
    return value.publicationJobs.enabled
      ? { state: 'enabled', capabilities: value }
      : { state: 'disabled', capabilities: value };
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveRemoteConfigPath(cwd: string, values: ParsedCommand['values']): string {
  return resolve(cwd, optionString(values, 'remote-config') ?? 'hub.remote.json');
}

export async function ensurePrivateReceiptDirectory(path: string): Promise<void> {
  const absolutePath = resolve(path);
  await mkdir(absolutePath, { recursive: true, mode: 0o700 });
  const info = await lstat(absolutePath);
  if (!info.isDirectory())
    failInput('Receipt storage path must be a directory', 'INVALID_RECEIPT_STORE');
  if (process.platform !== 'win32') {
    await chmod(absolutePath, 0o700);
    const secured = await stat(absolutePath);
    if ((secured.mode & 0o077) !== 0)
      failInput('Receipt storage directory must be private', 'INVALID_RECEIPT_STORE');
  }
}
