import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPublicationJobClient,
  PublicationJobClientError,
} from '@slidev-stage-hub/hub/client';
import { isJobId, isJobViewToken, isTerminalJobStatus } from '@slidev-stage-hub/protocol/contracts';
import type {
  JobSnapshot,
  JobStatus,
  PublicationJobRetryRequest,
} from '@slidev-stage-hub/protocol/contracts';
import { failInput, failRuntime, CliFailure } from './errors.js';
import { emitSuccess } from './output.js';
import { ensurePrivateReceiptDirectory, loadHubRemoteSettings } from './remote-config.js';
import {
  optionBoolean,
  optionString,
  parseCommand,
  CLI_VERSION,
  type ParsedCommand,
} from './args.js';

const JOB_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RECEIPT_VERSION = 1;

interface JobReceipt {
  schemaVersion: 1;
  origin: string;
  deckId: string;
  jobId: string;
  viewToken: string;
  requestHash: string;
  parentJobId?: string;
  stage?: 'all' | 'thumbnail';
}

export interface JobSubmissionValues {
  origin: string;
  deckId: string;
  markdown: string;
  assets: Record<string, string>;
  thumbnail: 'auto' | 'none';
}

function receiptRoot(): string {
  const stateRoot =
    process.env.XDG_STATE_HOME ||
    (process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : path.join(os.homedir(), '.local', 'state'));
  return path.join(stateRoot, 'slidev-stage-hub', 'receipts');
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function publicationRequestHash(
  request: {
    jobId: string;
    deckId: string;
    markdown: string;
    assets: Record<string, string>;
    thumbnail: 'auto' | 'none';
  },
  viewToken: string,
): string {
  const viewTokenHash = createHash('sha256').update(viewToken).digest('hex');
  return createHash('sha256')
    .update(
      stableValue({
        ...request,
        viewTokenHash,
      }),
    )
    .digest('hex');
}

function receiptFileName(origin: string, deckId: string, jobId: string): string {
  const identity = createHash('sha256').update(`${origin}\0${deckId}\0${jobId}`).digest('hex');
  return `receipt-${identity}.json`;
}

function validReceipt(value: unknown): value is JobReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    receipt.schemaVersion === RECEIPT_VERSION &&
    typeof receipt.origin === 'string' &&
    typeof receipt.deckId === 'string' &&
    typeof receipt.jobId === 'string' &&
    JOB_UUID_PATTERN.test(receipt.jobId) &&
    isJobViewToken(receipt.viewToken) &&
    typeof receipt.requestHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(receipt.requestHash) &&
    (receipt.parentJobId === undefined ||
      (typeof receipt.parentJobId === 'string' && JOB_UUID_PATTERN.test(receipt.parentJobId))) &&
    (receipt.stage === undefined || receipt.stage === 'all' || receipt.stage === 'thumbnail')
  );
}

export async function readJobReceipt(
  origin: string,
  deckId: string,
  jobId: string,
): Promise<JobReceipt | undefined> {
  const filePath = path.join(receiptRoot(), receiptFileName(origin, deckId, jobId));
  let fileInfo;
  try {
    fileInfo = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    failInput('Private job receipt could not be inspected', 'INVALID_JOB_RECEIPT');
  }
  if (!fileInfo.isFile() || (process.platform !== 'win32' && (fileInfo.mode & 0o077) !== 0))
    failInput('Private job receipt is not stored with private permissions', 'INVALID_JOB_RECEIPT');
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    failInput('Private job receipt could not be read', 'INVALID_JOB_RECEIPT');
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    failInput('Private job receipt is invalid', 'INVALID_JOB_RECEIPT');
  }
  if (
    !validReceipt(value) ||
    value.origin !== origin ||
    value.deckId !== deckId ||
    value.jobId !== jobId
  )
    failInput('Private job receipt does not match this request', 'INVALID_JOB_RECEIPT');
  return value;
}

