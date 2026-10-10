import {
  JOB_POLL_AFTER_MS,
  JOB_VIEW_HEADER,
  isJobId,
  isJobViewToken,
  isPublicationJobGetResponse,
  isPublicationJobListResponse,
  isPublicationJobSubmitResponse,
  isTerminalJobStatus,
} from '@slidev-stage-hub/protocol/contracts';
import type {
  JobSnapshot,
  PublicationJobGetResponse,
  PublicationJobListResponse,
  PublicationJobRequest,
  PublicationJobRetryRequest,
  PublicationJobSubmitResponse,
} from '@slidev-stage-hub/protocol/contracts';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = JOB_POLL_AFTER_MS;
const DEFAULT_HIDDEN_INTERVAL_MS = 10_000;
const DEFAULT_MAX_BACKOFF_MS = 15_000;
const MAX_RETRY_AFTER_MS = 300_000;

export type PublicationJobClientErrorCode =
  | 'ABORTED'
  | 'NETWORK'
  | 'HTTP'
  | 'TIMEOUT'
  | 'INVALID_JSON'
  | 'INVALID_RESPONSE';

export class PublicationJobClientError extends Error {
  readonly code: PublicationJobClientErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: PublicationJobClientErrorCode,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'PublicationJobClientError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface PublicationJobClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface PublicationJobRequestOptions {
  signal?: AbortSignal;
}

export interface PublicationJobKey {
  jobId: string;
  deckId: string;
  viewToken?: string;
}

export interface PublicationJobListInput {
  deckId: string;
  limit?: number;
  cursor?: string;
}

export interface PublicationJobRetryInput {
  deckId: string;
  /** The parent job ID. */
  jobId: string;
}

export interface PublicationJobWatchOptions extends PublicationJobRequestOptions {
  pollIntervalMs?: number;
  hiddenIntervalMs?: number;
  maxBackoffMs?: number;
  isHidden?: () => boolean;
  onConnectionChange?: (state: 'connected' | 'reconnecting') => void;
}

export interface PublicationJobClient {
  submit(
    input: PublicationJobRequest,
    options?: PublicationJobRequestOptions,
  ): Promise<PublicationJobSubmitResponse>;
  get(
    input: PublicationJobKey,
    options?: PublicationJobRequestOptions,
  ): Promise<PublicationJobGetResponse>;
  list(
    input: PublicationJobListInput,
    options?: PublicationJobRequestOptions,
  ): Promise<PublicationJobListResponse>;
  retry(
    parent: PublicationJobRetryInput,
    body: PublicationJobRetryRequest,
    options?: PublicationJobRequestOptions,
  ): Promise<PublicationJobSubmitResponse>;
  watch(
    input: PublicationJobKey,
    options?: PublicationJobWatchOptions,
  ): AsyncIterableIterator<JobSnapshot>;
}

type RequestOptions = PublicationJobRequestOptions & { viewToken?: string };

function abortedError(signal?: AbortSignal): PublicationJobClientError {
  return new PublicationJobClientError('ABORTED', 'Publication job request was aborted', {
    cause: signal?.reason,
  });
}

function invalidResponse(): PublicationJobClientError {
  return new PublicationJobClientError(
    'INVALID_RESPONSE',
    'Publication job API returned an invalid response',
  );
}

function requestUrl(baseUrl: string, pathname: string): string {
  if (!baseUrl) return pathname;
  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
      throw new Error('invalid base URL');
    return new URL(pathname, base).href;
  } catch (cause) {
    if (cause instanceof TypeError && !/^[a-z][a-z\d+.-]*:/iu.test(baseUrl)) {
      const prefix = baseUrl.replace(/\/+$/u, '');
      return `${prefix}${pathname}`;
    }
    throw new TypeError('baseUrl must be an HTTP(S) URL or a relative URL prefix', { cause });
  }
}

