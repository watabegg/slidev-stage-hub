import { parseSync } from '@slidev/parser';
import {
  JOB_PHASES,
  isJobId,
  isJobViewToken,
  isTerminalJobStatus,
  type JobSnapshot,
} from '@slidev-stage-hub/protocol';
import { WorkerError } from '../errors.js';
import { isDeckId } from '../catalog.js';
import { isRecord } from '../manifest.js';
import { validatePublicationInput } from '../publish.js';
import {
  MAX_PUBLISH_BODY_BYTES,
  ImmutableArtifactConflict,
  putImmutableArtifacts,
  readBoundedBody,
  readJson,
  sha256,
} from '../storage.js';
import type { HubServerOptions } from '../ports.js';
import {
  COMPILER_CONTRACT_VERSION,
  type PublicationJobRecord,
  type NewPublicationJob,
  type JobAdmissionResult,
} from './ports.js';

class JobApiError extends WorkerError {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super(status, 'request', message);
  }
}
function fail(status: number, code: string, message: string): never {
  throw new JobApiError(status, code, message);
}
function response(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', ...Object.fromEntries(new Headers(headers)) },
  });
}
export function publicationJobsConfigured(env: HubServerOptions): boolean {
  if (!env.jobs || env.jobs.publications !== env.publications || !env.profile.digest) return false;
  if (!env.publicOrigin) return true;
  try {
    const url = new URL(env.publicOrigin);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  } catch {
    return false;
  }
}
export function publicationJobsEnabled(env: HubServerOptions): boolean {
  return env.jobsEnabled !== false && publicationJobsConfigured(env);
}
export function publicJobSnapshot(record: PublicationJobRecord): JobSnapshot {
  // Copy explicitly: a future private record field can never become a wire field.
  const s = record.snapshot;
  return structuredClone({
    id: s.id,
    deckId: s.deckId,
    kind: s.kind,
    status: s.status,
    phase: s.phase,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    attempt: s.attempt,
    stages: s.stages,
    ...(s.parentJobId !== undefined ? { parentJobId: s.parentJobId } : {}),
    ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
    ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
    ...(s.nextRunAt !== undefined ? { nextRunAt: s.nextRunAt } : {}),
    ...(s.progress !== undefined ? { progress: s.progress } : {}),
    ...(s.result !== undefined ? { result: s.result } : {}),
    ...(s.error !== undefined ? { error: s.error } : {}),
  });
}
function jobReply(outcome: JobAdmissionResult): Response {
  if (outcome.outcome !== 'accepted' && outcome.outcome !== 'replayed') {
    const errors = {
      conflict: [409, 'IDEMPOTENCY_CONFLICT', 'Job id was already used for a different request'],
      limit: [429, 'JOBS_LIMIT', 'Too many active jobs for this deck'],
      not_found: [404, 'JOB_NOT_FOUND', 'Job not found'],
      invalid_retry: [409, 'INVALID_RETRY', 'This job cannot be retried at the requested stage'],
      superseded: [409, 'SUPERSEDED', 'A newer publication was accepted; publish again explicitly'],
      active_retry: [409, 'ACTIVE_RETRY', 'A retry is already active'],
    } as const;
    const [status, code, message] = errors[outcome.outcome];
    fail(status, code, message);
  }
  const job = publicJobSnapshot(outcome.job);
  const query = `deckId=${encodeURIComponent(job.deckId)}`;
  const statusUrl = `/api/jobs/${job.id}?${query}`;
  const viewPath = `/_hub/jobs?${query}&jobId=${job.id}`;
  const status = outcome.outcome === 'replayed' && isTerminalJobStatus(job.status) ? 200 : 202;
  return response(
    { schemaVersion: 1, job, statusUrl, viewPath, replayed: outcome.outcome === 'replayed' },
    status,
    { location: statusUrl, 'retry-after': '2' },
  );
}
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBody(request, MAX_PUBLISH_BODY_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    fail(400, 'INVALID_REQUEST', 'Request body must be valid JSON');
  }
  if (!isRecord(value)) fail(400, 'INVALID_REQUEST', 'Request body must be an object');
  return value;
}
function strict(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some((key) => !fields.includes(key)))
    fail(400, 'INVALID_REQUEST', 'Request contains unsupported fields');
}
function requireIdentity(url: URL, jobId: string): { deckId: string; jobId: string } {
  const deckId = url.searchParams.get('deckId');
  if (!isJobId(jobId) || deckId === null || !isDeckId(deckId))
    fail(400, 'INVALID_REQUEST', 'Invalid job identity');
  return { deckId, jobId };
}
async function newRecord(
  env: HubServerOptions,
  options: {
    deckId: string;
    jobId: string;
    requestHash: string;
    viewTokenHash: string;
    thumbnail: 'auto' | 'none';
    kind?: 'publication' | 'thumbnail';
    parentJobId?: string;
    inputKey?: string;
    inputHash?: string;
    targetRevision?: string;
  },
): Promise<NewPublicationJob> {
  let runtimeId: string | undefined;
  try {
    if (options.kind !== 'thumbnail') runtimeId = (await env.loadRuntime?.())?.id;
  } catch {
    fail(503, 'RUNTIME_UNAVAILABLE', 'The publication runtime is unavailable');
  }
  if (runtimeId !== undefined && !/^[a-f0-9]{64}$/u.test(runtimeId))
    fail(503, 'RUNTIME_UNAVAILABLE', 'The publication runtime is unavailable');
  const now = new Date().toISOString();
  const kind = options.kind ?? 'publication';
  return {
    snapshot: {
      id: options.jobId,
      deckId: options.deckId,
      kind,
      status: 'queued',
      phase: kind === 'thumbnail' ? 'thumbnail' : 'runtime',
      version: 1,
      createdAt: now,
      updatedAt: now,
      attempt: 0,
      stages: JOB_PHASES.map((phase) => ({
        phase,
        status: kind === 'thumbnail' && phase !== 'thumbnail' ? 'skipped' : 'pending',
        attempt: 0,
      })),
      ...(options.parentJobId ? { parentJobId: options.parentJobId } : {}),
    },
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    requestHash: options.requestHash,
    viewTokenHash: options.viewTokenHash,
    viewExpiresAt: new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString(),
    profileDigest: env.profile.digest,
    compilerContractVersion: COMPILER_CONTRACT_VERSION,
    thumbnail: options.thumbnail,
    ...(options.inputKey !== undefined ? { inputKey: options.inputKey } : {}),
    ...(options.inputHash !== undefined ? { inputHash: options.inputHash } : {}),
    ...(options.targetRevision !== undefined ? { targetRevision: options.targetRevision } : {}),
  };
}
async function requireReadAuthorization(
  request: Request,
  env: HubServerOptions,
  job: PublicationJobRecord | null,
  authorize: () => Promise<void>,
): Promise<void> {
  const token = request.headers.get('X-Hub-Job-View');
  if (request.headers.has('authorization') || (token === null && env.allowLocalMutations)) {
    await authorize();
    if (!job) fail(404, 'JOB_NOT_FOUND', 'Job not found');
    return;
  }
  if (!token) fail(401, 'AUTH_REQUIRED', 'Authentication required');
  if (
    !isJobViewToken(token) ||
    !job ||
    Date.parse(job.viewExpiresAt) <= Date.now() ||
    (await sha256(token)) !== job.viewTokenHash
  )
    fail(404, 'JOB_NOT_FOUND', 'Job not found');
}
/** Returns null only for paths outside the jobs API. */
export async function handlePublicationJobRequest(
  request: Request,
  env: HubServerOptions,
  authorize: () => Promise<void>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const statusRoute = /^\/api\/jobs\/([^/]+)(\/retry)?$/u.exec(url.pathname);
  const listRoute =
    request.method === 'GET' ? /^\/api\/decks\/(.+)\/jobs$/u.exec(url.pathname) : null;
  if (
    url.pathname !== '/api/capabilities' &&
    url.pathname !== '/api/jobs' &&
    !statusRoute &&
    !listRoute
  )
    return null;
  try {
    if (url.pathname === '/api/capabilities') {
      if (request.method !== 'GET')
        return response({ error: 'Method not allowed' }, 405, { allow: 'GET' });
      return response({
        schemaVersion: 1,
        publicationJobs: { enabled: publicationJobsEnabled(env), pollAfterMs: 2000 },
        thumbnail: { available: !!env.renderThumbnail },
        limits: { requestBytes: 524288, maxSlides: 100 },
      });
    }
    if (!publicationJobsConfigured(env))
      fail(503, 'JOBS_UNAVAILABLE', 'Publication jobs are not configured');
    const store = env.jobs!;
    if (url.pathname === '/api/jobs') {
      if (request.method !== 'POST')
        return response({ error: 'Method not allowed' }, 405, { allow: 'POST' });
      await authorize();
      if (!publicationJobsEnabled(env))
        fail(503, 'JOBS_UNAVAILABLE', 'Publication job admission is disabled');
      const body = await jsonBody(request);
      strict(body, ['jobId', 'deckId', 'markdown', 'assets', 'thumbnail', 'viewToken']);
      if (
        !isJobId(body.jobId) ||
        !isJobViewToken(body.viewToken) ||
        typeof body.deckId !== 'string' ||
        !isDeckId(body.deckId) ||
        (body.thumbnail !== undefined && !['auto', 'none'].includes(body.thumbnail as string))
      )
        fail(400, 'INVALID_REQUEST', 'Invalid publication job request');
      if (body.assets !== undefined && !isRecord(body.assets))
        fail(400, 'INVALID_REQUEST', 'assets must be a filename/content object');
      const source = validatePublicationInput(body.deckId, body);
      // Count is admission validation; template/frontmatter diagnostics remain asynchronous.
      let slides = 0;
      try {
        slides = parseSync(source.markdown, `${body.deckId}.md`).slides.length;
      } catch {
        /* Compilation records the sanitized diagnostic later. */
      }
      if (slides > 100) fail(400, 'INVALID_REQUEST', 'This runtime supports at most 100 slides');
      const thumbnail = body.thumbnail === 'none' ? 'none' : 'auto';
      const viewTokenHash = await sha256(body.viewToken);
      const requestHash = await sha256(
        JSON.stringify([body.deckId, source.markdown, source.assets, thumbnail, viewTokenHash]),
      );
      const identity = { deckId: body.deckId, jobId: body.jobId };
      const existing = await store.get(identity);
      if (existing)
        return jobReply(
          existing.requestHash === requestHash
            ? { outcome: 'replayed', job: existing }
            : { outcome: 'conflict' },
        );
      const serialized = JSON.stringify(source);
      const inputHash = await sha256(serialized);
      const inputKey = `private/jobs/${body.deckId}/${body.jobId}.json`;
      await putImmutableArtifacts(env.artifacts, [
        { key: inputKey, body: serialized, options: { contentType: 'application/json' } },
      ]);
      return jobReply(
        await store.submit(
          await newRecord(env, {
            ...identity,
            requestHash,
            viewTokenHash,
            thumbnail,
            inputKey,
            inputHash,
          }),
        ),
      );
    }
    if (listRoute) {
      if (request.method !== 'GET')
        return response({ error: 'Method not allowed' }, 405, { allow: 'GET' });
      await authorize();
      let deckId: string;
      try {
        deckId = decodeURIComponent(listRoute[1]!);
      } catch {
        fail(400, 'INVALID_REQUEST', 'Invalid deck id');
      }
      if (!isDeckId(deckId)) fail(400, 'INVALID_REQUEST', 'Invalid deck id');
      const rawLimit = url.searchParams.get('limit') ?? '20';
      const limit = Number(rawLimit);
      if (!/^\d+$/u.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail(400, 'INVALID_REQUEST', 'Invalid page limit');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if (cursor !== undefined && (cursor.length > 2048 || cursor.length === 0))
        fail(400, 'INVALID_REQUEST', 'Invalid cursor');
      let page: Awaited<ReturnType<typeof store.list>>;
      try {
        page = await store.list({ deckId, limit, ...(cursor ? { cursor } : {}) });
      } catch (error) {
        if (error instanceof TypeError) fail(400, 'INVALID_CURSOR', 'Invalid cursor');
        throw error;
      }
      return response({
        schemaVersion: 1,
        items: page.items.map(publicJobSnapshot),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    }
    const identity = requireIdentity(url, statusRoute![1]!);
    if (!statusRoute![2]) {
      if (request.method !== 'GET')
        return response({ error: 'Method not allowed' }, 405, { allow: 'GET' });
      const job = await store.get(identity);
      await requireReadAuthorization(request, env, job, authorize);
      return response(
        { schemaVersion: 1, job: publicJobSnapshot(job!) },
        200,
        isTerminalJobStatus(job!.snapshot.status) ? {} : { 'retry-after': '2' },
      );
    }
    if (request.method !== 'POST')
      return response({ error: 'Method not allowed' }, 405, { allow: 'POST' });
    await authorize();
    if (!publicationJobsEnabled(env))
      fail(503, 'JOBS_UNAVAILABLE', 'Publication job admission is disabled');
    const body = await jsonBody(request);
    strict(body, ['jobId', 'stage', 'viewToken']);
    if (
      !isJobId(body.jobId) ||
      !isJobViewToken(body.viewToken) ||
      !['all', 'thumbnail'].includes(body.stage as string)
    )
      fail(400, 'INVALID_REQUEST', 'Invalid retry request');
    const stage = body.stage as 'all' | 'thumbnail';
    const viewTokenHash = await sha256(body.viewToken);
    const requestHash = await sha256(
      JSON.stringify([identity.deckId, identity.jobId, stage, viewTokenHash]),
    );
    const existing = await store.get({ deckId: identity.deckId, jobId: body.jobId });
    if (existing)
      return jobReply(
        existing.requestHash === requestHash
          ? { outcome: 'replayed', job: existing }
          : { outcome: 'conflict' },
      );
    const parent = await store.get(identity);
    if (!parent) fail(404, 'JOB_NOT_FOUND', 'Job not found');
    if (stage === 'thumbnail' && !env.renderThumbnail)
      fail(503, 'THUMBNAIL_UNAVAILABLE', 'Thumbnail renderer is unavailable');
    if (
      !isTerminalJobStatus(parent.snapshot.status) ||
      (stage === 'all'
        ? parent.snapshot.status !== 'failed' || parent.snapshot.result !== undefined
        : parent.snapshot.result === undefined || parent.snapshot.result.thumbnail === 'ready')
    )
      fail(409, 'INVALID_RETRY', 'This job cannot be retried at the requested stage');
    if (stage === 'all') {
      if (
        !parent.inputKey ||
        !parent.inputHash ||
        !isRecord(await readJson(env.artifacts, parent.inputKey))
      )
        fail(409, 'INVALID_RETRY', 'Publication source is unavailable');
    }
    const child = await newRecord(env, {
      deckId: identity.deckId,
      jobId: body.jobId,
      parentJobId: identity.jobId,
      kind: stage === 'thumbnail' ? 'thumbnail' : 'publication',
      requestHash,
      viewTokenHash,
      thumbnail: stage === 'thumbnail' ? 'auto' : parent.thumbnail,
      ...(stage === 'all'
        ? { inputKey: parent.inputKey!, inputHash: parent.inputHash! }
        : { targetRevision: parent.snapshot.result!.revision }),
    });
    if (stage === 'thumbnail')
      child.snapshot.result = { ...parent.snapshot.result!, thumbnail: 'pending' };
    return jobReply(await store.retry(identity, stage, child));
  } catch (error) {
    if (error instanceof ImmutableArtifactConflict)
      return response(
        {
          error: 'Job id was already used for a different request',
          code: 'IDEMPOTENCY_CONFLICT',
          phase: 'request',
        },
        409,
      );
    if (error instanceof JobApiError)
      return response(
        { error: error.publicMessage, code: error.code, phase: error.phase },
        error.status,
      );
    throw error;
  }
}
