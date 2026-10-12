import type {
  AutomaticJobCleanupStore,
  JobCleanupLease,
  JobLease,
  JobAdmissionResult,
  NewPublicationJob,
  PendingJobInputDelete,
  PublicationJobRecord,
  PublicationJobStore,
} from '@slidock/server';
import { JOB_CLEANUP_INTERVAL_MS } from '@slidock/server';
import { isJobId, type JobSnapshot } from '@slidock/protocol';
import { isDeckId } from '@slidock/server/catalog';
import { createMemoryPublicationStoreWithState } from './publication-store.js';

type MemoryState = Parameters<typeof createMemoryPublicationStoreWithState>[0] & {
  jobs: Map<string, PublicationJobRecord>;
  tombstones: Set<string>;
  inputDeletes: Map<string, PendingJobInputDelete>;
  automaticCleanup: Map<string, AutomaticCleanupRecord>;
};

interface AutomaticCleanupRecord {
  pending: boolean;
  lastStartedAt?: number;
  leaseToken?: string;
  leaseUntil?: number;
}

const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'superseded']);
const ACTIVE = new Set(['queued', 'running', 'retry_wait']);
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function validIso(value: string): boolean {
  return isoPattern.test(value) && Number.isFinite(Date.parse(value));
}

function requireIso(value: string, name: string): number {
  if (!validIso(value)) throw new TypeError(`${name} must be a valid ISO timestamp`);
  return Date.parse(value);
}

function laterIso(previous: string, current: string): string {
  return Date.parse(current) > Date.parse(previous) ? current : previous;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(deckId: string, jobId: string): string {
  return `${deckId}\0${jobId}`;
}

function inputDeleteKey(deckId: string, inputKey: string): string {
  return `${deckId}\0${inputKey}`;
}

function exactJobInputKey(
  deckId: string,
  jobId: string,
  inputKey: string | undefined,
): inputKey is string {
  return (
    inputKey !== undefined &&
    isDeckId(deckId) &&
    isJobId(jobId) &&
    inputKey === `private/jobs/${deckId}/${jobId}.json`
  );
}

function enqueueUnusedInput(
  state: MemoryState,
  deckId: string,
  inputKey: string | undefined,
  wakeAutomaticCleanup = false,
): void {
  if (inputKey === undefined) return;
  const prefix = `private/jobs/${deckId}/`;
  const inputJobId = inputKey.startsWith(prefix)
    ? inputKey.slice(prefix.length, -'.json'.length)
    : '';
  if (!isDeckId(deckId) || !isJobId(inputJobId) || inputKey !== `${prefix}${inputJobId}.json`)
    return;
  if (
    [...state.jobs.values()].some(
      (record) => record.snapshot.deckId === deckId && record.inputKey === inputKey,
    )
  )
    return;
  const item: PendingJobInputDelete = {
    deckId,
    jobId: inputJobId,
    inputKey,
    token: crypto.randomUUID(),
  };
  state.inputDeletes.set(inputDeleteKey(deckId, inputKey), item);
  if (wakeAutomaticCleanup) {
    const schedule = state.automaticCleanup.get(deckId) ?? { pending: false };
    schedule.pending = true;
    state.automaticCleanup.set(deckId, schedule);
  }
}

function cloneRecord(record: PublicationJobRecord): PublicationJobRecord {
  return clone(record);
}

function encodeCursor(deckId: string, snapshot: JobSnapshot): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ deckId, createdAt: snapshot.createdAt, id: snapshot.id }),
  );
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function decodeCursor(cursor: string, deckId: string): { createdAt: string; id: string } {
  try {
    const base64 = cursor.replace(/-/gu, '+').replace(/_/gu, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !('deckId' in value) ||
      value.deckId !== deckId ||
      !('createdAt' in value) ||
      typeof value.createdAt !== 'string' ||
      !validIso(value.createdAt) ||
      !('id' in value) ||
      typeof value.id !== 'string'
    )
      throw new TypeError('invalid cursor');
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new TypeError('Invalid job cursor');
  }
}

