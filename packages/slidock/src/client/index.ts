import { validateCatalog } from '@slidock/protocol/contracts';
import type { Catalog, CatalogCategory, CatalogDeck } from '@slidock/protocol/contracts';

export type {
  Catalog,
  CatalogCategory,
  CatalogDeck,
  JsonValue,
  PublicFrontmatter,
} from '@slidock/protocol/contracts';

export { createPublicationJobClient, PublicationJobClientError } from './jobs.js';
export type {
  JobPhase,
  JobSnapshot,
  JobStatus,
  JobCleanupItem,
  JobCleanupRequest,
  JobCleanupResponse,
  PublicationJobCleanupInput,
  PublicationJobClient,
  PublicationJobClientErrorCode,
  PublicationJobClientOptions,
  PublicationJobGetResponse,
  PublicationJobKey,
  PublicationJobListInput,
  PublicationJobListResponse,
  PublicationJobRequest,
  PublicationJobRequestOptions,
  PublicationJobRetryInput,
  PublicationJobRetryRequest,
  PublicationJobSubmitResponse,
  PublicationJobWatchOptions,
} from './jobs.js';

export type CatalogClientErrorCode =
  | 'ABORTED'
  | 'NETWORK'
  | 'HTTP'
  | 'INVALID_JSON'
  | 'INVALID_CATALOG';

export class CatalogClientError extends Error {
  readonly code: CatalogClientErrorCode;
  readonly status?: number;

  constructor(
    code: CatalogClientErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'CatalogClientError';
    this.code = code;
    this.status = options.status;
  }
}