async function readResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new PublicationJobClientError(
      'INVALID_RESPONSE',
      'Publication job response was too large',
    );
  }
  if (!response.body)
    throw new PublicationJobClientError('INVALID_RESPONSE', 'Publication job response was empty');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PublicationJobClientError(
          'INVALID_RESPONSE',
          'Publication job response was too large',
        );
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof PublicationJobClientError) throw cause;
    if (signal.aborted) throw abortedError(signal);
    throw new PublicationJobClientError('NETWORK', 'Publication job response could not be read', {
      cause,
    });
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new PublicationJobClientError(
      'INVALID_JSON',
      'Publication job response was not valid JSON',
      { cause },
    );
  }
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortedError(signal));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function assertJobKey(input: PublicationJobKey): void {
  if (!isJobId(input.jobId)) {
    // The protocol guard validates UUIDv4 job IDs; deck IDs use a separate path grammar.
    throw new TypeError('jobId must be a UUIDv4');
  }
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(input.deckId))
    throw new TypeError('deckId must be a canonical Hub ID');
  if (input.viewToken !== undefined && !isJobViewToken(input.viewToken))
    throw new TypeError('viewToken must be a 32-byte base64url token');
}

function assertAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError(signal);
}

function isTransientWatchError(error: unknown): boolean {
  return (
    error instanceof PublicationJobClientError &&
    (error.code === 'NETWORK' ||
      error.code === 'TIMEOUT' ||
      (error.code === 'HTTP' && error.status === 429) ||
      (error.code === 'HTTP' && error.status !== undefined && error.status >= 500))
  );
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0)
    return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - Date.now()));
}

function assertJobIdentity(snapshot: JobSnapshot, jobId: string, deckId: string): void {
  if (snapshot.id !== jobId || snapshot.deckId !== deckId) throw invalidResponse();
}