function compareJobIds(left: string, right: string): number {
  const canonicalLeft = left.toLowerCase();
  const canonicalRight = right.toLowerCase();
  return canonicalLeft < canonicalRight ? -1 : canonicalLeft > canonicalRight ? 1 : 0;
}

function newestFirst(left: PublicationJobRecord, right: PublicationJobRecord): number {
  const time = Date.parse(right.snapshot.createdAt) - Date.parse(left.snapshot.createdAt);
  return time || compareJobIds(right.snapshot.id, left.snapshot.id);
}

function active(record: PublicationJobRecord): boolean {
  return ACTIVE.has(record.snapshot.status);
}

function touch(record: PublicationJobRecord, now: string): void {
  record.snapshot.version += 1;
  record.snapshot.updatedAt = laterIso(record.snapshot.updatedAt, now);
}

function supersedeUnpublished(
  state: MemoryState,
  deckId: string,
  generation: bigint,
  now: string,
): void {
  for (const record of state.jobs.values()) {
    if (
      record.snapshot.deckId !== deckId ||
      !active(record) ||
      record.generation === undefined ||
      BigInt(record.generation) >= generation ||
      record.snapshot.result !== undefined
    )
      continue;
    record.snapshot.status = 'superseded';
    const finishedAt = laterIso(record.snapshot.updatedAt, now);
    record.snapshot.finishedAt = finishedAt;
    record.snapshot.stages = record.snapshot.stages.map((stage) =>
      stage.status === 'pending' || stage.status === 'running'
        ? { ...stage, status: 'skipped', finishedAt }
        : stage,
    );
    delete record.snapshot.progress;
    delete record.snapshot.error;
    delete record.snapshot.nextRunAt;
    delete record.leaseToken;
    delete record.leaseUntil;
    touch(record, now);
  }
}

function cloneNewJob(job: NewPublicationJob): PublicationJobRecord {
  return clone(job);
}

function jobIsCurrentLease(
  record: PublicationJobRecord | undefined,
  lease: JobLease,
): record is PublicationJobRecord {
  return (
    !!record &&
    record.snapshot.status === 'running' &&
    record.leaseToken === lease.leaseToken &&
    record.leaseUntil !== undefined &&
    Date.parse(record.leaseUntil) > Date.parse(lease.now)
  );
}

function checkLease(lease: JobLease): void {
  requireIso(lease.now, 'now');
}

function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

function cleanupDueAt(record: AutomaticCleanupRecord): number | null {
  if (record.lastStartedAt === undefined) return 0;
  return Math.max(record.lastStartedAt + JOB_CLEANUP_INTERVAL_MS, record.leaseUntil ?? 0);
}

function validateCleanupClaim(options: {
  now: string;
  leaseUntil: string;
  leaseToken: string;
  deckId?: string;
}): { now: number; leaseUntil: number } {
  const now = requireIso(options.now, 'now');
  const leaseUntil = requireIso(options.leaseUntil, 'leaseUntil');
  if (leaseUntil <= now) throw new RangeError('leaseUntil must be later than now');
  if (!uuidPattern.test(options.leaseToken)) throw new TypeError('leaseToken must be a UUID');
  if (options.deckId !== undefined && !isDeckId(options.deckId))
    throw new TypeError('deckId must be a valid deck id');
  return { now, leaseUntil };
}

function jobCount(state: MemoryState, deckId: string): number {
  let count = 0;
  for (const record of state.jobs.values()) {
    if (record.snapshot.deckId === deckId && active(record)) count += 1;
  }
  return count;
}

function accepted(record: PublicationJobRecord): JobAdmissionResult {
  return { outcome: 'accepted', job: cloneRecord(record) };
}

function replayOrConflict(existing: PublicationJobRecord, requestHash: string): JobAdmissionResult {
  return existing.requestHash === requestHash
    ? { outcome: 'replayed', job: cloneRecord(existing) }
    : { outcome: 'conflict' };
}

