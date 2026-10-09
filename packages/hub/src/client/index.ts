import { validateCatalog } from '@slidev-stage-hub/protocol/contracts';
import type { Catalog } from '@slidev-stage-hub/protocol/contracts';

export type {
  Catalog,
  CatalogCategory,
  CatalogDeck,
  JsonValue,
  PublicFrontmatter,
} from '@slidev-stage-hub/protocol/contracts';

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