export function createPublicationJobClient(
  options: PublicationJobClientOptions,
): PublicationJobClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  if (typeof fetcher !== 'function') throw new TypeError('fetch is not available');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1)
    throw new RangeError('requestTimeoutMs must be a positive safe integer');

  async function request(
    pathname: string,
    init: Omit<RequestInit, 'headers' | 'signal'> & { json?: unknown },
    requestOptions: RequestOptions = {},
  ): Promise<unknown> {
    const callerSignal = requestOptions.signal;
    assertAbort(callerSignal);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    if (callerSignal?.aborted) abortFromCaller();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json');
    if (init.json !== undefined) headers.set('content-type', 'application/json');
    if (requestOptions.viewToken !== undefined)
      headers.set(JOB_VIEW_HEADER, requestOptions.viewToken);
    const { json, ...requestInit } = init;
    try {
      let response: Response;
      try {
        response = await fetcher(requestUrl(options.baseUrl, pathname), {
          ...requestInit,
          redirect: 'manual',
          cache: 'no-store',
          headers,
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
          signal: controller.signal,
        });
      } catch (cause) {
        if (callerSignal?.aborted) throw abortedError(callerSignal);
        if (timedOut)
          throw new PublicationJobClientError(
            'TIMEOUT',
            `Publication job request timed out after ${requestTimeoutMs} ms`,
            { cause },
          );
        throw new PublicationJobClientError('NETWORK', 'Publication job request failed', {
          cause,
        });
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new PublicationJobClientError(
          'HTTP',
          `Publication job request was redirected (HTTP ${response.status})`,
          { status: response.status },
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new PublicationJobClientError(
          'HTTP',
          `Publication job API returned HTTP ${response.status}`,
          {
            status: response.status,
            ...(response.status === 429
              ? { retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')) }
              : {}),
          },
        );
      }
      try {
        return await readResponseJson(response, controller.signal);
      } catch (cause) {
        if (callerSignal?.aborted) throw abortedError(callerSignal);
        if (timedOut)
          throw new PublicationJobClientError(
            'TIMEOUT',
            `Publication job request timed out after ${requestTimeoutMs} ms`,
            { cause },
          );
        throw cause;
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  async function get(input: PublicationJobKey, requestOptions: RequestOptions = {}) {
    assertJobKey(input);
    const query = new URLSearchParams({ deckId: input.deckId });
    const value = await request(
      `/api/jobs/${encodeURIComponent(input.jobId)}?${query.toString()}`,
      { method: 'GET' },
      {
        ...requestOptions,
        ...(input.viewToken === undefined ? {} : { viewToken: input.viewToken }),
      },
    );
    if (!isPublicationJobGetResponse(value)) throw invalidResponse();
    assertJobIdentity(value.job, input.jobId, input.deckId);
    return value;
  }

  return {
    async submit(input, requestOptions = {}) {
      if (!isJobId(input.jobId)) throw new TypeError('jobId must be a UUIDv4');
      if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(input.deckId))
        throw new TypeError('deckId must be a canonical Hub ID');
      if (!isJobViewToken(input.viewToken))
        throw new TypeError('viewToken must be a 32-byte base64url token');
      const value = await request('/api/jobs', { method: 'POST', json: input }, requestOptions);
      if (!isPublicationJobSubmitResponse(value)) throw invalidResponse();
      assertJobIdentity(value.job, input.jobId, input.deckId);
      return value;
    },

    get,

    async list(input, requestOptions = {}) {
      if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(input.deckId))
        throw new TypeError('deckId must be a canonical Hub ID');
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError('limit must be an integer between 1 and 100');
      if (input.cursor !== undefined && (input.cursor.length === 0 || input.cursor.length > 2048))
        throw new TypeError('cursor must contain between 1 and 2048 characters');
      const query = new URLSearchParams({ limit: String(limit) });
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      const value = await request(
        `/api/decks/${encodeURIComponent(input.deckId)}/jobs?${query.toString()}`,
        { method: 'GET' },
        requestOptions,
      );
      if (!isPublicationJobListResponse(value)) throw invalidResponse();
      if (value.items.some((item) => item.deckId !== input.deckId)) throw invalidResponse();
      return value;
    },

    async retry(parent, body, requestOptions = {}) {
      assertJobKey({ jobId: parent.jobId, deckId: parent.deckId });
      if (!isJobId(body.jobId)) throw new TypeError('jobId must be a UUIDv4');
      if (!isJobViewToken(body.viewToken))
        throw new TypeError('viewToken must be a 32-byte base64url token');
      const query = new URLSearchParams({ deckId: parent.deckId });
      const value = await request(
        `/api/jobs/${encodeURIComponent(parent.jobId)}/retry?${query.toString()}`,
        { method: 'POST', json: body },
        requestOptions,
      );
      if (!isPublicationJobSubmitResponse(value)) throw invalidResponse();
      assertJobIdentity(value.job, body.jobId, parent.deckId);
      if (value.job.parentJobId !== parent.jobId) throw invalidResponse();
      return value;
    },

    async *watch(input, watchOptions = {}): AsyncIterableIterator<JobSnapshot> {
      assertJobKey(input);
      const pollIntervalMs = watchOptions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const hiddenIntervalMs = watchOptions.hiddenIntervalMs ?? DEFAULT_HIDDEN_INTERVAL_MS;
      const maxBackoffMs = watchOptions.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
      for (const [name, value] of [
        ['pollIntervalMs', pollIntervalMs],
        ['hiddenIntervalMs', hiddenIntervalMs],
        ['maxBackoffMs', maxBackoffMs],
      ] as const) {
        if (!Number.isSafeInteger(value) || value < 1)
          throw new RangeError(`${name} must be a positive safe integer`);
      }

      let previous: string | undefined;
      let failures = 0;
      let connectionState: 'connected' | 'reconnecting' | undefined;
      const reportConnection = (state: 'connected' | 'reconnecting') => {
        if (connectionState === state) return;
        connectionState = state;
        watchOptions.onConnectionChange?.(state);
      };

      while (true) {
        assertAbort(watchOptions.signal);
        try {
          const response = await get(input, watchOptions);
          const snapshot = response.job;
          reportConnection('connected');
          failures = 0;
          const serialized = JSON.stringify(snapshot);
          if (serialized !== previous) {
            previous = serialized;
            yield snapshot;
          }
          if (isTerminalJobStatus(snapshot.status)) return;
          const interval = watchOptions.isHidden?.() ? hiddenIntervalMs : pollIntervalMs;
          await sleep(interval, watchOptions.signal);
        } catch (error) {
          if (error instanceof PublicationJobClientError && error.code === 'ABORTED') throw error;
          if (!isTransientWatchError(error)) throw error;
          reportConnection('reconnecting');
          failures += 1;
          const delay =
            error instanceof PublicationJobClientError &&
            error.status === 429 &&
            error.retryAfterMs !== undefined
              ? error.retryAfterMs
              : Math.min(maxBackoffMs, pollIntervalMs * 2 ** Math.min(failures - 1, 10));
          await sleep(delay, watchOptions.signal);
        }
      }
    },
  };
}

export type {
  JobPhase,
  JobSnapshot,
  JobStatus,
  PublicationJobGetResponse,
  PublicationJobListResponse,
  PublicationJobRequest,
  PublicationJobRetryRequest,
  PublicationJobSubmitResponse,
} from '@slidev-stage-hub/protocol/contracts';