function ensureSnapshot(job: NewPublicationJob): PublicationJobRecord {
  const record = cloneNewJob(job);
  record.snapshot.status = 'queued';
  record.snapshot.version = Math.max(1, record.snapshot.version);
  if (record.snapshot.attempt < 0) record.snapshot.attempt = 0;
  delete record.snapshot.finishedAt;
  delete record.snapshot.nextRunAt;
  return record;
}

export function createMemoryPublicationJobStore(): PublicationJobStore {
  const state: MemoryState = {
    decks: new Map(),
    jobs: new Map(),
    tombstones: new Set(),
    inputDeletes: new Map(),
    automaticCleanup: new Map(),
  };
  const publications = createMemoryPublicationStoreWithState(state, (deckId, generation, now) =>
    supersedeUnpublished(state, deckId, generation, now),
  );

  return {
    publications,
    maintenance: {
      automatic: {
        async claim(options): Promise<JobCleanupLease | null> {
          const { now, leaseUntil } = validateCleanupClaim(options);
          const candidates = [...state.automaticCleanup.entries()]
            .filter(([deckId]) => options.deckId === undefined || deckId === options.deckId)
            .filter(([, record]) => {
              const leaseLive = record.leaseUntil !== undefined && record.leaseUntil > now;
              if (leaseLive || (!record.pending && record.leaseToken === undefined)) return false;
              return (cleanupDueAt(record) ?? 0) <= now;
            })
            .sort(([leftDeck, left], [rightDeck, right]) => {
              const due = (cleanupDueAt(left) ?? 0) - (cleanupDueAt(right) ?? 0);
              return due || leftDeck.localeCompare(rightDeck);
            });
          const candidate = candidates[0];
          if (!candidate) return null;
          const [deckId, record] = candidate;
          record.pending = false;
          record.lastStartedAt = now;
          record.leaseToken = options.leaseToken;
          record.leaseUntil = leaseUntil;
          return { deckId, leaseToken: options.leaseToken, leaseUntil: options.leaseUntil };
        },
        async finish(lease, options): Promise<boolean> {
          const now = requireIso(options.now, 'now');
          if (typeof options.retry !== 'boolean') throw new TypeError('retry must be a boolean');
          if (!isDeckId(lease.deckId)) throw new TypeError('deckId must be a valid deck id');
          if (!uuidPattern.test(lease.leaseToken)) throw new TypeError('leaseToken must be a UUID');
          const leaseUntil = requireIso(lease.leaseUntil, 'leaseUntil');
          const record = state.automaticCleanup.get(lease.deckId);
          if (
            !record ||
            record.leaseToken !== lease.leaseToken ||
            record.leaseUntil !== leaseUntil ||
            leaseUntil <= now
          )
            return false;
          record.pending = record.pending || options.retry;
          delete record.leaseToken;
          delete record.leaseUntil;
          return true;
        },
      } satisfies AutomaticJobCleanupStore,
      async isExpired(identity) {
        return state.tombstones.has(key(identity.deckId, identity.jobId));
      },
      async cleanup(options) {
        const cutoff = requireIso(options.cutoff, 'cutoff');
        if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
          throw new RangeError('Job cleanup limit must be between 1 and 100');
        const eligible = [...state.jobs.values()]
          .filter((record) => {
            const snapshot = record.snapshot;
            return (
              snapshot.deckId === options.deckId &&
              isTerminal(snapshot.status) &&
              snapshot.finishedAt !== undefined &&
              Date.parse(snapshot.finishedAt) <= cutoff &&
              ![...state.jobs.values()].some(
                (child) =>
                  child.snapshot.deckId === options.deckId &&
                  child.snapshot.parentJobId === snapshot.id,
              )
            );
          })
          .sort(
            (left, right) =>
              Date.parse(left.snapshot.finishedAt!) - Date.parse(right.snapshot.finishedAt!) ||
              compareJobIds(left.snapshot.id, right.snapshot.id),
          );
        const selected = eligible.slice(0, options.limit);
        if (!options.dryRun) {
          for (const record of selected) {
            const identity = {
              deckId: record.snapshot.deckId,
              jobId: record.snapshot.id,
            };
            state.jobs.delete(key(identity.deckId, identity.jobId));
            state.tombstones.add(key(identity.deckId, identity.jobId));
            enqueueUnusedInput(state, identity.deckId, record.inputKey);
          }
        }
        const excluded = options.dryRun
          ? new Set(selected.map((record) => key(options.deckId, record.snapshot.id)))
          : new Set<string>();
        const more = [...state.jobs.values()].some((record) => {
          const snapshot = record.snapshot;
          if (
            snapshot.deckId !== options.deckId ||
            excluded.has(key(options.deckId, snapshot.id)) ||
            !isTerminal(snapshot.status) ||
            snapshot.finishedAt === undefined ||
            Date.parse(snapshot.finishedAt) > cutoff
          )
            return false;
          return ![...state.jobs.values()].some(
            (child) =>
              child.snapshot.deckId === options.deckId &&
              child.snapshot.parentJobId === snapshot.id &&
              !excluded.has(key(options.deckId, child.snapshot.id)),
          );
        });
        return {
          jobs: selected.map((record) => ({
            jobId: record.snapshot.id,
            finishedAt: record.snapshot.finishedAt!,
          })),
          more,
        };
      },
      async listPendingInputDeletes(options) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
          throw new RangeError('Pending input deletion limit must be between 1 and 100');
        const items = [...state.inputDeletes.values()]
          .filter((item) => item.deckId === options.deckId)
          .sort((left, right) => left.jobId.localeCompare(right.jobId));
        return { items: clone(items.slice(0, options.limit)), pendingCount: items.length };
      },
      async acknowledgeInputDelete(item) {
        const storageKey = inputDeleteKey(item.deckId, item.inputKey);
        if (state.inputDeletes.get(storageKey)?.token !== item.token) return false;
        state.inputDeletes.delete(storageKey);
        return true;
      },
    },

    async submit(job): Promise<JobAdmissionResult> {
      const snapshot = job.snapshot;
      const id = key(snapshot.deckId, snapshot.id);
      if (state.tombstones.has(id)) {
        enqueueUnusedInput(
          state,
          snapshot.deckId,
          exactJobInputKey(snapshot.deckId, snapshot.id, job.inputKey) ? job.inputKey : undefined,
          true,
        );
        return { outcome: 'expired' };
      }
      const existing = state.jobs.get(id);
      if (existing) return replayOrConflict(existing, job.requestHash);
      if (jobCount(state, snapshot.deckId) >= 10) return { outcome: 'limit' };

      const deck = state.decks.get(snapshot.deckId) ?? { generation: 0n, current: null };
      deck.generation += 1n;
      state.decks.set(snapshot.deckId, deck);
      const now = new Date().toISOString();
      supersedeUnpublished(state, snapshot.deckId, deck.generation, now);
      const record = ensureSnapshot(job);
      record.generation = deck.generation.toString();
      state.jobs.set(id, record);
      return accepted(record);
    },

    async get(identity): Promise<PublicationJobRecord | null> {
      const record = state.jobs.get(key(identity.deckId, identity.jobId));
      return record ? cloneRecord(record) : null;
    },

    async list(options): Promise<{ items: PublicationJobRecord[]; nextCursor?: string }> {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
        throw new RangeError('Job list limit must be between 1 and 100');
      }
      const cursor =
        options.cursor === undefined ? undefined : decodeCursor(options.cursor, options.deckId);
      const records = [...state.jobs.values()]
        .filter((record) => record.snapshot.deckId === options.deckId)
        .sort(newestFirst)
        .filter(
          (record) =>
            !cursor ||
            Date.parse(record.snapshot.createdAt) < Date.parse(cursor.createdAt) ||
            (Date.parse(record.snapshot.createdAt) === Date.parse(cursor.createdAt) &&
              compareJobIds(record.snapshot.id, cursor.id) < 0),
        );
      const page = records.slice(0, options.limit);
      const hasMore = records.length > page.length;
      return {
        items: page.map(cloneRecord),
        ...(hasMore && page.length > 0
          ? { nextCursor: encodeCursor(options.deckId, page[page.length - 1]!.snapshot) }
          : {}),
      };
    },

    async claim(options): Promise<PublicationJobRecord | null> {
      const nowMs = requireIso(options.now, 'now');
      const leaseUntilMs = requireIso(options.leaseUntil, 'leaseUntil');
      if (leaseUntilMs <= nowMs) throw new RangeError('leaseUntil must be later than now');
      if (!uuidPattern.test(options.leaseToken)) throw new TypeError('leaseToken must be a UUID');
      const candidates = [...state.jobs.values()]
        .filter(
          (record) => options.deckId === undefined || record.snapshot.deckId === options.deckId,
        )
        .filter((record) => {
          const status = record.snapshot.status;
          if (status === 'queued') return true;
          if (status === 'retry_wait')
            return (
              record.snapshot.nextRunAt !== undefined &&
              Date.parse(record.snapshot.nextRunAt) <= nowMs
            );
          return (
            status === 'running' &&
            record.leaseUntil !== undefined &&
            Date.parse(record.leaseUntil) <= nowMs
          );
        })
        .sort((a, b) => {
          const aTime = a.snapshot.nextRunAt ?? a.snapshot.createdAt;
          const bTime = b.snapshot.nextRunAt ?? b.snapshot.createdAt;
          return Date.parse(aTime) - Date.parse(bTime) || newestFirst(a, b);
        });
      const record = candidates[0];
      if (!record) return null;
      record.snapshot.status = 'running';
      record.snapshot.startedAt ??= options.now;
      delete record.snapshot.nextRunAt;
      delete record.snapshot.finishedAt;
      record.leaseToken = options.leaseToken;
      record.leaseUntil = options.leaseUntil;
      touch(record, options.now);
      return cloneRecord(record);
    },

    async checkpoint(lease, update): Promise<boolean> {
      checkLease(lease);
      if (update.leaseUntil !== undefined) {
        const until = requireIso(update.leaseUntil, 'leaseUntil');
        if (until <= Date.parse(lease.now)) return false;
      }
      const record = state.jobs.get(key(lease.deckId, lease.jobId));
      if (!jobIsCurrentLease(record, lease)) return false;
      if (update.phase !== undefined) record.snapshot.phase = update.phase;
      if (update.attempt !== undefined) record.snapshot.attempt = update.attempt;
      if (update.clearProgress) delete record.snapshot.progress;
      else if (update.progress !== undefined) record.snapshot.progress = clone(update.progress);
      if (update.stages !== undefined) record.snapshot.stages = clone(update.stages);
      if (update.preparedManifest !== undefined)
        record.preparedManifest = clone(update.preparedManifest);
      if (update.preparedCached !== undefined) record.preparedCached = update.preparedCached;
      if (update.leaseUntil !== undefined) record.leaseUntil = update.leaseUntil;
      touch(record, lease.now);
      return true;
    },

    async commitPublication(
      lease,
      manifest,
      result,
      stages,
    ): Promise<'published' | 'superseded' | 'lease_lost'> {
      checkLease(lease);
      const record = state.jobs.get(key(lease.deckId, lease.jobId));
      if (!record) return 'lease_lost';
      const deck = state.decks.get(lease.deckId);
      if (
        record.generation === undefined ||
        !deck ||
        BigInt(record.generation) !== deck.generation
      ) {
        if (active(record) && record.snapshot.result === undefined) {
          const now = lease.now;
          record.snapshot.status = 'superseded';
          record.snapshot.finishedAt = laterIso(record.snapshot.updatedAt, now);
          delete record.snapshot.nextRunAt;
          delete record.leaseToken;
          delete record.leaseUntil;
          touch(record, now);
        }
        return 'superseded';
      }
      if (!jobIsCurrentLease(record, lease)) return 'lease_lost';
      deck.current = clone(manifest);
      record.snapshot.result = clone(result);
      record.snapshot.stages = clone(stages);
      record.snapshot.phase = 'thumbnail';
      touch(record, lease.now);
      return 'published';
    },

    async finish(lease, update): Promise<boolean> {
      checkLease(lease);
      if (update.nextRunAt !== undefined) requireIso(update.nextRunAt, 'nextRunAt');
      const record = state.jobs.get(key(lease.deckId, lease.jobId));
      if (!jobIsCurrentLease(record, lease)) return false;
      record.snapshot.status = update.status;
      if (update.phase !== undefined) record.snapshot.phase = update.phase;
      record.snapshot.stages = clone(update.stages);
      if (update.result !== undefined) record.snapshot.result = clone(update.result);
      if (update.error !== undefined) record.snapshot.error = clone(update.error);
      else delete record.snapshot.error;
      if (update.status === 'retry_wait') {
        delete record.snapshot.finishedAt;
        record.snapshot.nextRunAt = update.nextRunAt ?? lease.now;
      } else {
        record.snapshot.finishedAt = laterIso(record.snapshot.updatedAt, lease.now);
        delete record.snapshot.nextRunAt;
      }
      delete record.leaseToken;
      delete record.leaseUntil;
      touch(record, lease.now);
      if (record.snapshot.kind === 'publication' && isTerminal(update.status)) {
        const cleanup = state.automaticCleanup.get(lease.deckId) ?? { pending: false };
        cleanup.pending = true;
        state.automaticCleanup.set(lease.deckId, cleanup);
      }
      return true;
    },

    async retry(parent, stage, job): Promise<JobAdmissionResult> {
      const child = job.snapshot;
      const childKey = key(parent.deckId, child.id);
      if (
        state.tombstones.has(key(parent.deckId, parent.jobId)) ||
        state.tombstones.has(childKey)
      ) {
        enqueueUnusedInput(state, parent.deckId, job.inputKey, true);
        return { outcome: 'expired' };
      }
      const existing = state.jobs.get(childKey);
      if (existing) return replayOrConflict(existing, job.requestHash);
      const parentRecord = state.jobs.get(key(parent.deckId, parent.jobId));
      if (!parentRecord) return { outcome: 'not_found' };
      if (
        !isTerminal(parentRecord.snapshot.status) ||
        child.deckId !== parent.deckId ||
        child.parentJobId !== parent.jobId
      ) {
        return { outcome: 'invalid_retry' };
      }
      const expectedKind = stage === 'thumbnail' ? 'thumbnail' : 'publication';
      if (child.kind !== expectedKind) return { outcome: 'invalid_retry' };
      if (
        [...state.jobs.values()].some(
          (record) =>
            record.snapshot.deckId === parent.deckId &&
            record.snapshot.parentJobId === parent.jobId &&
            record.snapshot.kind === expectedKind &&
            active(record),
        )
      )
        return { outcome: 'active_retry' };
      const deck = state.decks.get(parent.deckId);
      let generation: string | undefined;
      if (stage === 'thumbnail') {
        const result = parentRecord.snapshot.result;
        if (!result || result.thumbnail === 'ready') {
          return { outcome: 'invalid_retry' };
        }
        if (job.targetRevision !== result.revision) return { outcome: 'invalid_retry' };
      } else {
        if (
          parentRecord.snapshot.status !== 'failed' ||
          parentRecord.snapshot.result !== undefined ||
          parentRecord.generation === undefined ||
          !parentRecord.inputKey ||
          !parentRecord.inputHash
        )
          return { outcome: 'invalid_retry' };
        if (!deck || BigInt(parentRecord.generation) !== deck.generation)
          return { outcome: 'superseded' };
        generation = parentRecord.generation;
      }
      if (jobCount(state, parent.deckId) >= 10) return { outcome: 'limit' };

      const record = ensureSnapshot(job);
      if (stage === 'thumbnail') {
        record.targetRevision = parentRecord.snapshot.result!.revision;
        record.snapshot.result = clone(job.snapshot.result ?? parentRecord.snapshot.result!);
      } else {
        const currentDeck = state.decks.get(parent.deckId)!;
        currentDeck.generation += 1n;
        generation = currentDeck.generation.toString();
        supersedeUnpublished(
          state,
          parent.deckId,
          currentDeck.generation,
          new Date().toISOString(),
        );
      }
      if (generation !== undefined) record.generation = generation;
      state.jobs.set(childKey, record);
      return accepted(record);
    },
  };
}
