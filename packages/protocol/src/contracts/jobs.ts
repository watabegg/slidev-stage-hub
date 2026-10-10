export const JOB_PHASES = ['runtime', 'compile', 'store', 'publish', 'thumbnail'] as const;
export const JOB_STATUSES = [
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'partial',
  'failed',
  'superseded',
] as const;
export type JobPhase = (typeof JOB_PHASES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobKind = 'publication' | 'thumbnail';
export type ThumbnailMode = 'auto' | 'none';
export interface JobProgress {
  completed: number;
  total: number;
  unit: 'slides' | 'objects';
}
export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface StageSnapshot {
  phase: JobPhase;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
}
export interface JobResult {
  revision: string;
  runtimeId?: string;
  entry: string;
  pages: number;
  cached: boolean;
  thumbnail: 'pending' | 'ready' | 'failed' | 'skipped' | 'unavailable';
}
export interface JobSnapshot {
  id: string;
  deckId: string;
  parentJobId?: string;
  kind: JobKind;
  status: JobStatus;
  phase: JobPhase;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempt: number;
  nextRunAt?: string;
  progress?: JobProgress;
  stages: StageSnapshot[];
  result?: JobResult;
  error?: JobError;
}
export interface SubmitPublicationJobRequest {
  jobId: string;
  deckId: string;
  markdown: string;
  assets?: Record<string, string>;
  thumbnail?: ThumbnailMode;
  viewToken: string;
}
export interface RetryPublicationJobRequest {
  jobId: string;
  stage: 'all' | 'thumbnail';
  viewToken: string;
}
export interface PublicationJobResponse {
  schemaVersion: 1;
  job: JobSnapshot;
}
export interface SubmitPublicationJobResponse extends PublicationJobResponse {
  statusUrl: string;
  viewPath: string;
  replayed: boolean;
}
export interface PublicationJobListResponse {
  schemaVersion: 1;
  items: JobSnapshot[];
  nextCursor?: string;
}
export interface HubCapabilities {
  schemaVersion: 1;
  publicationJobs: { enabled: boolean; pollAfterMs: 2000 };
  thumbnail: { available: boolean };
  limits: { requestBytes: 524288; maxSlides: 100 };
}
export const JOB_VIEW_HEADER = 'X-Hub-Job-View';
export const JOB_POLL_AFTER_MS = 2000;
export function isJobId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}
export function isJobViewToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value);
}
export function isTerminalJobStatus(value: JobStatus): boolean {
  return ['succeeded', 'partial', 'failed', 'superseded'].includes(value);
}
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const iso = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(v) &&
  Number.isFinite(Date.parse(v));
