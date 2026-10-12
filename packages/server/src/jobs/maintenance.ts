import { isJobId, type JobCleanupResponse } from '@slidock/protocol';
import { isDeckId } from '../catalog.js';
import type { HubServerOptions } from '../ports.js';
import { JOB_LEASE_MS } from './ports.js';

const RETENTION_DAYS = 30;

/** Shared by explicit maintenance and the background worker; never deletes public artifacts. */
export async function cleanupPublicationJobs(
  env: HubServerOptions,
  options: { deckId: string; apply: boolean; limit: number; now?: number; signal?: AbortSignal },
): Promise<JobCleanupResponse> {
  const maintenance = env.jobs?.maintenance;
  if (!maintenance || !env.artifacts.delete) throw new Error('Job cleanup is not available');
  const cutoff = new Date((options.now ?? Date.now()) - RETENTION_DAYS * 86_400_000).toISOString();
  const batch = await maintenance.cleanup({
    deckId: options.deckId,
    cutoff,
    limit: options.limit,
    dryRun: !options.apply,
  });
  let deletedInputs = 0;
  if (options.apply) {
    const pending = await maintenance.listPendingInputDeletes({
      deckId: options.deckId,
      limit: options.limit,
    });
    for (const item of pending.items) {
      if (options.signal?.aborted) break;
      if (
        !isDeckId(item.deckId) ||
        !isJobId(item.jobId) ||
        item.inputKey !== `private/jobs/${item.deckId}/${item.jobId}.json`
      )
        continue;
      try {
        await env.artifacts.delete(item.inputKey);
        deletedInputs += 1;
      } catch {
        continue;
      }
      try {
        await maintenance.acknowledgeInputDelete(item);
      } catch {
        // Idempotent deletion can be retried from the durable outbox.
      }
    }
  }
  const pendingAfter = await maintenance.listPendingInputDeletes({
    deckId: options.deckId,
    limit: 1,
  });
  return {
    schemaVersion: 1,
    deckId: options.deckId,
    dryRun: !options.apply,
    retentionDays: RETENTION_DAYS,
    cutoff,
    jobs: batch.jobs,
    deletedJobs: options.apply ? batch.jobs.length : 0,
    deletedInputs,
    pendingInputs: pendingAfter.pendingCount,
    more: batch.more || pendingAfter.pendingCount > 0,
  };
}

/** Runs one persisted daily batch independently of publication success. */
export async function runPublicationJobCleanup(
  env: HubServerOptions,
  options: { deckId?: string; now?: () => number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const automatic = env.jobs?.maintenance?.automatic;
  if (
    !automatic ||
    !env.artifacts.delete ||
    env.jobs?.publications !== env.publications ||
    options.signal?.aborted
  )
    return false;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const lease = await automatic.claim({
    now: new Date(startedAt).toISOString(),
    leaseUntil: new Date(startedAt + JOB_LEASE_MS).toISOString(),
    leaseToken: crypto.randomUUID(),
    ...(options.deckId ? { deckId: options.deckId } : {}),
  });
  if (!lease) return false;
  let retry = true;
  try {
    if (!options.signal?.aborted) {
      const result = await cleanupPublicationJobs(env, {
        deckId: lease.deckId,
        apply: true,
        limit: 100,
        now: startedAt,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      retry = result.more || !!options.signal?.aborted;
    }
  } catch {
    // Publication is already terminal; retain this independent request for the next daily slot.
  }
  await automatic.finish(lease, { now: new Date(now()).toISOString(), retry });
  return true;
}
