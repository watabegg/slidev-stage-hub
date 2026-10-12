import {
  JOB_CLEANUP_INTERVAL_MS,
  JOB_LEASE_MS,
  runPublicationJob,
  runPublicationJobCleanup,
} from '@slidock/server';
import type {
  JobCleanupLease,
  JobAdmissionResult,
  JobCheckpoint,
  JobFinish,
  JobIdentity,
  JobLease,
  NewPublicationJob,
  PendingJobInputDelete,
  PublicationJobRecord,
  PublicationJobStore,
  ReleaseManifest,
} from '@slidock/server';
import type { JobResult, StageSnapshot } from '@slidock/protocol';
import { isJobId } from '@slidock/protocol';
import {
  createCloudflareOptions,
  createDeckBoundDurableObjectPublicationJobStore,
} from '@slidock/adapter-cloudflare';
import { DurableObject } from 'cloudflare:workers';
import type { WorkerEnv } from './types.js';

const SCHEMA_VERSION = 4;
const MAX_ACTIVE_JOBS = 10;
const LEGACY_UNSCOPED_DECK_ID = '__legacy__';

type SqlTransaction = DurableObjectTransaction;

interface GenerationRow {
  generation: number;
}

interface CurrentRow {
  current: string | null;
}

interface IdentityRow {
  deck_id: string;
}

interface VersionRow {
  version: number;
}

interface RecordRow {
  record_json: string;
}

interface AlarmRow {
  alarm_at: string | null;
}

interface CleanupRow {
  job_id: string;
  input_key: string | null;
  finished_at: string;
}

interface InputDeleteRow {
  job_id: string;
  input_key: string;
  token: string;
}

interface TombstoneRow {
  job_id: string;
}

interface CleanupScheduleRow {
  pending: number;
  last_started_at: string | null;
  lease_token: string | null;
  lease_until: string | null;
}

type SqlRow<T extends object> = Record<string, SqlStorageValue> & T;

function fromRpc<T>(value: string): T {
  return JSON.parse(value) as T;
}

function toRpc(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error('Durable Object RPC result is not JSON serializable');
  return serialized;
}

function isDeckId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(value)
  );
}

function checkedDeckId(value: unknown): string {
  if (!isDeckId(value)) throw new Error('Invalid Durable Object deck identity');
  return value;
}

function checkedTime(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error('Durable Object job timestamps must be canonical ISO strings');
  }
  return milliseconds;
}

function optionalJson(value: unknown): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Durable Object job state is not JSON serializable');
  return json;
}

function parseRecord(value: string): PublicationJobRecord {
  // Rows are written only by saveRecord(), which serializes this exact private port shape.
  return JSON.parse(value) as PublicationJobRecord;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nextVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Publication job version is outside the safe integer range');
  }
  return value + 1;
}

function generationNumber(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return null;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : null;
}

function makeCursor(deckId: string, createdAt: string, jobId: string): string {
  return btoa(JSON.stringify({ deckId, createdAt, jobId }))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function readCursor(cursor: string, expectedDeckId: string): { createdAt: string; jobId: string } {
  if (cursor.length > 2048 || cursor.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new TypeError('Invalid Durable Object publication cursor');
  }
  const base64 = cursor.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  let decoded: unknown;
  try {
    decoded = JSON.parse(atob(padded)) as unknown;
  } catch {
    throw new TypeError('Invalid Durable Object publication cursor');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded) ||
    !('deckId' in decoded) ||
    decoded.deckId !== expectedDeckId ||
    !('createdAt' in decoded) ||
    typeof decoded.createdAt !== 'string' ||
    !('jobId' in decoded) ||
    typeof decoded.jobId !== 'string'
  ) {
    throw new TypeError('Publication cursor does not belong to this deck');
  }
  try {
    checkedTime(decoded.createdAt);
  } catch {
    throw new TypeError('Invalid Durable Object publication cursor timestamp');
  }
  return { createdAt: decoded.createdAt, jobId: decoded.jobId };
}

function terminal(status: PublicationJobRecord['snapshot']['status']): boolean {
  return (
    status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'superseded'
  );
}

function admissionIdempotency(
  existing: PublicationJobRecord | null,
  requestHash: string,
): JobAdmissionResult | null {
  if (!existing) return null;
  return existing.requestHash === requestHash
    ? { outcome: 'replayed', job: clone(existing) }
    : { outcome: 'conflict' };
}

/**
 * Holds each deck's publication pointer, generation fence, jobs, and alarm in the
 * same SQLite-backed Durable Object. The v1 class name and migration stay intact.
 */