const optional = (
  v: Record<string, unknown>,
  k: string,
  guard: (value: unknown) => boolean,
): boolean => !(k in v) || guard(v[k]);
const keys = (v: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(v).every((k) => allowed.includes(k));
export function isStageSnapshot(v: unknown): v is StageSnapshot {
  return (
    record(v) &&
    keys(v, ['phase', 'status', 'attempt', 'startedAt', 'finishedAt']) &&
    JOB_PHASES.includes(v.phase as JobPhase) &&
    ['pending', 'running', 'succeeded', 'failed', 'skipped'].includes(v.status as string) &&
    integer(v.attempt) &&
    optional(v, 'startedAt', iso) &&
    optional(v, 'finishedAt', iso)
  );
}
export function isJobSnapshot(v: unknown): v is JobSnapshot {
  if (
    !record(v) ||
    !keys(v, [
      'id',
      'deckId',
      'parentJobId',
      'kind',
      'status',
      'phase',
      'version',
      'createdAt',
      'updatedAt',
      'startedAt',
      'finishedAt',
      'attempt',
      'nextRunAt',
      'progress',
      'stages',
      'result',
      'error',
    ])
  )
    return false;
  return (
    isJobId(v.id) &&
    typeof v.deckId === 'string' &&
    /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(v.deckId) &&
    optional(v, 'parentJobId', isJobId) &&
    ['publication', 'thumbnail'].includes(v.kind as string) &&
    JOB_STATUSES.includes(v.status as JobStatus) &&
    JOB_PHASES.includes(v.phase as JobPhase) &&
    integer(v.version) &&
    integer(v.attempt) &&
    iso(v.createdAt) &&
    iso(v.updatedAt) &&
    ['startedAt', 'finishedAt', 'nextRunAt'].every((k) => optional(v, k, iso)) &&
    Array.isArray(v.stages) &&
    v.stages.length === JOB_PHASES.length &&
    v.stages.every(isStageSnapshot) &&
    new Set(v.stages.map((s) => s.phase)).size === v.stages.length &&
    optional(
      v,
      'progress',
      (p) =>
        record(p) &&
        keys(p, ['completed', 'total', 'unit']) &&
        integer(p.completed) &&
        integer(p.total) &&
        p.completed <= p.total &&
        ['slides', 'objects'].includes(p.unit as string),
    ) &&
    optional(
      v,
      'result',
      (r) =>
        record(r) &&
        keys(r, ['revision', 'runtimeId', 'entry', 'pages', 'cached', 'thumbnail']) &&
        typeof r.revision === 'string' &&
        /^[a-f0-9]{64}$/u.test(r.revision) &&
        optional(r, 'runtimeId', (id) => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id)) &&
        typeof r.entry === 'string' &&
        r.entry === `/${v.deckId}/1?revision=${r.revision}` &&
        ![...r.entry].some(
          (character) =>
            character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) &&
        integer(r.pages) &&
        r.pages > 0 &&
        typeof r.cached === 'boolean' &&
        ['pending', 'ready', 'failed', 'skipped', 'unavailable'].includes(r.thumbnail as string),
    ) &&
    optional(
      v,
      'error',
      (e) =>
        record(e) &&
        keys(e, ['code', 'message', 'retryable']) &&
        typeof e.code === 'string' &&
        /^[A-Z][A-Z0-9_]*$/u.test(e.code) &&
        typeof e.message === 'string' &&
        typeof e.retryable === 'boolean',
    )
  );
}
export function isPublicationJobResponse(v: unknown): v is PublicationJobResponse {
  return record(v) && v.schemaVersion === 1 && isJobSnapshot(v.job);
}
export function isSubmitPublicationJobResponse(v: unknown): v is SubmitPublicationJobResponse {
  return (
    isPublicationJobResponse(v) &&
    record(v) &&
    typeof v.statusUrl === 'string' &&
    v.statusUrl.startsWith('/api/jobs/') &&
    typeof v.viewPath === 'string' &&
    v.viewPath.startsWith('/_hub/jobs?') &&
    typeof v.replayed === 'boolean'
  );
}
export function isPublicationJobListResponse(v: unknown): v is PublicationJobListResponse {
  return (
    record(v) &&
    v.schemaVersion === 1 &&
    Array.isArray(v.items) &&
    v.items.every(isJobSnapshot) &&
    optional(v, 'nextCursor', (c) => typeof c === 'string')
  );
}
export function isHubCapabilities(v: unknown): v is HubCapabilities {
  return (
    record(v) &&
    v.schemaVersion === 1 &&
    record(v.publicationJobs) &&
    typeof v.publicationJobs.enabled === 'boolean' &&
    v.publicationJobs.pollAfterMs === 2000 &&
    record(v.thumbnail) &&
    typeof v.thumbnail.available === 'boolean' &&
    record(v.limits) &&
    v.limits.requestBytes === 524288 &&
    v.limits.maxSlides === 100
  );
}
// Wire aliases keep request and response naming consistent for clients.
export type PublicationJobRequest = SubmitPublicationJobRequest;
export type PublicationJobSubmitResponse = SubmitPublicationJobResponse;
export type PublicationJobGetResponse = PublicationJobResponse;
export type PublicationJobRetryRequest = RetryPublicationJobRequest;
export type PublicationJobsCapabilities = HubCapabilities;
export const isPublicationJobSubmitResponse = isSubmitPublicationJobResponse;
export const isPublicationJobGetResponse = isPublicationJobResponse;
export const isPublicationJobsCapabilities = isHubCapabilities;