export async function writeJobReceipt(receipt: JobReceipt): Promise<void> {
  if (!validReceipt(receipt)) failInput('Job receipt data is invalid', 'INVALID_JOB_RECEIPT');
  const directory = receiptRoot();
  await ensurePrivateReceiptDirectory(directory);
  const filePath = path.join(
    directory,
    receiptFileName(receipt.origin, receipt.deckId, receipt.jobId),
  );
  const contents = `${JSON.stringify(receipt)}\n`;
  let handle;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      failInput(
        'A private job receipt already exists; it was not overwritten',
        'JOB_RECEIPT_EXISTS',
      );
    failRuntime(
      'Private job receipt could not be saved before submission',
      'JOB_RECEIPT_WRITE_FAILED',
    );
  } finally {
    await handle?.close();
  }
  if (process.platform !== 'win32') await chmod(filePath, 0o600);
}

export function newJobIdentity(): { jobId: string; viewToken: string } {
  return { jobId: randomUUID(), viewToken: randomBytes(32).toString('base64url') };
}

export function createJobClient(origin: string, headers: Record<string, string>) {
  return createPublicationJobClient({ baseUrl: origin, headers });
}

export function makeJobViewUrl(
  origin: string,
  deckId: string,
  response: {
    job: JobSnapshot;
    statusUrl: string;
    viewPath: string;
  },
  viewToken: string,
): string {
  let statusUrl: URL;
  let viewUrl: URL;
  try {
    statusUrl = new URL(response.statusUrl, origin);
    viewUrl = new URL(response.viewPath, origin);
  } catch {
    failRuntime('Hub returned an invalid publication job link', 'JOB_INVALID_RESPONSE');
  }
  if (
    statusUrl.origin !== origin ||
    statusUrl.pathname !== `/api/jobs/${response.job.id}` ||
    statusUrl.searchParams.get('deckId') !== deckId ||
    statusUrl.searchParams.size !== 1 ||
    statusUrl.hash !== '' ||
    viewUrl.origin !== origin ||
    viewUrl.pathname !== '/_hub/jobs' ||
    viewUrl.searchParams.get('deckId') !== deckId ||
    viewUrl.searchParams.get('jobId') !== response.job.id ||
    viewUrl.searchParams.size !== 2 ||
    viewUrl.hash !== ''
  )
    failRuntime('Hub returned an invalid publication job link', 'JOB_INVALID_RESPONSE');
  viewUrl.hash = `view=${encodeURIComponent(viewToken)}`;
  return viewUrl.href;
}

