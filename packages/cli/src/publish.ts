import { readFile } from 'node:fs/promises';
import { normalizeOrigin, readAuthHeadersFile } from '@slidev-stage-hub/stage-tools/node';
import { isRecord, callerPath, optionString, type ParsedCommand } from './args.js';
import { CliFailure, failInput, failRuntime } from './errors.js';
import { emitSuccess } from './output.js';

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const CANONICAL_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const ASSET_NAME = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(svg|txt|css)$/;

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
    /^\d+$/.test(declaredLength) &&
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
  return {
    id,
    revision,
    cached: value.cached,
    pages: slides.length,
    warnings,
    entry,
  };
}

export async function runHubPublish(
  parsed: ParsedCommand,
  cwd: string,
  json: boolean,
): Promise<void> {
  if (parsed.positionals.length !== 0)
    failInput('hub publish does not accept positional arguments');

  const rawOrigin = optionString(parsed.values, 'origin');
  if (rawOrigin === undefined) failInput('hub publish requires --origin', 'INVALID_ORIGIN');
  let origin: string;
  try {
    origin = normalizeOrigin(rawOrigin);
  } catch {
    failInput('Hub origin must be an HTTPS root or exact HTTP loopback origin', 'INVALID_ORIGIN');
  }

  const id = optionString(parsed.values, 'id');
  if (id === undefined) failInput('hub publish requires --id', 'INVALID_ID');
  if (!CANONICAL_ID.test(id))
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

  let headers: Record<string, string> | undefined;
  const headersValue = optionString(parsed.values, 'headers-file');
  if (headersValue !== undefined) {
    try {
      ({ headers } = await readAuthHeadersFile(
        callerPath(cwd, headersValue),
        origin,
        normalizeOrigin,
      ));
    } catch {
      failInput('Hub authentication header file is invalid or inaccessible', 'INVALID_AUTH_FILE');
    }
  }

  const body = JSON.stringify({ markdown, assets });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES)
    failInput('Combined publish request exceeds the 512 KiB limit', 'PUBLISH_REQUEST_TOO_LARGE');

  const endpoint = new URL(`/api/decks/${encodeURIComponent(id)}`, origin);
  const requestHeaders = new Headers(headers);
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
    const canonicalEntry = `/${id}/1?revision=${result.revision}`;
    const pinnedUrl = new URL(canonicalEntry, origin);
    if (
      result.id !== id ||
      result.entry !== canonicalEntry ||
      pinnedUrl.origin !== origin ||
      pinnedUrl.pathname !== `/${id}/1` ||
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
        origin,
        id,
        entry,
        revision: result.revision,
        cached: result.cached,
        pages: result.pages,
        warnings: result.warnings,
      },
      json,
      `Published ${id} (${result.pages} pages) at ${entry}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
