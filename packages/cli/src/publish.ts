import { readFile } from 'node:fs/promises';
import {
  createPublicationJobClient,
  PublicationJobClientError,
} from '@slidev-stage-hub/hub/client';
import type { PublicationJobRequest } from '@slidev-stage-hub/protocol/contracts';
import { isRecord, callerPath, optionBoolean, optionString, type ParsedCommand } from './args.js';
import { CliFailure, failInput, failRuntime } from './errors.js';
import { emitSuccess } from './output.js';
import {
  acceptedOutput,
  exitForJob,
  makeJobViewUrl,
  printAcceptedJob,
  waitForPublicationJob,
  writeNewJobReceipt,
} from './jobs.js';
import {
  HubCapabilitiesError,
  loadHubRemoteSettings,
  probeHubCapabilities,
} from './remote-config.js';

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const CANONICAL_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;
const ASSET_NAME = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(svg|txt|css)$/u;

async function readUtf8File(filePath: string, label: string, maxBytes?: number): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    failInput(
      `${label} could not be read`,
      label === 'Source' ? 'INVALID_SOURCE' : 'INVALID_ASSETS',
    );
  }
  if (maxBytes !== undefined && bytes.byteLength > maxBytes)
    failInput(`${label} exceeds the 512 KiB publish request limit`, 'PUBLISH_REQUEST_TOO_LARGE');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    failInput(
      `${label} must be valid UTF-8`,
      label === 'Source' ? 'INVALID_SOURCE' : 'INVALID_ASSETS',
    );
  }
}

function parseAssets(source: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    failInput('Assets file must contain valid JSON', 'INVALID_ASSETS');
  }
  if (!isRecord(value))
    failInput('Assets file must contain a filename-to-text object', 'INVALID_ASSETS');

  const assets: Record<string, string> = {};
  for (const [name, content] of Object.entries(value)) {
    if (!ASSET_NAME.test(name) || typeof content !== 'string')
      failInput(
        'Assets may contain only .svg, .txt, or .css filenames with string content',
        'INVALID_ASSETS',
      );
    Object.defineProperty(assets, name, {
      value: content,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return assets;
}

async function readResponseBounded(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    failRuntime('Hub publish response exceeds the 1 MiB limit', 'PUBLISH_RESPONSE_TOO_LARGE');
  }
  if (!response.body)
    failRuntime('Hub publish returned an empty response', 'PUBLISH_INVALID_RESPONSE');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        failRuntime('Hub publish response exceeds the 1 MiB limit', 'PUBLISH_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    if (signal.aborted) failRuntime('Hub publish timed out after 10 seconds', 'PUBLISH_TIMEOUT');
    failRuntime('Hub publish response could not be read', 'PUBLISH_INVALID_RESPONSE');
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength);
}

function parsePublishResponse(bytes: Buffer): {
  id: string;
  revision: string;
  cached: boolean;
  pages: number;
  warnings: string[];
  entry: string;
} {
  let value: unknown;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(source);
  } catch {
    failRuntime('Hub publish returned an invalid response', 'PUBLISH_INVALID_RESPONSE');
  }
  if (!isRecord(value))
    failRuntime('Hub publish returned an invalid response', 'PUBLISH_INVALID_RESPONSE');

  const id = value.id;
  const revision = value.revision;
  const entry = value.entry;
  const slides = value.slides;
  const warnings = value.warnings;
  if (
    typeof id !== 'string' ||
    typeof revision !== 'string' ||
    revision.length === 0 ||
    typeof entry !== 'string' ||
    value.published !== true ||
    typeof value.cached !== 'boolean' ||
    !Array.isArray(slides) ||
    slides.length === 0 ||
    !Array.isArray(warnings) ||
    warnings.some((warning) => typeof warning !== 'string')
  )
    failRuntime('Hub publish returned an invalid response', 'PUBLISH_INVALID_RESPONSE');
  return { id, revision, cached: value.cached, pages: slides.length, warnings, entry };
}