export function printAcceptedJob(jobId: string, viewUrl: string, status: JobStatus): void {
  if (isTerminalJobStatus(status))
    process.stderr.write(`Publication job ${jobId} already completed (${status})\n`);
  else process.stderr.write(`Publication job ${jobId} accepted\n`);
  process.stderr.write(`View progress: ${viewUrl}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function resumeCommand(
  deckId: string,
  jobId: string,
  options: { origin: string; remoteConfig?: string; headersFile?: string },
): string {
  const values = ['hub jobs watch', '--id', shellQuote(deckId), '--job', shellQuote(jobId)];
  values.push('--origin', shellQuote(options.origin));
  if (options.remoteConfig !== undefined)
    values.push('--remote-config', shellQuote(options.remoteConfig));
  if (options.headersFile !== undefined)
    values.push('--headers-file', shellQuote(options.headersFile));
  return values.join(' ');
}

function cleanupCommand(
  deckId: string,
  options: {
    origin: string;
    remoteConfig?: string;
    headersFile?: string;
    limit: number;
  },
): string {
  const values = [
    'hub jobs cleanup',
    '--id',
    shellQuote(deckId),
    '--origin',
    shellQuote(options.origin),
  ];
  if (options.remoteConfig !== undefined)
    values.push('--remote-config', shellQuote(options.remoteConfig));
  if (options.headersFile !== undefined)
    values.push('--headers-file', shellQuote(options.headersFile));
  values.push('--limit', String(options.limit), '--apply');
  return values.join(' ');
}

function progressLine(snapshot: JobSnapshot): string {
  const progress = snapshot.progress
    ? ` ${snapshot.progress.completed}/${snapshot.progress.total} ${snapshot.progress.unit}`
    : '';
  const stage = snapshot.phase ? ` ${snapshot.phase}` : '';
  return `publication job ${snapshot.id}: ${snapshot.status}${stage}${progress}`;
}

export async function waitForPublicationJob(options: {
  origin: string;
  headers?: Record<string, string>;
  deckId: string;
  jobId: string;
  viewToken?: string;
  timeoutSeconds: number;
  remoteConfig?: string;
  headersFile?: string;
  json: boolean;
  progressLabel?: string;
}): Promise<JobSnapshot> {
  const timeoutMs = options.timeoutSeconds * 1000;
  const controller = new AbortController();
  let timedOut = false;
  let interrupted = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onInterrupt = () => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onInterrupt);
  const client = createPublicationJobClient({
    baseUrl: options.origin,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  let latestSnapshot: JobSnapshot | undefined;
  let wroteTtyProgress = false;
  const resume = resumeCommand(options.deckId, options.jobId, {
    origin: options.origin,
    ...(options.remoteConfig === undefined ? {} : { remoteConfig: options.remoteConfig }),
    ...(options.headersFile === undefined ? {} : { headersFile: options.headersFile }),
  });
  try {
    for await (const snapshot of client.watch(
      {
        jobId: options.jobId,
        deckId: options.deckId,
        ...(options.viewToken === undefined ? {} : { viewToken: options.viewToken }),
      },
      { signal: controller.signal },
    )) {
      latestSnapshot = snapshot;
      const line = `${options.progressLabel ?? 'publication'}: ${progressLine(snapshot)}`;
      if (process.stderr.isTTY) {
        process.stderr.write(`\r${line}`);
        wroteTtyProgress = true;
      } else {
        process.stderr.write(`${line}\n`);
      }
      if (isTerminalJobStatus(snapshot.status)) return snapshot;
    }
    return failRuntime('Publication job watch ended before a terminal state', 'JOB_WATCH_ENDED');
  } catch (error) {
    if (timedOut) {
      return failRuntime(
        `Publication wait timed out; the job continues. Resume with: ${resume}`,
        'JOB_WAIT_TIMEOUT',
        {
          jobId: options.jobId,
          status: latestSnapshot?.status ?? 'unknown',
          resumeCommand: resume,
        },
      );
    }
    if (interrupted)
      throw new CliFailure(
        'JOB_WATCH_INTERRUPTED',
        `Stopped local watch; the job continues. Resume with: ${resume}`,
        130,
      );
    if (error instanceof CliFailure) throw error;
    if (error instanceof PublicationJobClientError) {
      if (error.code === 'HTTP' && (error.status === 401 || error.status === 403))
        return failRuntime('Publication job authentication failed', 'JOB_AUTH_FAILED');
      if (error.code === 'HTTP' && error.status === 404)
        return failRuntime(
          'Publication job could not be found or the read link expired',
          'JOB_NOT_FOUND',
        );
    }
    return failRuntime('Publication job status could not be read', 'JOB_STATUS_FAILED');
  } finally {
    if (wroteTtyProgress) process.stderr.write('\n');
    clearTimeout(timeout);
    process.off('SIGINT', onInterrupt);
  }
}

function failJobRead(error: unknown, operation: 'status' | 'list'): never {
  if (error instanceof CliFailure) throw error;
  if (error instanceof PublicationJobClientError) {
    if (error.code === 'HTTP' && [401, 403].includes(error.status ?? 0))
      failRuntime('Publication job authentication failed', 'JOB_AUTH_FAILED');
    if (error.code === 'HTTP' && error.status === 404)
      failRuntime('Publication job or requested deck could not be found', 'JOB_NOT_FOUND');
    if (error.code === 'HTTP' && error.status === 429)
      failRuntime(
        'Hub is rate-limiting publication job reads; try again later',
        'JOB_RATE_LIMITED',
      );
    if (
      error.code === 'NETWORK' ||
      error.code === 'TIMEOUT' ||
      (error.code === 'HTTP' && (error.status ?? 0) >= 500)
    )
      failRuntime('Publication job API is unavailable; try again later', 'JOB_API_UNAVAILABLE');
    if (error.code === 'INVALID_JSON' || error.code === 'INVALID_RESPONSE')
      failRuntime('Hub returned an invalid publication job response', 'JOB_INVALID_RESPONSE');
  }
  failRuntime(
    `Publication job ${operation} request failed`,
    operation === 'status' ? 'JOB_STATUS_FAILED' : 'JOB_LIST_FAILED',
  );
}

export function exitForJob(
  snapshot: JobSnapshot,
  command: string,
  json: boolean,
  extra: Record<string, unknown> = {},
): void {
  const result = {
    ...extra,
    jobId: snapshot.id,
    deckId: snapshot.deckId,
    status: snapshot.status,
    phase: snapshot.phase,
    version: snapshot.version,
    ...(snapshot.result === undefined ? {} : { publication: snapshot.result }),
    ...(snapshot.error === undefined ? {} : { failure: snapshot.error }),
  };
  if (snapshot.status === 'partial')
    failRuntime(
      'Slides were published but thumbnail processing did not complete',
      'PARTIAL_SUCCESS',
      {
        ...result,
        published: snapshot.result !== undefined,
        ...(snapshot.result === undefined ? {} : { revision: snapshot.result.revision }),
      },
    );
  if (snapshot.status === 'failed') failRuntime('Publication job failed', 'JOB_FAILED', result);
  if (snapshot.status === 'superseded')
    failRuntime(
      'Publication job was superseded by a newer publication',
      'PUBLISH_SUPERSEDED',
      result,
    );
  if (snapshot.status !== 'succeeded')
    failRuntime('Publication job did not finish successfully', 'JOB_FAILED', result);
  emitSuccess(command, result, json, `Publication job ${snapshot.id} succeeded`);
}

function timeoutSeconds(values: ParsedCommand['values']): number {
  const raw = optionString(values, 'timeout') ?? '300';
  if (!/^\d+$/u.test(raw))
    failInput('--timeout must be an integer between 1 and 86400', 'INVALID_TIMEOUT');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86400)
    failInput('--timeout must be an integer between 1 and 86400', 'INVALID_TIMEOUT');
  return parsed;
}

function jobOptions(): Record<string, { type: 'string' | 'boolean' }> {
  return {
    'remote-config': { type: 'string' },
    origin: { type: 'string' },
    'headers-file': { type: 'string' },
    id: { type: 'string' },
    job: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    stage: { type: 'string' },
    timeout: { type: 'string' },
    'no-wait': { type: 'boolean' },
    apply: { type: 'boolean' },
  };
}

function requireJobId(value: string | undefined, label = '--job'): string {
  if (value === undefined || !isJobId(value))
    failInput(`${label} must be a UUIDv4`, 'INVALID_JOB_ID');
  return value;
}

function requireDeckId(value: string | undefined, defaultDeckId?: string): string {
  const deckId = value ?? defaultDeckId;
  if (deckId === undefined || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(deckId))
    failInput(
      '--id must be a canonical Hub ID or set defaultDeckId in hub.remote.json',
      'INVALID_ID',
    );
  return deckId;
}

export function acceptedOutput(
  jobId: string,
  deckId: string,
  status: string,
  response: { replayed: boolean; job: JobSnapshot },
  command: string,
  json: boolean,
  extra: Record<string, unknown> = {},
): void {
  if (isTerminalJobStatus(response.job.status)) {
    exitForJob(response.job, command, json, extra);
    return;
  }
  const data = {
    ...extra,
    jobId,
    deckId,
    status,
    accepted: true,
    complete: ['succeeded', 'partial', 'failed', 'superseded'].includes(status),
    replayed: response.replayed,
  };
  const human = data.complete
    ? `Publication job ${jobId} is already complete (${status})`
    : `Publication job ${jobId} accepted; publication is not yet complete`;
  emitSuccess(command, data, json, human);
}

export async function runHubJobs(args: string[], cwd: string, json: boolean): Promise<void> {
  const parsed = parseCommand('hub', 'jobs', args, jobOptions());
  const [subcommand, ...rest] = parsed.positionals;
  const help = [
    'Usage: hub jobs <status|watch|list|retry|cleanup> [options]',
    'status/watch: --id ID --job UUID [--remote-config PATH]',
    'list:         --id ID [--limit N] [--cursor CURSOR]',
    'retry:        --id ID --job UUID --stage thumbnail|all [--timeout 300] [--no-wait]',
    'cleanup:      --id ID [--apply] [--limit N] (dry-run by default)',
  ].join('\n');
  if (!subcommand || optionBoolean(parsed.values, 'help')) {
    emitSuccess('hub jobs', { help }, json, help);
    return;
  }
  if (optionBoolean(parsed.values, 'version')) {
    emitSuccess('hub jobs', { version: CLI_VERSION }, json, CLI_VERSION);
    return;
  }
  if (!subcommand || rest.length !== 0)
    failInput('usage: hub jobs <status|watch|list|retry|cleanup> [options]', 'INVALID_ARGUMENTS');
  if (!['status', 'watch', 'list', 'retry', 'cleanup'].includes(subcommand))
    failInput('unknown hub jobs command', 'UNKNOWN_COMMAND');
  if (subcommand !== 'cleanup' && optionBoolean(parsed.values, 'apply') !== undefined)
    failInput('--apply is only supported by hub jobs cleanup');

  const settings = await loadHubRemoteSettings(cwd, parsed.values);
  const deckId = requireDeckId(optionString(parsed.values, 'id'), settings.defaultDeckId);
  const jobId = optionString(parsed.values, 'job');
  const client = createPublicationJobClient({
    baseUrl: settings.origin,
    headers: settings.headers,
  });

  if (subcommand === 'list') {
    if (jobId !== undefined || optionString(parsed.values, 'stage') !== undefined)
      failInput('hub jobs list does not accept --job or --stage');
    const rawLimit = optionString(parsed.values, 'limit') ?? '20';
    if (!/^\d+$/u.test(rawLimit))
      failInput('--limit must be an integer between 1 and 100', 'INVALID_LIMIT');
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      failInput('--limit must be an integer between 1 and 100', 'INVALID_LIMIT');
    const cursor = optionString(parsed.values, 'cursor');
    let result;
    try {
      result = await client.list({
        deckId,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (error) {
      failJobRead(error, 'list');
    }
    emitSuccess(
      'hub jobs list',
      {
        deckId,
        items: result.items,
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      },
      json,
      `Found ${result.items.length} publication jobs for ${deckId}`,
    );
    return;
  }

  if (subcommand === 'cleanup') {
    if (
      jobId !== undefined ||
      optionString(parsed.values, 'stage') !== undefined ||
      optionString(parsed.values, 'cursor') !== undefined ||
      optionString(parsed.values, 'timeout') !== undefined ||
      optionBoolean(parsed.values, 'no-wait') !== undefined
    )
      failInput('hub jobs cleanup only accepts --id, --apply, and --limit');
    const apply = optionBoolean(parsed.values, 'apply') ?? false;
    const rawLimit = optionString(parsed.values, 'limit') ?? '100';
    if (!/^\d+$/u.test(rawLimit))
      failInput('--limit must be an integer between 1 and 100', 'INVALID_LIMIT');
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      failInput('--limit must be an integer between 1 and 100', 'INVALID_LIMIT');
    const remoteConfig = optionString(parsed.values, 'remote-config');
    const rerunCommand = cleanupCommand(deckId, {
      origin: settings.origin,
      ...(remoteConfig === undefined ? {} : { remoteConfig }),
      ...(settings.headersFilePath === undefined ? {} : { headersFile: settings.headersFilePath }),
      limit,
    });

    process.stderr.write(
      `jobs cleanup: ${apply ? 'applying' : 'dry-run'} for ${deckId} (limit ${limit})\n`,
    );
    let result;
    try {
      result = await client.cleanup({ deckId, apply, limit });
    } catch (error) {
      if (
        error instanceof PublicationJobClientError &&
        error.code === 'HTTP' &&
        [401, 403].includes(error.status ?? 0)
      )
        failRuntime('Job cleanup authentication failed', 'JOB_AUTH_FAILED');
      if (
        error instanceof PublicationJobClientError &&
        error.code === 'HTTP' &&
        [404, 405, 501, 503].includes(error.status ?? 0)
      )
        failRuntime(
          'This Hub does not support job cleanup; no cleanup was performed',
          'JOB_CLEANUP_UNAVAILABLE',
        );
      if (error instanceof PublicationJobClientError && error.code === 'INVALID_RESPONSE')
        failRuntime('Hub returned an invalid job cleanup response', 'JOB_CLEANUP_INVALID_RESPONSE');
      failRuntime('Job cleanup request failed', 'JOB_CLEANUP_FAILED');
    }
    if (result.dryRun === apply)
      failRuntime(
        'Hub returned a cleanup response with the wrong dry-run state',
        'JOB_CLEANUP_INVALID_RESPONSE',
      );

    const summary = apply
      ? `removed ${result.deletedJobs} job(s), deleted ${result.deletedInputs} input(s), ${result.pendingInputs} input(s) pending`
      : `previewed ${result.jobs.length} eligible job(s)`;
    process.stderr.write(`jobs cleanup: ${summary}\n`);
    if (apply && result.pendingInputs > 0) {
      process.stderr.write(
        `Cleanup partially completed: ${result.deletedJobs} job(s) were removed, but ${result.pendingInputs} input deletion(s) remain pending.\n`,
      );
      process.stderr.write(
        `Next action: rerun ${rerunCommand}\nReason: retry pending input deletion.\n`,
      );
      failRuntime(
        'Job cleanup partially completed; pending private input deletion must be retried',
        'JOB_CLEANUP_PARTIAL',
        result,
      );
    }
    if (result.more) {
      const reason =
        !apply && result.pendingInputs > 0
          ? 'to continue cleanup and retry pending input deletion'
          : 'to continue the bounded cleanup';
      process.stderr.write(`Next action: rerun ${rerunCommand}\nReason: ${reason}.\n`);
    } else if (!apply && result.jobs.length > 0) {
      const reason =
        result.pendingInputs > 0
          ? 'to remove the previewed metadata and retry pending input deletion'
          : 'to remove the previewed metadata';
      process.stderr.write(`Next action: rerun ${rerunCommand}\nReason: ${reason}.\n`);
    } else if (!apply && result.pendingInputs > 0) {
      process.stderr.write(
        `No eligible job metadata was found.\nNext action: rerun ${rerunCommand}\n--apply will retry pending input deletion.\n`,
      );
    }

    emitSuccess(
      'hub jobs cleanup',
      result,
      json,
      apply
        ? `Cleanup completed for ${deckId}: ${summary}`
        : `Cleanup preview for ${deckId}: ${summary}`,
    );
    return;
  }

  const selectedJobId = requireJobId(jobId);
  if (subcommand === 'retry') {
    const stage = optionString(parsed.values, 'stage');
    if (stage !== 'all' && stage !== 'thumbnail')
      failInput('--stage must be thumbnail or all', 'INVALID_STAGE');
    const timeout = timeoutSeconds(parsed.values);
    const identity = newJobIdentity();
    const body: PublicationJobRetryRequest = {
      jobId: identity.jobId,
      stage,
      viewToken: identity.viewToken,
    };
    const requestHash = createHash('sha256')
      .update(stableValue({ parentJobId: selectedJobId, deckId, ...body }))
      .digest('hex');
    await writeJobReceipt({
      schemaVersion: 1,
      origin: settings.origin,
      deckId,
      jobId: identity.jobId,
      viewToken: identity.viewToken,
      requestHash,
      parentJobId: selectedJobId,
      stage,
    });
    let response;
    try {
      response = await client.retry({ jobId: selectedJobId, deckId }, body);
    } catch (error) {
      if (
        error instanceof PublicationJobClientError &&
        error.code === 'HTTP' &&
        error.status === 409
      )
        failRuntime(
          'An active retry already exists or the parent job cannot be retried',
          'JOB_RETRY_CONFLICT',
        );
      if (
        error instanceof PublicationJobClientError &&
        error.code === 'HTTP' &&
        [401, 403].includes(error.status ?? 0)
      )
        failRuntime('Publication retry authentication failed', 'JOB_AUTH_FAILED');
      failRuntime(
        'Publication retry request failed; the saved receipt can be used to inspect the child job',
        'JOB_RETRY_FAILED',
        {
          jobId: identity.jobId,
          parentJobId: selectedJobId,
        },
      );
    }
    const viewUrl = makeJobViewUrl(settings.origin, deckId, response, identity.viewToken);
    printAcceptedJob(identity.jobId, viewUrl, response.job.status);
    if (optionBoolean(parsed.values, 'no-wait')) {
      acceptedOutput(identity.jobId, deckId, response.job.status, response, 'hub jobs retry', json);
      return;
    }
    const snapshot = await waitForPublicationJob({
      origin: settings.origin,
      deckId,
      jobId: identity.jobId,
      viewToken: identity.viewToken,
      timeoutSeconds: timeout,
      headers: settings.headers,
      remoteConfig: optionString(parsed.values, 'remote-config'),
      headersFile: optionString(parsed.values, 'headers-file'),
      json,
      progressLabel: 'jobs retry',
    });
    exitForJob(snapshot, 'hub jobs retry', json);
    return;
  }

  if (
    optionString(parsed.values, 'stage') !== undefined ||
    optionString(parsed.values, 'cursor') !== undefined
  )
    failInput(`hub jobs ${subcommand} does not accept --stage or --cursor`);
  const timeout = timeoutSeconds(parsed.values);
  const receipt = await readJobReceipt(settings.origin, deckId, selectedJobId);
  const key = {
    jobId: selectedJobId,
    deckId,
    ...(receipt === undefined ? {} : { viewToken: receipt.viewToken }),
  };
  if (subcommand === 'status') {
    let result;
    try {
      result = await client.get(key);
    } catch (error) {
      failJobRead(error, 'status');
    }
    emitSuccess(
      'hub jobs status',
      result.job,
      json,
      `Publication job ${result.job.id}: ${result.job.status} (${result.job.phase})`,
    );
    return;
  }

  const snapshot = await waitForPublicationJob({
    origin: settings.origin,
    deckId,
    jobId: selectedJobId,
    ...(receipt === undefined ? {} : { viewToken: receipt.viewToken }),
    timeoutSeconds: timeout,
    headers: settings.headers,
    remoteConfig: optionString(parsed.values, 'remote-config'),
    headersFile: optionString(parsed.values, 'headers-file'),
    json,
    progressLabel: 'jobs watch',
  });
  exitForJob(snapshot, 'hub jobs watch', json);
}

export function requireJobUUID(value: string): string {
  if (!JOB_UUID_PATTERN.test(value)) failInput('--job must be a UUIDv4', 'INVALID_JOB_ID');
  return value;
}

export async function writeNewJobReceipt(options: {
  origin: string;
  deckId: string;
  request: JobSubmissionValues;
  jobId?: string;
}): Promise<{ jobId: string; viewToken: string; requestHash: string; replayed: boolean }> {
  const jobId = options.jobId === undefined ? randomUUID() : requireJobUUID(options.jobId);
  const existing =
    options.jobId === undefined
      ? undefined
      : await readJobReceipt(options.origin, options.deckId, jobId);
  if (options.jobId !== undefined && existing === undefined)
    failInput('--job replay requires an existing private receipt', 'JOB_RECEIPT_NOT_FOUND');
  const identity = existing
    ? { jobId, viewToken: existing.viewToken }
    : { jobId, viewToken: randomBytes(32).toString('base64url') };
  const requestHash = publicationRequestHash(
    {
      jobId,
      deckId: options.deckId,
      markdown: options.request.markdown,
      assets: options.request.assets,
      thumbnail: options.request.thumbnail,
    },
    identity.viewToken,
  );
  if (existing) {
    if (existing.requestHash !== requestHash)
      failInput(
        '--job replay does not match the saved receipt and current request body',
        'JOB_REPLAY_MISMATCH',
      );
    return { ...identity, requestHash, replayed: true };
  }
  await writeJobReceipt({
    schemaVersion: 1,
    origin: options.origin,
    deckId: options.deckId,
    jobId,
    viewToken: identity.viewToken,
    requestHash,
  });
  return { ...identity, requestHash, replayed: false };
}
