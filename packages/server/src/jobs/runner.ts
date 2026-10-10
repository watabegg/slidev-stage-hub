import {
  isTerminalJobStatus,
  type JobPhase,
  type JobError,
  type JobResult,
  type JobProgress,
  type StageSnapshot,
} from '@slidev-stage-hub/protocol';
import { WorkerError } from '../errors.js';
import type { HubServerOptions, PublicationJobEvent } from '../ports.js';
import { preparePublication, type CompileFunction } from '../publish.js';
import { readJson, sha256 } from '../storage.js';
import { captureAndStoreThumbnail, ThumbnailError } from '../thumbnail.js';
import {
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  COMPILER_CONTRACT_VERSION,
  type JobCheckpoint,
  type JobLease,
  type JobFinish,
} from './ports.js';
class LeaseLost extends Error {}
class RuntimeChanged extends Error {}
class InputInvalid extends Error {}
class AttemptsExhausted extends Error {}
export interface PublicationJobRunnerOptions {
  deckId?: string;
  signal?: AbortSignal;
  compile?: CompileFunction;
  now?: () => number;
  random?: () => number;
}
function safeError(error: unknown, phase: JobPhase, rendererAvailable: boolean): JobError {
  if (
    error instanceof InputInvalid ||
    (error instanceof WorkerError && error.phase === 'request' && error.status < 500)
  )
    return {
      code: 'INPUT_INVALID',
      message: 'The stored publication input is invalid.',
      retryable: false,
    };
  if (error instanceof RuntimeChanged)
    return {
      code: 'RUNTIME_CHANGED',
      message: 'The configured runtime changed before this job could run. Publish again.',
      retryable: false,
    };
  if (error instanceof ThumbnailError) {
    if (error.code === 'RENDER_AUTH_REQUIRED')
      return {
        code: 'RENDER_AUTH_REQUIRED',
        message: 'The renderer requires authentication to open this publication.',
        retryable: false,
      };
    if (error.code === 'BROWSER_UNAVAILABLE')
      return {
        code: 'THUMBNAIL_UNAVAILABLE',
        message: 'Thumbnail renderer is unavailable.',
        retryable: false,
      };
    return {
      code: error.code === 'BROWSER_LIMIT' ? 'THUMBNAIL_RATE_LIMIT' : 'THUMBNAIL_FAILED',
      message: 'Thumbnail rendering failed.',
      retryable: true,
    };
  }
  if (phase === 'thumbnail' && !rendererAvailable)
    return {
      code: 'THUMBNAIL_UNAVAILABLE',
      message: 'Thumbnail renderer is unavailable.',
      retryable: false,
    };
  if (error instanceof WorkerError && error.phase === 'compiler')
    return {
      code: 'COMPILE_FAILED',
      message: 'The deck could not be compiled with this runtime.',
      retryable: false,
    };
  return {
    code: phase === 'thumbnail' ? 'THUMBNAIL_FAILED' : 'STORAGE_FAILED',
    message:
      phase === 'thumbnail'
        ? 'Thumbnail rendering or storage failed.'
        : 'Publication storage is temporarily unavailable.',
    retryable: true,
  };
}
/** Process one durable claim. No admission/generation allocation occurs here. */
export async function runPublicationJob(
  env: HubServerOptions,
  options: PublicationJobRunnerOptions = {},
): Promise<boolean> {
  if (!env.jobs || env.jobs.publications !== env.publications || options.signal?.aborted)
    return false;
  const store = env.jobs;
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const record = await store.claim({
    now: iso(),
    leaseUntil: new Date(now() + JOB_LEASE_MS).toISOString(),
    leaseToken: crypto.randomUUID(),
    ...(options.deckId ? { deckId: options.deckId } : {}),
  });
  if (!record) return false;
  if (!record.leaseToken || isTerminalJobStatus(record.snapshot.status)) return true;
  const lease = (): JobLease => ({
    deckId: record.snapshot.deckId,
    jobId: record.snapshot.id,
    leaseToken: record.leaseToken!,
    now: iso(),
  });
  let lost = false;
  let stages: StageSnapshot[] = structuredClone(record.snapshot.stages);
  let phase = record.snapshot.phase;
  let executingPhase = phase;
  let result: JobResult | undefined = record.snapshot.result
    ? { ...record.snapshot.result }
    : undefined;
  let lastProgress = -Infinity;
  let measuredProgress: JobProgress | undefined;
  const emit = (
    event: PublicationJobEvent['event'],
    details: Pick<PublicationJobEvent, 'durationMs' | 'queueAgeMs' | 'code' | 'status'> = {},
  ): void => {
    const attempt =
      stages.find((stage) => stage.phase === phase)?.attempt ?? record.snapshot.attempt;
    try {
      void Promise.resolve(
        env.onJobEvent?.({
          event,
          jobId: record.snapshot.id,
          deckId: record.snapshot.deckId,
          phase,
          attempt,
          ...details,
        }),
      ).catch(() => {});
    } catch {
      /* Telemetry cannot change publication state. */
    }
  };
  emit('claimed', {
    queueAgeMs: Math.max(0, now() - Date.parse(record.snapshot.createdAt)),
    status: 'running',
  });
  const finish = async (update: JobFinish): Promise<boolean> => {
    const applied = await store.finish(lease(), update);
    if (applied)
      emit(update.status === 'retry_wait' ? 'retry_wait' : 'finished', {
        status: update.status,
        ...(update.error ? { code: update.error.code } : {}),
        durationMs: Math.max(
          0,
          now() - Date.parse(record.snapshot.startedAt ?? record.snapshot.createdAt),
        ),
      });
    return applied;
  };
  const checkpoint = async (update: JobCheckpoint): Promise<void> => {
    if (lost || !(await store.checkpoint(lease(), update))) {
      lost = true;
      throw new LeaseLost();
    }
  };
  const entered = new Set<JobPhase>();
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || lost) return;
    heartbeatBusy = true;
    void checkpoint({ leaseUntil: new Date(now() + JOB_LEASE_MS).toISOString() })
      .catch(() => {
        lost = true;
      })
      .finally(() => {
        heartbeatBusy = false;
      });
  }, JOB_HEARTBEAT_MS);
  const enter = async (next: JobPhase): Promise<void> => {
    if (lost) throw new LeaseLost();
    executingPhase = next;
    const stage = stages.find((s) => s.phase === next)!;
    if (stage.status === 'succeeded' || stage.status === 'skipped' || entered.has(next)) return;
    phase = next;
    if (stage.attempt >= 3) throw new AttemptsExhausted();
    entered.add(next);
    lastProgress = -Infinity;
    measuredProgress = undefined;
    stage.status = 'running';
    stage.attempt += 1;
    stage.startedAt = iso();
    delete stage.finishedAt;
    await checkpoint({ phase, attempt: stage.attempt, stages, clearProgress: true });
  };
  const completed = async (next: JobPhase): Promise<void> => {
    if (lost) throw new LeaseLost();
    const stage = stages.find((s) => s.phase === next)!;
    if (stage.status === 'succeeded' || stage.status === 'skipped') return;
    stage.status = 'succeeded';
    stage.finishedAt = iso();
    await checkpoint({ stages, ...(measuredProgress ? { progress: measuredProgress } : {}) });
    emit('stage_done', { durationMs: Math.max(0, now() - Date.parse(stage.startedAt ?? iso())) });
  };
  try {
    if (!result && record.snapshot.kind === 'publication') {
      if (!record.preparedManifest) await enter('runtime');
      if (
        record.profileDigest !== env.profile.digest ||
        record.compilerContractVersion !== COMPILER_CONTRACT_VERSION
      )
        throw new RuntimeChanged();
      let prepared = record.preparedManifest
        ? { manifest: record.preparedManifest, cached: record.preparedCached ?? false }
        : undefined;
      if (!prepared) {
        if (!record.inputKey || !record.inputHash)
          throw new WorkerError(500, 'storage', 'Private publication input is unavailable');
        const sourceObject = await env.artifacts.get(record.inputKey);
        if (!sourceObject)
          throw new WorkerError(500, 'storage', 'Private publication input is unavailable');
        const bytes = new Uint8Array(await new Response(sourceObject.body).arrayBuffer());
        if ((await sha256(bytes)) !== record.inputHash) throw new InputInvalid();
        const input = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        prepared = await preparePublication(env, record.snapshot.deckId, input, options.compile, {
          phase: enter,
          completed,
          runtime: async (runtimeId) => {
            if (runtimeId !== record.runtimeId) throw new RuntimeChanged();
          },
          progress: async (count, total, unit = 'slides') => {
            if (lost) throw new LeaseLost();
            if (
              (unit === 'slides' && phase !== 'compile') ||
              (unit === 'objects' && phase !== 'store')
            )
              return;
            measuredProgress = { completed: count, total, unit };
            if (now() - lastProgress < 1000) return;
            lastProgress = now();
            await checkpoint({ progress: { completed: count, total, unit } });
          },
        });
        await checkpoint({ preparedManifest: prepared.manifest, preparedCached: prepared.cached });
      }
      await enter('publish');
      const proposedResult: JobResult = {
        revision: prepared.manifest.revision,
        ...(prepared.manifest.runtimeId ? { runtimeId: prepared.manifest.runtimeId } : {}),
        entry: prepared.manifest.entry,
        pages: prepared.manifest.slides.length,
        cached: prepared.cached,
        thumbnail: record.thumbnail === 'none' ? 'skipped' : 'pending',
      };
      const publishedStages = structuredClone(stages);
      const publishStage = publishedStages.find((s) => s.phase === 'publish')!;
      publishStage.status = 'succeeded';
      publishStage.finishedAt = iso();
      const committed = await store.commitPublication(
        lease(),
        prepared.manifest,
        proposedResult,
        publishedStages,
      );
      if (committed === 'lease_lost') throw new LeaseLost();
      if (committed === 'superseded') {
        await finish({ status: 'superseded', phase, stages });
        return true;
      }
      stages = publishedStages;
      result = proposedResult;
      emit('published');
    }
    if (!result) throw new WorkerError(500, 'storage', 'Publication result is unavailable');
    if (record.snapshot.kind === 'thumbnail' && result.revision !== record.targetRevision)
      throw new WorkerError(500, 'storage', 'Thumbnail revision is invalid');
    if (record.thumbnail === 'none') {
      const stage = stages.find((s) => s.phase === 'thumbnail')!;
      stage.status = 'skipped';
      stage.finishedAt = iso();
      result.thumbnail = 'skipped';
      await finish({ status: 'succeeded', stages, result });
      return true;
    }
    await enter('thumbnail');
    if (!env.publicOrigin)
      throw new ThumbnailError('BROWSER_UNAVAILABLE', 'Thumbnail origin is unavailable');
    // The stored result fixes old-revision retries even after a newer publication.
    const manifest = await readJson(
      env.artifacts,
      `releases/${record.snapshot.deckId}/${result.revision}/manifest.json`,
    );
    if (!manifest) throw new WorkerError(500, 'storage', 'Publication result is unavailable');
    await captureAndStoreThumbnail(env, record.snapshot.deckId, result.revision, env.publicOrigin);
    await completed('thumbnail');
    result.thumbnail = 'ready';
    await finish({ status: 'succeeded', phase: 'thumbnail', stages, result });
  } catch (error) {
    if (error instanceof LeaseLost || lost) return true;
    phase = executingPhase;
    const diagnostic = safeError(error, phase, !!env.renderThumbnail);
    const stage = stages.find((s) => s.phase === phase)!;
    // Runtime mismatch may happen before entering the first stage.
    if (stage.status === 'succeeded') stage.attempt++;
    if (stage.attempt === 0) stage.attempt = 1;
    if (!(error instanceof AttemptsExhausted) && diagnostic.retryable && stage.attempt < 3) {
      stage.status = 'pending';
      delete stage.finishedAt;
      const retryAfter =
        error instanceof ThumbnailError && error.code === 'BROWSER_LIMIT'
          ? error.retryAfterMs
          : undefined;
      const delay =
        retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.max(1, Math.min(retryAfter, 300_000))
          : (stage.attempt === 1 ? 5000 : 30000) +
            Math.floor((options.random ?? Math.random)() * 1000);
      await finish({
        status: 'retry_wait',
        phase,
        stages,
        ...(result ? { result } : {}),
        error: diagnostic,
        nextRunAt: new Date(now() + delay).toISOString(),
      });
    } else {
      stage.status = 'failed';
      stage.finishedAt = iso();
      if (result)
        result.thumbnail = diagnostic.code === 'THUMBNAIL_UNAVAILABLE' ? 'unavailable' : 'failed';
      await finish({
        status: result ? 'partial' : 'failed',
        phase,
        stages,
        ...(result ? { result } : {}),
        error: diagnostic,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
