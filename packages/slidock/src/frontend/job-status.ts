import { createApp } from 'vue';
import type { JobSnapshot } from '@slidock/protocol/contracts';
import JobStatus from './JobStatus.vue';

export interface JobStatusRequest {
  jobId: string;
  deckId: string;
  viewToken?: string;
}

export type JobStatusConnection = 'connected' | 'reconnecting';

export interface JobStatusWatchOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  hiddenIntervalMs?: number;
  maxBackoffMs?: number;
  isHidden?: () => boolean;
  onConnectionChange?: (connection: JobStatusConnection) => void;
}

export interface JobStatusClient {
  get(
    request: JobStatusRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{ schemaVersion: 1; job: JobSnapshot }>;
  watch(request: JobStatusRequest, options?: JobStatusWatchOptions): AsyncIterable<JobSnapshot>;
}

export interface MountJobStatusOptions {
  client: JobStatusClient;
  deckId: string;
  jobId: string;
  viewToken?: string;
  signal?: AbortSignal;
}

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const deckIdPattern = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;
const viewTokenPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const jobPageClass = 'hub-job-status-page';
const activePageRoots = new WeakMap<HTMLElement, { count: number; addedClass: boolean }>();

export interface ViewTokenEnvironment {
  location: Pick<Location, 'href' | 'hash' | 'origin' | 'pathname' | 'search'>;
  history: Pick<History, 'state' | 'replaceState'>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  deckId: string;
  jobId: string;
  providedToken?: string;
}

export interface ResolvedJobViewToken {
  token?: string;
  invalid: boolean;
  storageKey: string;
}

export function jobViewStorageKey(origin: string, deckId: string, jobId: string): string {
  return `hub.job-view:${encodeURIComponent(origin)}:${encodeURIComponent(deckId)}:${encodeURIComponent(jobId)}`;
}

/** Removes the link capability from browser history before it can be sent in a request. */
export function resolveJobViewToken(environment: ViewTokenEnvironment): ResolvedJobViewToken {
  const { location, history, storage, deckId, jobId } = environment;
  const storageKey = jobViewStorageKey(location.origin, deckId, jobId);
  const originalHash = location.hash;
  const parameters = new URLSearchParams(
    originalHash.startsWith('#') ? originalHash.slice(1) : originalHash,
  );
  const hasFragmentToken = parameters.has('view');
  const fragmentToken = parameters.get('view');

  if (originalHash) {
    const cleanUrl = new URL(location.href);
    cleanUrl.hash = '';
    history.replaceState(history.state, '', cleanUrl);
  }

  let storedToken: string | null = null;
  try {
    storedToken = storage.getItem(storageKey);
  } catch {
    // Storage can be disabled; the current fragment token can still be used for this visit.
  }

  const token = environment.providedToken ?? (hasFragmentToken ? fragmentToken : storedToken);
  if (token === null || token === undefined) return { invalid: hasFragmentToken, storageKey };

  if (!viewTokenPattern.test(token)) {
    try {
      storage.removeItem(storageKey);
    } catch {
      // Ignore storage failures; the generic invalid-link state remains safe.
    }
    return { invalid: true, storageKey };
  }

  try {
    storage.setItem(storageKey, token);
  } catch {
    // Storage is only a reload convenience; it is not needed for this page to work.
  }
  return { token, invalid: false, storageKey };
}

export function clearJobViewToken(storage: Pick<Storage, 'removeItem'>, storageKey: string): void {
  try {
    storage.removeItem(storageKey);
  } catch {
    // Ignore storage failures while keeping the visible error generic.
  }
}

/** Build a same-origin, revision-pinned link only from a validated publication result. */
export function createPublishedSlideHref(
  job: JobSnapshot,
  deckId: string,
  jobId: string,
  origin: string,
): string | undefined {
  const publishStatus = job.stages.find((stage) => stage.phase === 'publish')?.status;
  const publishedByThisJob = job.kind === 'publication' && publishStatus === 'succeeded';
  const inheritedPublishedResult = job.kind === 'thumbnail' && publishStatus === 'skipped';
  if (
    !jobIdPattern.test(jobId) ||
    !deckIdPattern.test(deckId) ||
    job.id !== jobId ||
    job.deckId !== deckId ||
    !job.result ||
    (!publishedByThisJob && !inheritedPublishedResult) ||
    !revisionPattern.test(job.result.revision)
  )
    return undefined;

  const expectedPath = `/${deckId.split('/').map(encodeURIComponent).join('/')}/1`;
  let entry: URL;
  try {
    entry = new URL(job.result.entry, origin);
  } catch {
    return undefined;
  }
  const query = [...entry.searchParams.entries()];
  if (
    entry.origin !== origin ||
    entry.username !== '' ||
    entry.password !== '' ||
    entry.pathname !== expectedPath ||
    entry.hash !== '' ||
    query.length !== 1 ||
    query[0][0] !== 'revision' ||
    query[0][1] !== job.result.revision
  )
    return undefined;

  return `${expectedPath}?revision=${encodeURIComponent(job.result.revision)}`;
}

export class JobStatusMountError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'JobStatusMountError';
  }
}

function isElementLike(target: unknown): target is Element {
  return (
    typeof target === 'object' && target !== null && 'nodeType' in target && target.nodeType === 1
  );
}

function resolveTarget(target: Element | string): Element {
  if (typeof target !== 'string') {
    if (isElementLike(target)) return target;
    throw new JobStatusMountError('Job status mount target must be an Element or selector');
  }

  try {
    const element = document.querySelector(target);
    if (!element) throw new Error(`No element matches ${target}`);
    return element;
  } catch (cause) {
    if (cause instanceof JobStatusMountError) throw cause;
    throw new JobStatusMountError('Unable to resolve job status mount target', { cause });
  }
}

function acquireJobPageLayout(): () => void {
  const root = document.documentElement;
  let state = activePageRoots.get(root);
  if (!state) {
    const addedClass = !root.classList.contains(jobPageClass);
    if (addedClass) root.classList.add(jobPageClass);
    state = { count: 0, addedClass };
    activePageRoots.set(root, state);
  }
  state.count += 1;

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    state.count -= 1;
    if (state.count !== 0) return;
    if (state.addedClass) root.classList.remove(jobPageClass);
    activePageRoots.delete(root);
  };
}

/** Mounts one read-only job view and returns an idempotent cleanup function. */
export function mountJobStatus(
  target: Element | string,
  options: MountJobStatusOptions,
): () => void {
  const element = resolveTarget(target);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  const app = createApp(JobStatus, {
    client: options.client,
    deckId: options.deckId,
    jobId: options.jobId,
    viewToken: options.viewToken,
    signal: controller.signal,
  });
  const releasePageLayout = acquireJobPageLayout();
  try {
    app.mount(element);
  } catch (cause) {
    controller.abort();
    options.signal?.removeEventListener('abort', abortFromCaller);
    releasePageLayout();
    throw new JobStatusMountError('Unable to mount job status frontend', { cause });
  }

  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    controller.abort();
    options.signal?.removeEventListener('abort', abortFromCaller);
    try {
      app.unmount();
    } finally {
      releasePageLayout();
    }
  };
  if (options.signal?.aborted) unmount();
  else options.signal?.addEventListener('abort', unmount, { once: true });
  return unmount;
}