export class DeckVersions extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  private initializeSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, current TEXT)',
    );
    sql.exec('INSERT OR IGNORE INTO state VALUES (1, 0, NULL)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
    );
    sql.exec('INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 1)');
    const version = sql
      .exec<SqlRow<VersionRow>>('SELECT version FROM schema_version WHERE id = 1')
      .one().version;
    if (!Number.isSafeInteger(version) || version > SCHEMA_VERSION) {
      throw new Error(`Unsupported DeckVersions SQLite schema version: ${version}`);
    }

    sql.exec(
      'CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK (id = 1), deck_id TEXT NOT NULL)',
    );
    sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        deck_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('publication', 'thumbnail')),
        parent_job_id TEXT,
        request_hash TEXT NOT NULL,
        input_key TEXT,
        input_hash TEXT,
        target_revision TEXT,
        generation INTEGER,
        profile_digest TEXT NOT NULL,
        compiler_contract_version TEXT NOT NULL,
        thumbnail TEXT NOT NULL CHECK (thumbnail IN ('auto', 'none')),
        view_token_hash TEXT NOT NULL,
        view_expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'partial', 'failed', 'superseded')),
        phase TEXT NOT NULL CHECK (phase IN ('runtime', 'compile', 'store', 'publish', 'thumbnail')),
        version INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        next_run_at TEXT,
        lease_token TEXT,
        lease_until TEXT,
        progress TEXT,
        stages TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        prepared_manifest TEXT,
        prepared_cached INTEGER,
        record_json TEXT NOT NULL,
        PRIMARY KEY (deck_id, job_id),
        CHECK ((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
      )
    `);
    sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (deck_id, status, next_run_at, lease_until)',
    );
    sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_jobs_history ON jobs (deck_id, created_at DESC, job_id)',
    );
    sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_child
      ON jobs (deck_id, parent_job_id, kind)
      WHERE parent_job_id IS NOT NULL AND status IN ('queued', 'running', 'retry_wait')
    `);
    sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs (deck_id, parent_job_id) WHERE parent_job_id IS NOT NULL',
    );
    sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_jobs_input_key ON jobs (deck_id, input_key) WHERE input_key IS NOT NULL',
    );
    sql.exec(`
      CREATE TABLE IF NOT EXISTS job_tombstones (
        deck_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        PRIMARY KEY (deck_id, job_id)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS job_input_outbox (
        deck_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        input_key TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (deck_id, input_key)
      )
    `);
    sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_job_input_outbox_order ON job_input_outbox (deck_id, created_at, input_key)',
    );
    sql.exec(`
      CREATE TABLE IF NOT EXISTS job_cleanup_schedule (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
        last_started_at TEXT,
        lease_token TEXT,
        lease_until TEXT,
        CHECK ((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
      )
    `);
    sql.exec('UPDATE schema_version SET version = 4 WHERE id = 1');
  }

  private identityValue(): string | null {
    const row = this.ctx.storage.sql
      .exec<SqlRow<IdentityRow>>('SELECT deck_id FROM identity WHERE id = 1')
      .toArray()[0];
    return row?.deck_id ?? null;
  }

  private async withDeck<T>(
    requestedDeckId: string | undefined,
    action: (transaction: SqlTransaction, deckId: string) => Promise<T> | T,
    establish = true,
  ): Promise<T> {
    const deckId = checkedDeckId(
      requestedDeckId ?? this.identityValue() ?? LEGACY_UNSCOPED_DECK_ID,
    );
    return this.ctx.storage.transaction(async (transaction) => {
      const current = this.ctx.storage.sql
        .exec<SqlRow<IdentityRow>>('SELECT deck_id FROM identity WHERE id = 1')
        .toArray()[0];
      if (current && current.deck_id !== deckId) {
        throw new Error('DeckVersions Durable Object cannot be used for a different deck');
      }
      if (!current && establish) {
        this.ctx.storage.sql.exec('INSERT INTO identity (id, deck_id) VALUES (1, ?)', deckId);
      }
      return action(transaction, deckId);
    });
  }

  private loadRecord(deckId: string, jobId: string): PublicationJobRecord | null {
    const row = this.ctx.storage.sql
      .exec<SqlRow<RecordRow>>(
        'SELECT record_json FROM jobs WHERE deck_id = ? AND job_id = ?',
        deckId,
        jobId,
      )
      .toArray()[0];
    return row ? parseRecord(row.record_json) : null;
  }

  private isExpired(deckId: string, jobId: string): boolean {
    if (!isJobId(jobId)) return false;
    return (
      this.ctx.storage.sql
        .exec<SqlRow<TombstoneRow>>(
          'SELECT job_id FROM job_tombstones WHERE deck_id = ? AND job_id = ?',
          deckId,
          jobId,
        )
        .toArray().length > 0
    );
  }

  private exactInputJobId(deckId: string, inputKey: string): string | null {
    const prefix = `private/jobs/${deckId}/`;
    if (!inputKey.startsWith(prefix)) return null;
    const jobId = inputKey.slice(prefix.length, -'.json'.length);
    return inputKey === `${prefix}${jobId}.json` && isJobId(jobId) ? jobId : null;
  }

  private enqueueUnusedInput(
    deckId: string,
    inputKey: string | undefined,
    expectedJobId?: string,
    wakeAutomaticCleanup = false,
  ): boolean {
    if (inputKey === undefined) return false;
    const jobId = this.exactInputJobId(deckId, inputKey);
    if (
      !jobId ||
      (expectedJobId !== undefined && jobId.toLowerCase() !== expectedJobId.toLowerCase())
    )
      return false;
    const referenced = this.ctx.storage.sql
      .exec<SqlRow<{ job_id: string }>>(
        'SELECT job_id FROM jobs WHERE deck_id = ? AND input_key = ? LIMIT 1',
        deckId,
        inputKey,
      )
      .toArray()[0];
    if (referenced) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO job_input_outbox (deck_id, job_id, input_key, token, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (deck_id, input_key) DO UPDATE
         SET job_id = excluded.job_id, token = excluded.token, created_at = excluded.created_at`,
      deckId,
      jobId,
      inputKey,
      crypto.randomUUID(),
      new Date().toISOString(),
    );
    if (wakeAutomaticCleanup) {
      this.ctx.storage.sql.exec(
        `INSERT INTO job_cleanup_schedule (id, pending)
         VALUES (1, 1)
         ON CONFLICT (id) DO UPDATE SET pending = 1`,
      );
    }
    return true;
  }

  private records(sql: string, ...values: (string | number | null)[]): PublicationJobRecord[] {
    return this.ctx.storage.sql
      .exec<SqlRow<RecordRow>>(sql, ...values)
      .toArray()
      .map((row) => parseRecord(row.record_json));
  }

  private hasEligibleJobAfterCleanup(
    deckId: string,
    cutoff: string,
    excludedJobIds: string[],
  ): boolean {
    const jobExclusion = excludedJobIds.length
      ? `AND job.job_id NOT IN (${excludedJobIds.map(() => '?').join(', ')})`
      : '';
    const childExclusion = excludedJobIds.length
      ? `AND child.job_id NOT IN (${excludedJobIds.map(() => '?').join(', ')})`
      : '';
    const result = this.ctx.storage.sql
      .exec<SqlRow<{ job_id: string }>>(
        `SELECT job.job_id FROM jobs AS job
         WHERE job.deck_id = ?
           AND job.status IN ('succeeded', 'partial', 'failed', 'superseded')
           AND job.finished_at IS NOT NULL AND job.finished_at <= ?
           ${jobExclusion}
           AND NOT EXISTS (
             SELECT 1 FROM jobs AS child
             WHERE child.deck_id = job.deck_id AND child.parent_job_id = job.job_id
             ${childExclusion}
           )
         LIMIT 1`,
        deckId,
        cutoff,
        ...excludedJobIds,
        ...excludedJobIds,
      )
      .toArray();
    return result.length > 0;
  }

  private saveRecord(record: PublicationJobRecord): void {
    const snapshot = record.snapshot;
    const generation = generationNumber(record.generation);
    if (record.generation !== undefined && generation === null) {
      throw new Error('Publication job generation is invalid');
    }
    const dueAt =
      snapshot.status === 'queued'
        ? (snapshot.nextRunAt ?? snapshot.createdAt)
        : snapshot.status === 'retry_wait'
          ? (snapshot.nextRunAt ?? null)
          : null;
    const cached = record.preparedCached === undefined ? null : record.preparedCached ? 1 : 0;
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (
        deck_id, job_id, kind, parent_job_id, request_hash, input_key, input_hash,
        target_revision, generation, profile_digest, compiler_contract_version,
        thumbnail, view_token_hash, view_expires_at, status, phase, version, attempt,
        next_run_at, lease_token, lease_until, progress, stages, result, error,
        created_at, updated_at, started_at, finished_at, prepared_manifest,
        prepared_cached, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deck_id, job_id) DO UPDATE SET
        kind = excluded.kind,
        parent_job_id = excluded.parent_job_id,
        request_hash = excluded.request_hash,
        input_key = excluded.input_key,
        input_hash = excluded.input_hash,
        target_revision = excluded.target_revision,
        generation = excluded.generation,
        profile_digest = excluded.profile_digest,
        compiler_contract_version = excluded.compiler_contract_version,
        thumbnail = excluded.thumbnail,
        view_token_hash = excluded.view_token_hash,
        view_expires_at = excluded.view_expires_at,
        status = excluded.status,
        phase = excluded.phase,
        version = excluded.version,
        attempt = excluded.attempt,
        next_run_at = excluded.next_run_at,
        lease_token = excluded.lease_token,
        lease_until = excluded.lease_until,
        progress = excluded.progress,
        stages = excluded.stages,
        result = excluded.result,
        error = excluded.error,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        prepared_manifest = excluded.prepared_manifest,
        prepared_cached = excluded.prepared_cached,
        record_json = excluded.record_json`,
      record.snapshot.deckId,
      snapshot.id,
      snapshot.kind,
      snapshot.parentJobId ?? null,
      record.requestHash,
      record.inputKey ?? null,
      record.inputHash ?? null,
      record.targetRevision ?? null,
      generation,
      record.profileDigest,
      record.compilerContractVersion,
      record.thumbnail,
      record.viewTokenHash,
      record.viewExpiresAt,
      snapshot.status,
      snapshot.phase,
      snapshot.version,
      snapshot.attempt,
      dueAt,
      record.leaseToken ?? null,
      record.leaseUntil ?? null,
      optionalJson(snapshot.progress),
      JSON.stringify(snapshot.stages),
      optionalJson(snapshot.result),
      optionalJson(snapshot.error),
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.startedAt ?? null,
      snapshot.finishedAt ?? null,
      optionalJson(record.preparedManifest),
      cached,
      JSON.stringify(record),
    );
  }

  private incrementGeneration(): number {
    const row = this.ctx.storage.sql
      .exec<SqlRow<GenerationRow>>('SELECT generation FROM state WHERE id = 1')
      .one();
    if (
      !Number.isSafeInteger(row.generation) ||
      row.generation < 0 ||
      row.generation >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error('Publication generation is outside the safe integer range');
    }
    const generation = row.generation + 1;
    this.ctx.storage.sql.exec('UPDATE state SET generation = ? WHERE id = 1', generation);
    return generation;
  }

  private currentGeneration(): number {
    const row = this.ctx.storage.sql
      .exec<SqlRow<GenerationRow>>('SELECT generation FROM state WHERE id = 1')
      .one();
    return row.generation;
  }

  private supersedeUnpublished(deckId: string, now: string): void {
    const candidates = this.records(
      `SELECT record_json FROM jobs
       WHERE deck_id = ? AND kind = 'publication'
         AND status IN ('queued', 'running', 'retry_wait') AND result IS NULL`,
      deckId,
    );
    for (const record of candidates) {
      const snapshot = record.snapshot;
      snapshot.status = 'superseded';
      snapshot.version = nextVersion(snapshot.version);
      snapshot.updatedAt = now;
      snapshot.finishedAt = now;
      delete snapshot.nextRunAt;
      delete snapshot.progress;
      delete snapshot.error;
      snapshot.stages = snapshot.stages.map((stage) =>
        stage.status === 'pending' || stage.status === 'running'
          ? { ...stage, status: 'skipped', finishedAt: now }
          : stage,
      );
      delete record.leaseToken;
      delete record.leaseUntil;
      this.saveRecord(record);
    }
  }

  private async refreshAlarm(transaction: SqlTransaction, deckId: string): Promise<void> {
    const jobAlarm = this.ctx.storage.sql
      .exec<SqlRow<AlarmRow>>(
        `SELECT MIN(alarm_at) AS alarm_at FROM (
          SELECT next_run_at AS alarm_at FROM jobs
           WHERE deck_id = ? AND status IN ('queued', 'retry_wait') AND next_run_at IS NOT NULL
          UNION ALL
          SELECT lease_until AS alarm_at FROM jobs
           WHERE deck_id = ? AND status = 'running' AND lease_until IS NOT NULL
        )`,
        deckId,
        deckId,
      )
      .one();
    const schedule = this.ctx.storage.sql
      .exec<SqlRow<CleanupScheduleRow>>(
        `SELECT pending, last_started_at, lease_token, lease_until
         FROM job_cleanup_schedule WHERE id = 1`,
      )
      .toArray()[0];
    let cleanupAlarm: number | null = null;
    if (schedule && (schedule.pending === 1 || schedule.lease_token !== null)) {
      const lastStartedAt =
        schedule.last_started_at === null
          ? 1
          : checkedTime(schedule.last_started_at) + JOB_CLEANUP_INTERVAL_MS;
      const leaseUntil = schedule.lease_until === null ? 0 : checkedTime(schedule.lease_until);
      cleanupAlarm = Math.max(lastStartedAt, leaseUntil);
    }
    const jobAlarmAt = jobAlarm.alarm_at === null ? null : checkedTime(jobAlarm.alarm_at);
    const alarmAt =
      jobAlarmAt === null
        ? cleanupAlarm
        : cleanupAlarm === null
          ? jobAlarmAt
          : Math.min(jobAlarmAt, cleanupAlarm);
    if (alarmAt === null) {
      await transaction.deleteAlarm();
      return;
    }
    await transaction.setAlarm(alarmAt);
  }

  private leaseMatches(record: PublicationJobRecord | null, lease: JobLease): boolean {
    if (!record || record.snapshot.status !== 'running' || record.leaseToken !== lease.leaseToken) {
      return false;
    }
    if (!record.leaseUntil) return false;
    return checkedTime(record.leaseUntil) > checkedTime(lease.now);
  }

  /** Legacy synchronous publication begin still shares the generation fence and wake transaction. */
  async begin(deckId?: string): Promise<number> {
    return this.withDeck(deckId, async (transaction, identity) => {
      const now = new Date().toISOString();
      const generation = this.incrementGeneration();
      this.supersedeUnpublished(identity, now);
      await this.refreshAlarm(transaction, identity);
      return generation;
    });
  }

  async current(deckId?: string): Promise<object | null> {
    return this.withDeck(deckId, () => {
      const current = this.ctx.storage.sql
        .exec<SqlRow<CurrentRow>>('SELECT current FROM state WHERE id = 1')
        .one().current;
      return current === null ? null : (JSON.parse(current) as object);
    });
  }

  async commit(generation: number, manifest: object, deckId?: string): Promise<boolean> {
    return this.withDeck(deckId, () => {
      if (
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        this.currentGeneration() !== generation
      ) {
        return false;
      }
      const current = JSON.stringify(manifest);
      if (current === undefined) throw new Error('Publication manifest is not JSON serializable');
      this.ctx.storage.sql.exec('UPDATE state SET current = ? WHERE id = 1', current);
      return true;
    });
  }

  async jobsSubmit(jobJson: string): Promise<string> {
    const job = fromRpc<NewPublicationJob>(jobJson);
    const deckId = checkedDeckId(job.snapshot.deckId);
    const result = await this.withDeck(deckId, async (transaction, identity) => {
      if (this.isExpired(identity, job.snapshot.id)) {
        if (this.enqueueUnusedInput(identity, job.inputKey, job.snapshot.id, true)) {
          await this.refreshAlarm(transaction, identity);
        }
        return { outcome: 'expired' };
      }
      const existing = this.loadRecord(identity, job.snapshot.id);
      const replay = admissionIdempotency(existing, job.requestHash);
      if (replay) return replay;

      const active = this.ctx.storage.sql
        .exec<SqlRow<{ count: number }>>(
          `SELECT COUNT(*) AS count FROM jobs
           WHERE deck_id = ? AND status IN ('queued', 'running', 'retry_wait')`,
          identity,
        )
        .one().count;
      if (active >= MAX_ACTIVE_JOBS) return { outcome: 'limit' };

      const now = job.snapshot.createdAt;
      checkedTime(now);
      const generation = this.incrementGeneration();
      this.supersedeUnpublished(identity, now);
      const record: PublicationJobRecord = {
        ...clone(job),
        generation: String(generation),
        snapshot: clone(job.snapshot),
      };
      this.saveRecord(record);
      await this.refreshAlarm(transaction, identity);
      return { outcome: 'accepted', job: clone(record) };
    });
    return toRpc(result);
  }

  async jobsGet(identityJson: string): Promise<string | null> {
    const identity = fromRpc<JobIdentity>(identityJson);
    const deckId = checkedDeckId(identity.deckId);
    const record = await this.withDeck(deckId, () => {
      const record = this.loadRecord(deckId, identity.jobId);
      if (record && record.snapshot.deckId !== deckId) {
        throw new Error('Publication job record does not match its Durable Object deck');
      }
      return record ? clone(record) : null;
    });
    return record === null ? null : toRpc(record);
  }

  async jobsIsExpired(identityJson: string): Promise<boolean> {
    const identity = fromRpc<JobIdentity>(identityJson);
    const deckId = checkedDeckId(identity.deckId);
    const current = this.identityValue();
    if (current && current !== deckId) {
      throw new Error('DeckVersions Durable Object cannot be used for a different deck');
    }
    return this.isExpired(deckId, identity.jobId);
  }

  async jobsCleanup(optionsJson: string): Promise<string> {
    const options = fromRpc<{
      deckId: string;
      cutoff: string;
      limit: number;
      dryRun: boolean;
    }>(optionsJson);
    const deckId = checkedDeckId(options.deckId);
    checkedTime(options.cutoff);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error('Job cleanup limit must be from 1 to 100');
    }
    if (typeof options.dryRun !== 'boolean') throw new Error('Job cleanup dryRun must be boolean');
    const result = await this.withDeck(
      deckId,
      (_transaction, identity) => {
        const candidates = this.ctx.storage.sql
          .exec<SqlRow<CleanupRow>>(
            `SELECT job.job_id, job.input_key, job.finished_at FROM jobs AS job
             WHERE job.deck_id = ?
               AND job.status IN ('succeeded', 'partial', 'failed', 'superseded')
               AND job.finished_at IS NOT NULL AND job.finished_at <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM jobs AS child
                 WHERE child.deck_id = job.deck_id AND child.parent_job_id = job.job_id
               )
             ORDER BY job.finished_at ASC, job.job_id ASC LIMIT ?`,
            identity,
            options.cutoff,
            options.limit + 1,
          )
          .toArray();
        const selected = candidates.slice(0, options.limit);
        const jobs: { jobId: string; finishedAt: string }[] = [];
        for (const candidate of selected) {
          if (!options.dryRun) {
            this.ctx.storage.sql.exec(
              'DELETE FROM jobs WHERE deck_id = ? AND job_id = ?',
              identity,
              candidate.job_id,
            );
            this.ctx.storage.sql.exec(
              'INSERT INTO job_tombstones (deck_id, job_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
              identity,
              candidate.job_id,
            );
            this.enqueueUnusedInput(identity, candidate.input_key ?? undefined);
          }
          jobs.push({ jobId: candidate.job_id, finishedAt: candidate.finished_at });
        }
        const excluded = options.dryRun ? selected.map((candidate) => candidate.job_id) : [];
        const more = this.hasEligibleJobAfterCleanup(identity, options.cutoff, excluded);
        return { jobs, more };
      },
      !options.dryRun,
    );
    return toRpc(result);
  }

  async jobsCleanupClaim(optionsJson: string): Promise<string | null> {
    const options = fromRpc<{
      now: string;
      leaseUntil: string;
      leaseToken: string;
      deckId?: string;
    }>(optionsJson);
    const deckId = checkedDeckId(options.deckId);
    const now = checkedTime(options.now);
    const leaseUntil = checkedTime(options.leaseUntil);
    if (leaseUntil <= now || !isJobId(options.leaseToken)) {
      throw new Error('Automatic job cleanup lease is invalid');
    }
    const lease = await this.withDeck(
      deckId,
      async (transaction, identity) => {
        const row = this.ctx.storage.sql
          .exec<SqlRow<CleanupScheduleRow>>(
            `SELECT pending, last_started_at, lease_token, lease_until
             FROM job_cleanup_schedule WHERE id = 1`,
          )
          .toArray()[0];
        if (!row) return null;
        const previousLeaseUntil = row.lease_until === null ? null : checkedTime(row.lease_until);
        const liveLease = previousLeaseUntil !== null && previousLeaseUntil > now;
        const orphanedLease =
          row.lease_token !== null && previousLeaseUntil !== null && previousLeaseUntil <= now;
        if (liveLease || (row.pending !== 1 && !orphanedLease)) return null;
        const dailyDueAt =
          row.last_started_at === null
            ? now
            : checkedTime(row.last_started_at) + JOB_CLEANUP_INTERVAL_MS;
        const dueAt = Math.max(dailyDueAt, previousLeaseUntil ?? 0);
        if (now < dueAt) return null;
        const claimed = this.ctx.storage.sql.exec<SqlRow<{ id: number }>>(
          `UPDATE job_cleanup_schedule
           SET pending = 0, last_started_at = ?, lease_token = ?, lease_until = ?
           WHERE id = 1 RETURNING id`,
          options.now,
          options.leaseToken,
          options.leaseUntil,
        );
        if (claimed.toArray().length !== 1) {
          throw new Error('Automatic job cleanup claim lost its scheduler row');
        }
        await this.refreshAlarm(transaction, identity);
        return { deckId: identity, leaseToken: options.leaseToken, leaseUntil: options.leaseUntil };
      },
      false,
    );
    return lease === null ? null : toRpc(lease);
  }

  async jobsCleanupFinish(leaseJson: string, optionsJson: string): Promise<boolean> {
    const lease = fromRpc<JobCleanupLease>(leaseJson);
    const options = fromRpc<{ now: string; retry: boolean }>(optionsJson);
    const deckId = checkedDeckId(lease.deckId);
    const now = checkedTime(options.now);
    const leaseUntil = checkedTime(lease.leaseUntil);
    if (typeof options.retry !== 'boolean') throw new Error('Cleanup retry must be boolean');
    if (!isJobId(lease.leaseToken) || leaseUntil <= now) return false;
    return this.withDeck(
      deckId,
      async (transaction, identity) => {
        const finished = this.ctx.storage.sql.exec<SqlRow<{ id: number }>>(
          `UPDATE job_cleanup_schedule
         SET pending = CASE WHEN pending = 1 OR ? = 1 THEN 1 ELSE 0 END,
             lease_token = NULL, lease_until = NULL
         WHERE id = 1 AND lease_token = ? AND lease_until = ? AND lease_until > ?
         RETURNING id`,
          options.retry ? 1 : 0,
          lease.leaseToken,
          lease.leaseUntil,
          options.now,
        );
        if (finished.toArray().length !== 1) return false;
        await this.refreshAlarm(transaction, identity);
        return true;
      },
      false,
    );
  }

  async jobsListInputDeletes(optionsJson: string): Promise<string> {
    const options = fromRpc<{ deckId: string; limit: number }>(optionsJson);
    const deckId = checkedDeckId(options.deckId);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error('Pending input deletion limit must be from 1 to 100');
    }
    const result = await this.withDeck(
      deckId,
      (_transaction, identity) => {
        const pendingCount = this.ctx.storage.sql
          .exec<SqlRow<{ count: number }>>(
            'SELECT COUNT(*) AS count FROM job_input_outbox WHERE deck_id = ?',
            identity,
          )
          .one().count;
        const items = this.ctx.storage.sql
          .exec<SqlRow<InputDeleteRow>>(
            `SELECT job_id, input_key, token FROM job_input_outbox
             WHERE deck_id = ? ORDER BY created_at, input_key LIMIT ?`,
            identity,
            options.limit,
          )
          .toArray()
          .map((row) => ({
            deckId: identity,
            jobId: row.job_id,
            inputKey: row.input_key,
            token: row.token,
          }));
        return { items, pendingCount };
      },
      false,
    );
    return toRpc(result);
  }

  async jobsAcknowledgeInputDelete(itemJson: string): Promise<boolean> {
    const item = fromRpc<PendingJobInputDelete>(itemJson);
    const deckId = checkedDeckId(item.deckId);
    if (
      !isJobId(item.jobId) ||
      !isJobId(item.token) ||
      this.exactInputJobId(deckId, item.inputKey)?.toLowerCase() !== item.jobId.toLowerCase()
    )
      return false;
    return this.withDeck(deckId, () => {
      const result = this.ctx.storage.sql.exec<SqlRow<{ job_id: string }>>(
        `DELETE FROM job_input_outbox
         WHERE deck_id = ? AND job_id = ? AND input_key = ? AND token = ?
         RETURNING job_id`,
        deckId,
        item.jobId,
        item.inputKey,
        item.token,
      );
      return result.toArray().length === 1;
    });
  }

  async jobsList(optionsJson: string): Promise<string> {
    const options = fromRpc<{
      deckId: string;
      limit: number;
      cursor?: string;
    }>(optionsJson);
    const deckId = checkedDeckId(options.deckId);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error('Publication job list limit must be from 1 to 100');
    }
    const page = await this.withDeck(deckId, () => {
      const cursor = options.cursor === undefined ? null : readCursor(options.cursor, deckId);
      const rows = cursor
        ? this.records(
            `SELECT record_json FROM jobs
             WHERE deck_id = ? AND (created_at < ? OR (created_at = ? AND job_id < ?))
             ORDER BY created_at DESC, job_id DESC LIMIT ?`,
            deckId,
            cursor.createdAt,
            cursor.createdAt,
            cursor.jobId,
            options.limit + 1,
          )
        : this.records(
            `SELECT record_json FROM jobs WHERE deck_id = ?
             ORDER BY created_at DESC, job_id DESC LIMIT ?`,
            deckId,
            options.limit + 1,
          );
      const hasMore = rows.length > options.limit;
      const items = rows.slice(0, options.limit).map(clone);
      const last = items.at(-1)?.snapshot;
      return {
        items,
        ...(hasMore && last ? { nextCursor: makeCursor(deckId, last.createdAt, last.id) } : {}),
      };
    });
    return toRpc(page);
  }

  async jobsClaim(optionsJson: string): Promise<string | null> {
    const options = fromRpc<{
      now: string;
      leaseUntil: string;
      leaseToken: string;
      deckId?: string;
    }>(optionsJson);
    const nowMs = checkedTime(options.now);
    const leaseMs = checkedTime(options.leaseUntil);
    if (leaseMs <= nowMs || options.leaseToken.length === 0) {
      throw new Error('Publication job lease is invalid');
    }
    const record = await this.withDeck(options.deckId, async (transaction, deckId) => {
      const record = this.records(
        `SELECT record_json FROM jobs
         WHERE deck_id = ? AND (
           (status IN ('queued', 'retry_wait') AND next_run_at <= ?)
           OR (status = 'running' AND lease_until <= ?)
         )
         ORDER BY CASE WHEN status = 'running' THEN lease_until ELSE next_run_at END ASC,
                  created_at ASC, job_id ASC LIMIT 1`,
        deckId,
        options.now,
        options.now,
      )[0];
      if (!record) return null;

      record.snapshot.status = 'running';
      record.snapshot.version = nextVersion(record.snapshot.version);
      record.snapshot.updatedAt = options.now;
      if (!record.snapshot.startedAt) record.snapshot.startedAt = options.now;
      delete record.snapshot.nextRunAt;
      record.leaseToken = options.leaseToken;
      record.leaseUntil = options.leaseUntil;
      this.saveRecord(record);
      await this.refreshAlarm(transaction, deckId);
      return clone(record);
    });
    return record === null ? null : toRpc(record);
  }

  async jobsCheckpoint(leaseJson: string, updateJson: string): Promise<boolean> {
    const lease = fromRpc<JobLease>(leaseJson);
    const update = fromRpc<JobCheckpoint>(updateJson);
    const deckId = checkedDeckId(lease.deckId);
    checkedTime(lease.now);
    if (
      update.leaseUntil !== undefined &&
      checkedTime(update.leaseUntil) <= checkedTime(lease.now)
    ) {
      throw new Error('Publication job checkpoint lease expiry must be in the future');
    }
    return this.withDeck(deckId, async (transaction, identity) => {
      const record = this.loadRecord(identity, lease.jobId);
      if (!this.leaseMatches(record, lease)) return false;
      const current = record!;
      const snapshot = current.snapshot;
      snapshot.version = nextVersion(snapshot.version);
      snapshot.updatedAt = lease.now;
      if (update.phase !== undefined) snapshot.phase = update.phase;
      if (update.attempt !== undefined) snapshot.attempt = update.attempt;
      if (update.clearProgress) delete snapshot.progress;
      else if (update.progress !== undefined) snapshot.progress = clone(update.progress);
      if (update.stages !== undefined) snapshot.stages = clone(update.stages);
      if (update.preparedManifest !== undefined)
        current.preparedManifest = clone(update.preparedManifest);
      if (update.preparedCached !== undefined) current.preparedCached = update.preparedCached;
      if (update.leaseUntil !== undefined) current.leaseUntil = update.leaseUntil;
      this.saveRecord(current);
      await this.refreshAlarm(transaction, identity);
      return true;
    });
  }

  async jobsCommitPublication(
    leaseJson: string,
    manifestJson: string,
    resultJson: string,
    stagesJson: string,
  ): Promise<'published' | 'superseded' | 'lease_lost'> {
    const lease = fromRpc<JobLease>(leaseJson);
    const manifest = fromRpc<ReleaseManifest>(manifestJson);
    const result = fromRpc<JobResult>(resultJson);
    const stages = fromRpc<StageSnapshot[]>(stagesJson);
    const deckId = checkedDeckId(lease.deckId);
    checkedTime(lease.now);
    if (manifest.id !== deckId || manifest.revision !== result.revision) {
      throw new Error('Publication commit does not match its deck or result revision');
    }
    return this.withDeck(deckId, async (transaction, identity) => {
      const record = this.loadRecord(identity, lease.jobId);
      if (!this.leaseMatches(record, lease)) return 'lease_lost';
      const current = record!;
      if (current.snapshot.result) {
        return current.snapshot.result.revision === result.revision ? 'published' : 'superseded';
      }
      if (generationNumber(current.generation) !== this.currentGeneration()) return 'superseded';

      const currentJson = JSON.stringify(manifest);
      if (currentJson === undefined)
        throw new Error('Publication manifest is not JSON serializable');
      this.ctx.storage.sql.exec('UPDATE state SET current = ? WHERE id = 1', currentJson);
      current.snapshot.phase = 'thumbnail';
      current.snapshot.version = nextVersion(current.snapshot.version);
      current.snapshot.updatedAt = lease.now;
      current.snapshot.stages = clone(stages);
      current.snapshot.result = clone(result);
      delete current.snapshot.progress;
      this.saveRecord(current);
      await this.refreshAlarm(transaction, identity);
      return 'published';
    });
  }

  async jobsFinish(leaseJson: string, updateJson: string): Promise<boolean> {
    const lease = fromRpc<JobLease>(leaseJson);
    const update = fromRpc<JobFinish>(updateJson);
    const deckId = checkedDeckId(lease.deckId);
    checkedTime(lease.now);
    if (update.status === 'retry_wait') {
      if (
        update.nextRunAt === undefined ||
        checkedTime(update.nextRunAt) <= checkedTime(lease.now)
      ) {
        throw new Error('Retry wait must have a future next run time');
      }
    } else if (update.nextRunAt !== undefined) {
      throw new Error('Terminal publication job cannot retain a retry time');
    }
    return this.withDeck(deckId, async (transaction, identity) => {
      const record = this.loadRecord(identity, lease.jobId);
      if (!this.leaseMatches(record, lease)) return false;
      const current = record!;
      const snapshot = current.snapshot;
      snapshot.status = update.status;
      snapshot.version = nextVersion(snapshot.version);
      snapshot.updatedAt = lease.now;
      if (update.phase !== undefined) snapshot.phase = update.phase;
      snapshot.stages = clone(update.stages);
      if (update.result !== undefined) snapshot.result = clone(update.result);
      if (update.error !== undefined) snapshot.error = clone(update.error);
      else delete snapshot.error;
      delete snapshot.progress;
      if (update.status === 'retry_wait') {
        snapshot.nextRunAt = update.nextRunAt!;
        delete snapshot.finishedAt;
      } else {
        delete snapshot.nextRunAt;
        snapshot.finishedAt = lease.now;
      }
      delete current.leaseToken;
      delete current.leaseUntil;
      this.saveRecord(current);
      if (current.snapshot.kind === 'publication' && terminal(update.status)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO job_cleanup_schedule (id, pending)
           VALUES (1, 1)
           ON CONFLICT (id) DO UPDATE SET pending = 1`,
        );
      }
      await this.refreshAlarm(transaction, identity);
      return true;
    });
  }

  async jobsRetry(
    parentJson: string,
    stage: 'all' | 'thumbnail',
    jobJson: string,
  ): Promise<string> {
    const parent = fromRpc<JobIdentity>(parentJson);
    const job = fromRpc<NewPublicationJob>(jobJson);
    const deckId = checkedDeckId(parent.deckId);
    if (job.snapshot.deckId !== deckId || job.snapshot.parentJobId !== parent.jobId) {
      throw new Error('Retry job identity does not match its parent');
    }
    const result = await this.withDeck(deckId, async (transaction, identity) => {
      if (this.isExpired(identity, parent.jobId) || this.isExpired(identity, job.snapshot.id)) {
        if (this.enqueueUnusedInput(identity, job.inputKey, undefined, true)) {
          await this.refreshAlarm(transaction, identity);
        }
        return { outcome: 'expired' };
      }
      const existing = this.loadRecord(identity, job.snapshot.id);
      const replay = admissionIdempotency(existing, job.requestHash);
      if (replay) return replay;

      const parentRecord = this.loadRecord(identity, parent.jobId);
      if (!parentRecord) return { outcome: 'not_found' };
      if (parentRecord.snapshot.deckId !== deckId || !terminal(parentRecord.snapshot.status)) {
        return { outcome: 'invalid_retry' };
      }

      const expectedKind = stage === 'thumbnail' ? 'thumbnail' : 'publication';
      const activeChild = this.ctx.storage.sql
        .exec<SqlRow<{ job_id: string }>>(
          `SELECT job_id FROM jobs
           WHERE deck_id = ? AND parent_job_id = ? AND kind = ?
             AND status IN ('queued', 'running', 'retry_wait') LIMIT 1`,
          deckId,
          parent.jobId,
          expectedKind,
        )
        .toArray()[0];
      if (activeChild) return { outcome: 'active_retry' };

      if (stage === 'thumbnail') {
        const result = parentRecord.snapshot.result;
        if (
          !result ||
          result.thumbnail === 'ready' ||
          job.snapshot.kind !== 'thumbnail' ||
          job.targetRevision !== result.revision
        ) {
          return { outcome: 'invalid_retry' };
        }
      } else if (
        parentRecord.snapshot.status !== 'failed' ||
        parentRecord.snapshot.result !== undefined ||
        !parentRecord.generation ||
        generationNumber(parentRecord.generation) !== this.currentGeneration() ||
        job.snapshot.kind !== 'publication' ||
        job.inputKey !== parentRecord.inputKey ||
        job.inputHash !== parentRecord.inputHash
      ) {
        return generationNumber(parentRecord.generation) !== this.currentGeneration()
          ? { outcome: 'superseded' }
          : { outcome: 'invalid_retry' };
      }

      const active = this.ctx.storage.sql
        .exec<SqlRow<{ count: number }>>(
          `SELECT COUNT(*) AS count FROM jobs
           WHERE deck_id = ? AND status IN ('queued', 'running', 'retry_wait')`,
          deckId,
        )
        .one().count;
      if (active >= MAX_ACTIVE_JOBS) return { outcome: 'limit' };

      const record: PublicationJobRecord = {
        ...clone(job),
        ...(stage === 'thumbnail'
          ? { generation: parentRecord.generation }
          : { generation: String(this.incrementGeneration()) }),
        snapshot: clone(job.snapshot),
      };
      if (stage === 'all') this.supersedeUnpublished(identity, job.snapshot.createdAt);
      this.saveRecord(record);
      await this.refreshAlarm(transaction, identity);
      return { outcome: 'accepted', job: clone(record) };
    });
    return toRpc(result);
  }

  async alarm(): Promise<void> {
    const deckId = this.identityValue();
    if (!deckId) return;
    const now = Date.now();
    // Keep a durable lease-recovery wake before any compiler, storage, or renderer I/O.
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.setAlarm(now + JOB_LEASE_MS);
    });

    const store: PublicationJobStore = createDeckBoundDurableObjectPublicationJobStore(
      this,
      deckId,
    );
    const server = createCloudflareOptions(this.env);
    await runPublicationJob(
      {
        ...server,
        jobs: store,
        publications: store.publications,
      },
      { deckId },
    );
    await runPublicationJobCleanup(
      {
        ...server,
        jobs: store,
        publications: store.publications,
      },
      { deckId },
    );

    await this.ctx.storage.transaction(async (transaction) => {
      await this.refreshAlarm(transaction, deckId);
    });
  }
}