export interface CatalogSource {
  load(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface HttpCatalogSourceOptions {
  url?: string;
  fetch?: typeof globalThis.fetch;
}

export interface PaginatedCatalogSourceOptions extends HttpCatalogSourceOptions {
  maxPages?: number;
}

export interface CatalogRequestOptions {
  signal?: AbortSignal;
}

function isCatalogClientError(error: unknown): error is CatalogClientError {
  return error instanceof CatalogClientError;
}

function abortedError(signal?: AbortSignal): CatalogClientError {
  return new CatalogClientError('ABORTED', 'Catalog request was aborted', {
    cause: signal?.reason,
  });
}

function networkError(cause: unknown): CatalogClientError {
  return new CatalogClientError('NETWORK', 'Catalog request failed', { cause });
}

export function createHttpCatalogSource(options: HttpCatalogSourceOptions = {}): CatalogSource {
  return {
    async load(request: CatalogRequestOptions = {}): Promise<unknown> {
      const signal = request.signal;
      if (signal?.aborted) throw abortedError(signal);

      try {
        const fetcher = options.fetch ?? globalThis.fetch;
        const response = await fetcher(options.url ?? '/catalog.json', { signal });
        if (!response.ok) {
          throw new CatalogClientError(
            'HTTP',
            `Catalog request failed with HTTP ${response.status}`,
            { status: response.status },
          );
        }

        try {
          return await response.json();
        } catch (cause) {
          if (signal?.aborted) throw abortedError(signal);
          throw new CatalogClientError('INVALID_JSON', 'Catalog response was not valid JSON', {
            cause,
          });
        }
      } catch (cause) {
        if (isCatalogClientError(cause)) throw cause;
        if (signal?.aborted) throw abortedError(signal);
        throw networkError(cause);
      }
    },
  };
}

function invalidCatalog(cause: unknown): CatalogClientError {
  return new CatalogClientError('INVALID_CATALOG', 'Catalog response was invalid', { cause });
}

function cursorFromPage(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidCatalog(new Error('Catalog page must be an object'));
  const page = value as Record<string, unknown>;
  if (!Object.hasOwn(page, 'cursor')) return undefined;
  if (typeof page.cursor !== 'string' || page.cursor.length === 0 || page.cursor.length > 4096)
    throw invalidCatalog(new Error('Catalog page cursor is invalid'));
  return page.cursor;
}

function urlWithCursor(endpoint: string, cursor: string): string {
  const fragmentIndex = endpoint.indexOf('#');
  const withoutFragment = fragmentIndex < 0 ? endpoint : endpoint.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? '' : endpoint.slice(fragmentIndex);
  const queryIndex = withoutFragment.indexOf('?');
  const pathname = queryIndex < 0 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const parameters = new URLSearchParams(
    queryIndex < 0 ? '' : withoutFragment.slice(queryIndex + 1),
  );
  parameters.set('cursor', cursor);
  return `${pathname}?${parameters.toString()}${fragment}`;
}

/** Read and merge every page returned by a Hub catalog endpoint. */
export function createPaginatedCatalogSource(
  options: PaginatedCatalogSourceOptions = {},
): CatalogSource {
  const endpoint = options.url ?? '/catalog.json';
  const maxPages = options.maxPages ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1)
    throw new RangeError('maxPages must be a positive safe integer');

  return {
    async load(request: CatalogRequestOptions = {}): Promise<unknown> {
      const categories = new Map<string, CatalogCategory>();
      const decks = new Map<string, CatalogDeck>();
      const seenCursors = new Set<string>();
      const signal = request.signal;
      if (signal?.aborted) throw abortedError(signal);
      let cursor: string | undefined;
      let pagesRead = 0;

      for (;;) {
        const url = cursor === undefined ? endpoint : urlWithCursor(endpoint, cursor);
        const source = createHttpCatalogSource({
          url,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        const value = await source.load(signal === undefined ? undefined : { signal });
        if (signal?.aborted) throw abortedError(signal);
        let page: Catalog;
        try {
          page = validateCatalog(value);
        } catch (cause) {
          throw invalidCatalog(cause);
        }

        pagesRead += 1;
        for (const category of page.categories) categories.set(category.id, category);
        for (const deck of page.decks) decks.set(deck.id, deck);

        const nextCursor = cursorFromPage(value);
        if (nextCursor === undefined) break;
        if (seenCursors.has(nextCursor))
          throw invalidCatalog(new Error('Catalog page cursor repeated'));
        if (pagesRead >= maxPages)
          throw invalidCatalog(new Error('Catalog page limit was exceeded'));
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      if (signal?.aborted) throw abortedError(signal);
      return {
        schemaVersion: 1,
        categories: [...categories.values()],
        decks: [...decks.values()],
      };
    },
  };
}

export interface CatalogClient {
  getCatalog(options?: CatalogRequestOptions): Promise<Catalog>;
}

export function createCatalogClient(
  source: CatalogSource = createHttpCatalogSource(),
): CatalogClient {
  return {
    async getCatalog(options: CatalogRequestOptions = {}): Promise<Catalog> {
      const signal = options.signal;
      if (signal?.aborted) throw abortedError(signal);

      let abortListener: (() => void) | undefined;
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            abortListener = () => reject(abortedError(signal));
            signal.addEventListener('abort', abortListener, { once: true });
            if (signal.aborted) abortListener();
          })
        : undefined;

      const loadPromise = Promise.resolve()
        .then(() => source.load(signal ? { signal } : undefined))
        .catch((cause: unknown) => {
          if (isCatalogClientError(cause)) throw cause;
          if (signal?.aborted) throw abortedError(signal);
          throw networkError(cause);
        });

      try {
        const value = await (abortPromise
          ? Promise.race([loadPromise, abortPromise])
          : loadPromise);

        try {
          return validateCatalog(value);
        } catch (cause) {
          throw new CatalogClientError('INVALID_CATALOG', 'Catalog response was invalid', {
            cause,
          });
        }
      } finally {
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      }
    },
  };
}

export function getCatalog(
  source: CatalogSource = createHttpCatalogSource(),
  options: CatalogRequestOptions = {},
): Promise<Catalog> {
  return createCatalogClient(source).getCatalog(options);
}

/** @deprecated Use the provider-neutral name. */
export const createWorkersCatalogSource = createPaginatedCatalogSource;
/** @deprecated Use PaginatedCatalogSourceOptions. */
export type WorkersCatalogSourceOptions = PaginatedCatalogSourceOptions;