async function runLegacyPublish(options: {
  origin: string;
  id: string;
  markdown: string;
  assets: Record<string, string>;
  headers: Record<string, string>;
  json: boolean;
  noWait: boolean;
}): Promise<void> {
  if (options.noWait)
    process.stderr.write(
      'Legacy Hub server uses synchronous publication; --no-wait is unavailable.\n',
    );
  process.stderr.write(
    'Legacy Hub server does not support durable jobs or automatic thumbnails.\n',
  );
  const body = JSON.stringify({ markdown: options.markdown, assets: options.assets });
  const endpoint = new URL(`/api/decks/${encodeURIComponent(options.id)}`, options.origin);
  const requestHeaders = new Headers(options.headers);
  requestHeaders.set('accept', 'application/json');
  requestHeaders.set('content-type', 'application/json');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        cache: 'no-store',
        headers: requestHeaders,
        body,
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted)
        failRuntime('Hub publish timed out after 10 seconds', 'PUBLISH_TIMEOUT');
      failRuntime('Hub publish request failed', 'PUBLISH_FETCH_FAILED');
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      failRuntime(
        'Hub publish endpoint redirected; redirects are not followed',
        'PUBLISH_REDIRECTED',
      );
    }
    if (response.status === 409) {
      await response.body?.cancel().catch(() => undefined);
      failRuntime('Hub publish was superseded by a newer publication', 'PUBLISH_SUPERSEDED');
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      failRuntime('Hub publish authentication failed', 'PUBLISH_AUTH_FAILED');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      failRuntime(`Hub publish API returned HTTP ${response.status}`, 'PUBLISH_HTTP_ERROR');
    }

    const result = parsePublishResponse(await readResponseBounded(response, controller.signal));
    const canonicalEntry = `/${options.id}/1?revision=${result.revision}`;
    const pinnedUrl = new URL(canonicalEntry, options.origin);
    if (
      result.id !== options.id ||
      result.entry !== canonicalEntry ||
      pinnedUrl.origin !== options.origin ||
      pinnedUrl.pathname !== `/${options.id}/1` ||
      pinnedUrl.search !== `?revision=${result.revision}` ||
      pinnedUrl.searchParams.size !== 1 ||
      pinnedUrl.searchParams.get('revision') !== result.revision ||
      pinnedUrl.hash !== ''
    )
      failRuntime('Hub publish returned an invalid response', 'PUBLISH_INVALID_RESPONSE');

    const entry = pinnedUrl.href;
    emitSuccess(
      'hub publish',
      {
        origin: options.origin,
        id: options.id,
        entry,
        revision: result.revision,
        cached: result.cached,
        pages: result.pages,
        warnings: result.warnings,
      },
      options.json,
      `Published ${options.id} (${result.pages} pages) at ${entry}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function publishTimeout(values: ParsedCommand['values']): number {
  const raw = optionString(values, 'timeout') ?? '300';
  if (!/^\d+$/u.test(raw))
    failInput('--timeout must be an integer between 1 and 86400', 'INVALID_TIMEOUT');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 86400)
    failInput('--timeout must be an integer between 1 and 86400', 'INVALID_TIMEOUT');
  return value;
}

export async function runHubPublish(
  parsed: ParsedCommand,
  cwd: string,
  json: boolean,
): Promise<void> {
  if (parsed.positionals.length !== 0)
    failInput('hub publish does not accept positional arguments');
  const settings = await loadHubRemoteSettings(cwd, parsed.values);
  const idValue = optionString(parsed.values, 'id') ?? settings.defaultDeckId;
  if (idValue === undefined) failInput('hub publish requires --id or defaultDeckId', 'INVALID_ID');
  if (!CANONICAL_ID.test(idValue))
    failInput(
      'Hub publish id must be slash-separated letters, digits, underscores, or hyphens',
      'INVALID_ID',
    );
  const sourceValue = optionString(parsed.values, 'source');
  if (sourceValue === undefined) failInput('hub publish requires --source', 'INVALID_SOURCE');
  const markdown = await readUtf8File(callerPath(cwd, sourceValue), 'Source', MAX_REQUEST_BYTES);
  if (markdown.trim().length === 0)
    failInput('Source must contain non-empty Markdown', 'INVALID_SOURCE');
  const assetsValue = optionString(parsed.values, 'assets');
  const assets =
    assetsValue === undefined
      ? {}
      : parseAssets(await readUtf8File(callerPath(cwd, assetsValue), 'Assets'));
  const body = JSON.stringify({ markdown, assets });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES)
    failInput('Combined publish request exceeds the 512 KiB limit', 'PUBLISH_REQUEST_TOO_LARGE');

  let thumbnailValue: 'auto' | 'none' = 'auto';
  const rawThumbnailValue = optionString(parsed.values, 'thumbnail');
  if (
    rawThumbnailValue !== undefined &&
    rawThumbnailValue !== 'auto' &&
    rawThumbnailValue !== 'none'
  )
    failInput('--thumbnail must be auto or none', 'INVALID_THUMBNAIL_MODE');
  if (rawThumbnailValue !== undefined) thumbnailValue = rawThumbnailValue;
  const noWait = optionBoolean(parsed.values, 'no-wait') ?? false;
  const requireJobs = optionBoolean(parsed.values, 'require-jobs') ?? false;
  const jobFlag = optionString(parsed.values, 'job');
  const timeoutSeconds = publishTimeout(parsed.values);

  let capability;
  try {
    capability = await probeHubCapabilities(settings);
  } catch (error) {
    if (error instanceof HubCapabilitiesError) {
      if (error.code === 'AUTH_FAILED')
        failRuntime('Hub capabilities authentication failed', 'PUBLISH_AUTH_FAILED');
      failRuntime(
        'Hub capabilities could not be checked; no legacy fallback was attempted',
        'PUBLISH_CAPABILITIES_FAILED',
      );
    }
    failRuntime(
      'Hub capabilities could not be checked; no legacy fallback was attempted',
      'PUBLISH_CAPABILITIES_FAILED',
    );
  }

  if (capability.state !== 'enabled') {
    if (requireJobs)
      failRuntime(
        'This Hub does not enable publication jobs, and --require-jobs was set',
        'JOBS_REQUIRED',
      );
    if (jobFlag !== undefined)
      failInput('--job replay requires a Hub with publication jobs enabled', 'JOBS_UNAVAILABLE');
    if (capability.state === 'unsupported')
      process.stderr.write(
        'Hub does not advertise publication jobs; using legacy synchronous publishing.\n',
      );
    else
      process.stderr.write(
        'Hub publication jobs are disabled; using legacy synchronous publishing.\n',
      );
    await runLegacyPublish({
      origin: settings.origin,
      id: idValue,
      markdown,
      assets,
      headers: settings.headers,
      json,
      noWait,
    });
    return;
  }

  const requested = {
    origin: settings.origin,
    deckId: idValue,
    markdown,
    assets,
    thumbnail: thumbnailValue,
  };
  let jobId: string;
  let viewToken: string;
  if (jobFlag !== undefined) {
    const fromReceipt = await writeNewJobReceipt({
      origin: settings.origin,
      deckId: idValue,
      request: requested,
      jobId: jobFlag,
    });
    ({ jobId, viewToken } = fromReceipt);
  } else {
    const created = await writeNewJobReceipt({
      origin: settings.origin,
      deckId: idValue,
      request: requested,
    });
    ({ jobId, viewToken } = created);
  }

  const request: PublicationJobRequest = {
    jobId,
    deckId: idValue,
    markdown,
    assets,
    thumbnail: thumbnailValue,
    viewToken,
  };
  const client = createPublicationJobClient({
    baseUrl: settings.origin,
    headers: settings.headers,
  });
  let response;
  try {
    response = await client.submit(request);
  } catch (error) {
    if (
      error instanceof PublicationJobClientError &&
      error.code === 'HTTP' &&
      [401, 403].includes(error.status ?? 0)
    )
      failRuntime('Hub publish authentication failed', 'PUBLISH_AUTH_FAILED');
    if (error instanceof PublicationJobClientError && error.code === 'HTTP' && error.status === 409)
      failRuntime('A different request already uses this publication job ID', 'JOB_ID_CONFLICT');
    failRuntime(
      `Publication request failed; its private receipt is saved. Replay with --job ${jobId}`,
      'JOB_SUBMIT_FAILED',
      { jobId, requestMayHaveBeenAccepted: true },
    );
  }
  const viewUrl = makeJobViewUrl(settings.origin, idValue, response, viewToken);
  printAcceptedJob(jobId, viewUrl);
  if (noWait) {
    acceptedOutput(jobId, idValue, response.job.status, response, 'hub publish', json, {
      origin: settings.origin,
    });
    return;
  }

  const snapshot = await waitForPublicationJob({
    origin: settings.origin,
    headers: settings.headers,
    deckId: idValue,
    jobId,
    viewToken,
    timeoutSeconds,
    remoteConfig: optionString(parsed.values, 'remote-config'),
    headersFile: optionString(parsed.values, 'headers-file'),
    json,
    progressLabel: 'hub publish',
  });
  exitForJob(snapshot, 'hub publish', json, { origin: settings.origin, id: idValue });
}
