import { randomUUID } from 'node:crypto';
import type {
  AutomaticJobCleanupStore,
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
} from '@slidock/server';
import { isJobId } from '@slidock/protocol';
import { isDeckId } from '@slidock/server/catalog';
import type {
  JobError,
  JobPhase,
  JobProgress,
  JobResult,
  JobSnapshot,
  JobStatus,
  StageSnapshot,
} from '@slidock/protocol';
import type { ReleaseManifest } from '@slidock/server';
import { JOB_CLEANUP_INTERVAL_MS } from '@slidock/server';
import type { Pool, PoolClient } from 'pg';

export const POSTGRES_PUBLICATION_JOBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_publication_jobs (
  deck_id text NOT NULL,
  job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('publication', 'thumbnail')),
  parent_job_id uuid,
  request_hash text NOT NULL,
  input_key text,
  input_hash text,
  target_revision text,
  generation bigint CHECK (generation IS NULL OR generation >= 1),
  runtime_id text,
  profile_digest text NOT NULL,
  compiler_contract_version text NOT NULL,
  thumbnail_mode text NOT NULL CHECK (thumbnail_mode IN ('auto', 'none')),
  view_token_hash text NOT NULL,
  view_expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'partial', 'failed', 'superseded')),
  phase text NOT NULL CHECK (phase IN ('runtime', 'compile', 'store', 'publish', 'thumbnail')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_run_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  progress jsonb,
  stages jsonb NOT NULL,
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  prepared_manifest jsonb,
  prepared_cached boolean,
  CONSTRAINT pk_hub_publication_jobs PRIMARY KEY (deck_id, job_id),
  CONSTRAINT fk_hub_publication_jobs_deck FOREIGN KEY (deck_id)
    REFERENCES hub_publications (deck_id) ON DELETE RESTRICT,
  CONSTRAINT fk_hub_publication_jobs_parent FOREIGN KEY (deck_id, parent_job_id)
    REFERENCES hub_publication_jobs (deck_id, job_id) ON DELETE RESTRICT,
  CONSTRAINT chk_hub_publication_jobs_lease
    CHECK ((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_hub_publication_jobs_ready
  ON hub_publication_jobs (status, next_run_at, lease_until, created_at, job_id);

CREATE INDEX IF NOT EXISTS idx_hub_publication_jobs_deck_history
  ON hub_publication_jobs (deck_id, created_at DESC, job_id DESC);

CREATE INDEX IF NOT EXISTS idx_hub_publication_jobs_parent
  ON hub_publication_jobs (deck_id, parent_job_id) WHERE parent_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hub_publication_jobs_input_key
  ON hub_publication_jobs (deck_id, input_key) WHERE input_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_publication_jobs_active_child
  ON hub_publication_jobs (deck_id, parent_job_id, kind)
  WHERE parent_job_id IS NOT NULL AND status IN ('queued', 'running', 'retry_wait');

CREATE TABLE IF NOT EXISTS hub_publication_job_tombstones (
  deck_id text NOT NULL,
  job_id uuid NOT NULL,
  PRIMARY KEY (deck_id, job_id),
  FOREIGN KEY (deck_id) REFERENCES hub_publications (deck_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS hub_publication_job_input_outbox (
  deck_id text NOT NULL,
  job_id uuid NOT NULL,
  input_key text NOT NULL,
  token uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (deck_id, input_key),
  FOREIGN KEY (deck_id) REFERENCES hub_publications (deck_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_hub_publication_job_input_outbox_order
  ON hub_publication_job_input_outbox (deck_id, created_at, input_key);
`;

export const POSTGRES_PUBLICATION_JOB_CLEANUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_publication_job_cleanup (
  deck_id text PRIMARY KEY,
  pending boolean NOT NULL DEFAULT false,
  last_started_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  CONSTRAINT fk_hub_publication_job_cleanup_deck FOREIGN KEY (deck_id)
    REFERENCES hub_publications (deck_id) ON DELETE RESTRICT,
  CONSTRAINT chk_hub_publication_job_cleanup_lease
    CHECK ((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_hub_publication_job_cleanup_due
  ON hub_publication_job_cleanup (last_started_at, lease_until, deck_id)
  WHERE pending OR lease_token IS NOT NULL;
`;

const ACTIVE_STATUSES = ['queued', 'running', 'retry_wait'] as const;
const TERMINAL_STATUSES = new Set<JobStatus>(['succeeded', 'partial', 'failed', 'superseded']);
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

type JobRow = {
  deck_id: string;
  job_id: string;
  kind: 'publication' | 'thumbnail';
  parent_job_id: string | null;
  request_hash: string;
  input_key: string | null;
  input_hash: string | null;
  target_revision: string | null;
  generation: string | null;
  runtime_id: string | null;
  profile_digest: string;
  compiler_contract_version: string;
  thumbnail_mode: 'auto' | 'none';
  view_token_hash: string;
  view_expires_at: Date | string;
  status: JobStatus;
  phase: JobPhase;
  version: string;
  attempt: number;
  next_run_at: Date | string | null;
  lease_token: string | null;
  lease_until: Date | string | null;
  progress: JobProgress | null;
  stages: StageSnapshot[];
  result: JobResult | null;
  error: JobError | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  prepared_manifest: ReleaseManifest | null;
  prepared_cached: boolean | null;
};

type PendingInputDeleteRow = {
  deck_id: string;
  job_id: string;
  input_key: string;
  token: string;
};

function validIso(value: string): boolean {
  return ISO_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function requireIso(value: string, name: string): number {
  if (!validIso(value)) throw new TypeError(`${name} must be a valid ISO timestamp`);
  return Date.parse(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toOptionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : toIso(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function asJson(value: unknown): string | null {
  return value === undefined ? null : (JSON.stringify(value) ?? null);
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error('PostgreSQL job version is outside the safe integer range');
  return version;
}

function mapRecord(row: JobRow): PublicationJobRecord {
  const snapshot: JobSnapshot = {
    id: row.job_id,
    deckId: row.deck_id,
    kind: row.kind,
    status: row.status,
    phase: row.phase,
    version: safeVersion(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    attempt: row.attempt,
    stages: clone(row.stages ?? []),
  };
  if (row.parent_job_id !== null) snapshot.parentJobId = row.parent_job_id;
  const startedAt = toOptionalIso(row.started_at);
  const finishedAt = toOptionalIso(row.finished_at);
  const nextRunAt = toOptionalIso(row.next_run_at);
  if (startedAt !== undefined) snapshot.startedAt = startedAt;
  if (finishedAt !== undefined) snapshot.finishedAt = finishedAt;
  if (nextRunAt !== undefined) snapshot.nextRunAt = nextRunAt;
  if (row.progress !== null) snapshot.progress = clone(row.progress);
  if (row.result !== null) snapshot.result = clone(row.result);
  if (row.error !== null) snapshot.error = clone(row.error);

  const record: PublicationJobRecord = {
    snapshot,
    requestHash: row.request_hash,
    profileDigest: row.profile_digest,
    compilerContractVersion: row.compiler_contract_version,
    thumbnail: row.thumbnail_mode,
    viewTokenHash: row.view_token_hash,
    viewExpiresAt: toIso(row.view_expires_at),
  };
  if (row.input_key !== null) record.inputKey = row.input_key;
  if (row.input_hash !== null) record.inputHash = row.input_hash;
  if (row.generation !== null) record.generation = row.generation;
  if (row.runtime_id !== null) record.runtimeId = row.runtime_id;
  if (row.target_revision !== null) record.targetRevision = row.target_revision;
  if (row.lease_token !== null) record.leaseToken = row.lease_token;
  const leaseUntil = toOptionalIso(row.lease_until);
  if (leaseUntil !== undefined) record.leaseUntil = leaseUntil;
  if (row.prepared_manifest !== null) record.preparedManifest = clone(row.prepared_manifest);
  if (row.prepared_cached !== null) record.preparedCached = row.prepared_cached;
  return record;
}

function validUuid(value: string): boolean {
  return isJobId(value);
}

function exactInputJobId(deckId: string, inputKey: string): string | null {
  if (!isDeckId(deckId)) return null;
  const prefix = `private/jobs/${deckId}/`;
  if (!inputKey.startsWith(prefix)) return null;
  const jobId = inputKey.slice(prefix.length, -'.json'.length);
  return inputKey === `${prefix}${jobId}.json` && isJobId(jobId) ? jobId : null;
}

async function enqueueUnusedInput(
  client: PoolClient,
  deckId: string,
  inputKey: string | undefined,
  expectedJobId?: string,
  wakeAutomaticCleanup = false,
): Promise<void> {
  if (inputKey === undefined) return;
  const jobId = exactInputJobId(deckId, inputKey);
  if (
    !jobId ||
    (expectedJobId !== undefined && jobId.toLowerCase() !== expectedJobId.toLowerCase())
  )
    return;
  const referenced = await client.query(
    'SELECT 1 FROM hub_publication_jobs WHERE deck_id = $1 AND input_key = $2 LIMIT 1',
    [deckId, inputKey],
  );
  if (referenced.rowCount) return;
  await client.query(
    `INSERT INTO hub_publication_job_input_outbox (deck_id, job_id, input_key, token)
     VALUES ($1, $2::uuid, $3, $4::uuid)
     ON CONFLICT (deck_id, input_key) DO UPDATE
       SET job_id = EXCLUDED.job_id, token = EXCLUDED.token, created_at = CURRENT_TIMESTAMP`,
    [deckId, jobId, inputKey, randomUUID()],
  );
  if (wakeAutomaticCleanup) {
    await client.query(
      `INSERT INTO hub_publication_job_cleanup (deck_id, pending)
       VALUES ($1, TRUE)
       ON CONFLICT (deck_id) DO UPDATE SET pending = TRUE`,
      [deckId],
    );
  }
}

function cursorBytes(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
}

function encodeCursor(deckId: string, snapshot: JobSnapshot): string {
  return btoa(
    cursorBytes(JSON.stringify({ deckId, createdAt: snapshot.createdAt, id: snapshot.id })),
  )
    .replace(/=/gu, '')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_');
}

function decodeCursor(cursor: string, deckId: string): { createdAt: string; id: string } {
  try {
    const base64 = cursor.replace(/-/gu, '+').replace(/_/gu, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
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
      typeof value.id !== 'string' ||
      !validUuid(value.id)
    )
      throw new TypeError('invalid cursor');
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new TypeError('Invalid job cursor');
  }
}

function isActive(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status as (typeof ACTIVE_STATUSES)[number]);
}

function baseRecord(job: NewPublicationJob): PublicationJobRecord {
  const record = clone(job);
  record.snapshot.status = 'queued';
  record.snapshot.version = Math.max(1, record.snapshot.version);
  if (record.snapshot.attempt < 0) record.snapshot.attempt = 0;
  delete record.snapshot.finishedAt;
  delete record.snapshot.nextRunAt;
  return record;
}

function jobValues(record: PublicationJobRecord): unknown[] {
  const snapshot = record.snapshot;
  return [
    snapshot.deckId,
    snapshot.id,
    snapshot.kind,
    snapshot.parentJobId ?? null,
    record.requestHash,
    record.inputKey ?? null,
    record.inputHash ?? null,
    record.targetRevision ?? null,
    record.generation ?? null,
    record.runtimeId ?? null,
    record.profileDigest,
    record.compilerContractVersion,
    record.thumbnail,
    record.viewTokenHash,
    record.viewExpiresAt,
    snapshot.status,
    snapshot.phase,
    snapshot.version,
    snapshot.attempt,
    snapshot.nextRunAt ?? null,
    record.leaseToken ?? null,
    record.leaseUntil ?? null,
    asJson(snapshot.progress),
    asJson(snapshot.stages),
    asJson(snapshot.result),
    asJson(snapshot.error),
    snapshot.createdAt,
    snapshot.updatedAt,
    snapshot.startedAt ?? null,
    snapshot.finishedAt ?? null,
    asJson(record.preparedManifest),
    record.preparedCached ?? null,
  ];
}

async function insertRecord(
  client: PoolClient,
  record: PublicationJobRecord,
): Promise<PublicationJobRecord> {
  const result = await client.query<JobRow>(
    `INSERT INTO hub_publication_jobs (
       deck_id, job_id, kind, parent_job_id, request_hash, input_key, input_hash,
       target_revision, generation, runtime_id, profile_digest, compiler_contract_version, thumbnail_mode,
       view_token_hash, view_expires_at, status, phase, version, attempt, next_run_at,
       lease_token, lease_until, progress, stages, result, error, created_at, updated_at,
       started_at, finished_at, prepared_manifest, prepared_cached
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,
       $16,$17,$18,$19,$20::timestamptz,$21::uuid,$22::timestamptz,
       $23::jsonb,$24::jsonb,$25::jsonb,$26::jsonb,$27::timestamptz,$28::timestamptz,
       $29::timestamptz,$30::timestamptz,$31::jsonb,$32
     ) RETURNING *`,
    jobValues(record),
  );
  const row = result.rows[0];
  if (!row) throw new Error('PostgreSQL job insert returned no row');
  return mapRecord(row);
}

async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* The original transaction error is more useful. */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function lockDeck(client: PoolClient, deckId: string): Promise<string> {
  await client.query(
    `INSERT INTO hub_publications (deck_id, generation, current_manifest)
     VALUES ($1, 0, NULL) ON CONFLICT (deck_id) DO NOTHING`,
    [deckId],
  );
  const result = await client.query<{ generation: string }>(
    'SELECT generation::text AS generation FROM hub_publications WHERE deck_id = $1 FOR UPDATE',
    [deckId],
  );
  const generation = result.rows[0]?.generation;
  if (generation === undefined) throw new Error('PostgreSQL deck lock returned no generation');
  return generation;
}

async function allocateGeneration(client: PoolClient, deckId: string): Promise<string> {
  const result = await client.query<{ generation: string }>(
    `UPDATE hub_publications SET generation = generation + 1
     WHERE deck_id = $1 RETURNING generation::text AS generation`,
    [deckId],
  );
  const generation = result.rows[0]?.generation;
  if (generation === undefined)
    throw new Error('PostgreSQL generation allocation returned no value');
  return generation;
}

async function dbNow(client: PoolClient): Promise<string> {
  const result = await client.query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now');
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new Error('PostgreSQL did not return a transaction timestamp');
  return now.toISOString();
}

async function supersedeUnpublished(
  client: PoolClient,
  deckId: string,
  generation: string,
  now: string,
): Promise<void> {
  await client.query(
    `UPDATE hub_publication_jobs
     SET status = 'superseded', version = version + 1,
         updated_at = GREATEST(updated_at, $3::timestamptz),
         finished_at = GREATEST(updated_at, $3::timestamptz),
         next_run_at = NULL, lease_token = NULL, lease_until = NULL,
         progress = NULL, error = NULL,
         stages = COALESCE((
           SELECT jsonb_agg(
             CASE WHEN stage.value->>'status' IN ('pending', 'running')
               THEN stage.value || jsonb_build_object(
                 'status', 'skipped',
                 'finishedAt', to_char(
                   GREATEST(hub_publication_jobs.updated_at, $3::timestamptz) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 )
               )
               ELSE stage.value
             END ORDER BY stage.ordinality
           )
           FROM jsonb_array_elements(hub_publication_jobs.stages) WITH ORDINALITY AS stage(value, ordinality)
         ), '[]'::jsonb)
     WHERE deck_id = $1 AND generation IS NOT NULL AND generation < $2::bigint
       AND status IN ('queued', 'running', 'retry_wait') AND result IS NULL`,
    [deckId, generation, now],
  );
}

async function readRecord(
  client: PoolClient,
  identity: JobIdentity,
  lock = false,
): Promise<PublicationJobRecord | null> {
  const result = await client.query<JobRow>(
    `SELECT * FROM hub_publication_jobs WHERE deck_id = $1 AND job_id = $2::uuid${lock ? ' FOR UPDATE' : ''}`,
    [identity.deckId, identity.jobId],
  );
  const row = result.rows[0];
  return row ? mapRecord(row) : null;
}

function admissionFromExisting(
  record: PublicationJobRecord,
  requestHash: string,
): JobAdmissionResult {
  return record.requestHash === requestHash
    ? { outcome: 'replayed', job: clone(record) }
    : { outcome: 'conflict' };
}

async function countActive(client: PoolClient, deckId: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(*)::integer AS count FROM hub_publication_jobs
     WHERE deck_id = $1 AND status IN ('queued', 'running', 'retry_wait')`,
    [deckId],
  );
  return result.rows[0]?.count ?? 0;
}

function leaseMatches(record: PublicationJobRecord, lease: JobLease): boolean {
  return (
    record.snapshot.status === 'running' &&
    record.leaseToken === lease.leaseToken &&
    record.leaseUntil !== undefined &&
    Date.parse(record.leaseUntil) > Date.parse(lease.now)
  );
}

export function createPostgresPublicationJobStore(options: { pool: Pool }): PublicationJobStore {
  const { pool } = options;
  const automatic: AutomaticJobCleanupStore = {
    async claim(options): Promise<JobCleanupLease | null> {
      const now = requireIso(options.now, 'now');
      const leaseUntil = requireIso(options.leaseUntil, 'leaseUntil');
      if (leaseUntil <= now) throw new RangeError('leaseUntil must be later than now');
      if (!validUuid(options.leaseToken)) throw new TypeError('leaseToken must be a UUID');
      if (options.deckId !== undefined && !isDeckId(options.deckId))
        throw new TypeError('deckId must be a valid deck id');
      return withTransaction(pool, async (client) => {
        const due = await client.query<{
          deck_id: string;
        }>(
          `SELECT deck_id
           FROM hub_publication_job_cleanup
           WHERE (pending OR lease_token IS NOT NULL)
             AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
             AND (last_started_at IS NULL OR last_started_at <=
               $1::timestamptz - ($3::double precision * INTERVAL '1 millisecond'))
             AND ($2::text IS NULL OR deck_id = $2)
           ORDER BY GREATEST(
             COALESCE(last_started_at + ($3::double precision * INTERVAL '1 millisecond'), '-infinity'::timestamptz),
             COALESCE(lease_until, '-infinity'::timestamptz)
           ), deck_id
           LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [options.now, options.deckId ?? null, JOB_CLEANUP_INTERVAL_MS],
        );
        const deckId = due.rows[0]?.deck_id;
        if (deckId === undefined) return null;
        const claimed = await client.query(
          `UPDATE hub_publication_job_cleanup
           SET pending = false, last_started_at = $2::timestamptz,
               lease_token = $3::uuid, lease_until = $4::timestamptz
           WHERE deck_id = $1`,
          [deckId, options.now, options.leaseToken, options.leaseUntil],
        );
        if (claimed.rowCount !== 1)
          throw new Error('PostgreSQL cleanup claim lost its locked scheduler row');
        return { deckId, leaseToken: options.leaseToken, leaseUntil: options.leaseUntil };
      });
    },

    async finish(lease, options): Promise<boolean> {
      const now = requireIso(options.now, 'now');
      const leaseUntil = requireIso(lease.leaseUntil, 'leaseUntil');
      if (typeof options.retry !== 'boolean') throw new TypeError('retry must be a boolean');
      if (!isDeckId(lease.deckId) || !validUuid(lease.leaseToken)) return false;
      if (leaseUntil <= now) return false;
      const result = await pool.query(
        `UPDATE hub_publication_job_cleanup
         SET pending = pending OR $4::boolean, lease_token = NULL, lease_until = NULL
         WHERE deck_id = $1 AND lease_token = $2::uuid
           AND lease_until = $3::timestamptz AND lease_until > $5::timestamptz`,
        [lease.deckId, lease.leaseToken, lease.leaseUntil, options.retry, options.now],
      );
      return result.rowCount === 1;
    },
  };
  const publications = {
    async begin(deckId: string): Promise<string> {
      return withTransaction(pool, async (client) => {
        await lockDeck(client, deckId);
        const generation = await allocateGeneration(client, deckId);
        const now = await dbNow(client);
        await supersedeUnpublished(client, deckId, generation, now);
        return generation;
      });
    },
    async current(deckId: string): Promise<unknown | null> {
      const result = await pool.query<{ current_manifest: unknown | null }>(
        'SELECT current_manifest FROM hub_publications WHERE deck_id = $1',
        [deckId],
      );
      return result.rows[0]?.current_manifest ?? null;
    },
    async commit(deckId: string, token: string, manifest: unknown): Promise<boolean> {
      if (!/^(0|[1-9]\d*)$/u.test(token)) return false;
      try {
        if (BigInt(token) > 9_223_372_036_854_775_807n) return false;
      } catch {
        return false;
      }
      const result = await pool.query(
        `UPDATE hub_publications SET current_manifest = $3::jsonb
         WHERE deck_id = $1 AND generation = $2::bigint`,
        [deckId, token, JSON.stringify(manifest)],
      );
      return result.rowCount === 1;
    },
  };

  const maintenance = {
    automatic,
    async isExpired(identity: JobIdentity): Promise<boolean> {
      if (!isJobId(identity.jobId)) return false;
      const result = await pool.query(
        'SELECT 1 FROM hub_publication_job_tombstones WHERE deck_id = $1 AND job_id = $2::uuid',
        [identity.deckId, identity.jobId],
      );
      return result.rowCount === 1;
    },
    async cleanup(options: {
      deckId: string;
      cutoff: string;
      limit: number;
      dryRun: boolean;
    }): Promise<{ jobs: { jobId: string; finishedAt: string }[]; more: boolean }> {
      requireIso(options.cutoff, 'cutoff');
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
        throw new RangeError('Job cleanup limit must be between 1 and 100');
      return withTransaction(pool, async (client) => {
        if (options.dryRun) {
          await client.query(
            'SELECT generation FROM hub_publications WHERE deck_id = $1 FOR UPDATE',
            [options.deckId],
          );
        } else {
          await lockDeck(client, options.deckId);
        }
        const candidates = await client.query<{
          job_id: string;
          input_key: string | null;
          finished_at: Date | string;
        }>(
          `SELECT job.job_id::text AS job_id, job.input_key, job.finished_at
           FROM hub_publication_jobs AS job
           WHERE job.deck_id = $1
             AND job.status IN ('succeeded', 'partial', 'failed', 'superseded')
             AND job.finished_at <= $2::timestamptz
             AND NOT EXISTS (
               SELECT 1 FROM hub_publication_jobs AS child
               WHERE child.deck_id = job.deck_id AND child.parent_job_id = job.job_id
             )
           ORDER BY job.finished_at ASC, job.job_id ASC
           LIMIT $3 FOR UPDATE OF job`,
          [options.deckId, options.cutoff, options.limit + 1],
        );
        const selected = candidates.rows.slice(0, options.limit);
        const jobs: { jobId: string; finishedAt: string }[] = [];
        if (!options.dryRun) {
          for (const candidate of selected) {
            const deleted = await client.query(
              'DELETE FROM hub_publication_jobs WHERE deck_id = $1 AND job_id = $2::uuid',
              [options.deckId, candidate.job_id],
            );
            if (deleted.rowCount !== 1) continue;
            await client.query(
              `INSERT INTO hub_publication_job_tombstones (deck_id, job_id)
               VALUES ($1, $2::uuid) ON CONFLICT DO NOTHING`,
              [options.deckId, candidate.job_id],
            );
            await enqueueUnusedInput(client, options.deckId, candidate.input_key ?? undefined);
            jobs.push({ jobId: candidate.job_id, finishedAt: toIso(candidate.finished_at) });
          }
        } else {
          jobs.push(
            ...selected.map((candidate) => ({
              jobId: candidate.job_id,
              finishedAt: toIso(candidate.finished_at),
            })),
          );
        }
        const excluded = options.dryRun ? selected.map((candidate) => candidate.job_id) : [];
        const moreResult = await client.query<{ more: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM hub_publication_jobs AS job
             WHERE job.deck_id = $1
               AND job.status IN ('succeeded', 'partial', 'failed', 'superseded')
               AND job.finished_at <= $2::timestamptz
               AND NOT (job.job_id = ANY($3::uuid[]))
               AND NOT EXISTS (
                 SELECT 1 FROM hub_publication_jobs AS child
                 WHERE child.deck_id = job.deck_id AND child.parent_job_id = job.job_id
                   AND NOT (child.job_id = ANY($3::uuid[]))
               )
           ) AS more`,
          [options.deckId, options.cutoff, excluded],
        );
        const more = moreResult.rows[0]?.more ?? false;
        return { jobs, more };
      });
    },
    async listPendingInputDeletes(options: { deckId: string; limit: number }): Promise<{
      items: PendingJobInputDelete[];
      pendingCount: number;
    }> {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
        throw new RangeError('Pending input deletion limit must be between 1 and 100');
      const [count, rows] = await Promise.all([
        pool.query<{ count: number }>(
          'SELECT COUNT(*)::integer AS count FROM hub_publication_job_input_outbox WHERE deck_id = $1',
          [options.deckId],
        ),
        pool.query<PendingInputDeleteRow>(
          `SELECT deck_id, job_id::text AS job_id, input_key, token::text AS token
           FROM hub_publication_job_input_outbox WHERE deck_id = $1
           ORDER BY created_at, input_key LIMIT $2`,
          [options.deckId, options.limit],
        ),
      ]);
      return {
        items: rows.rows.map((row) => ({
          deckId: row.deck_id,
          jobId: row.job_id,
          inputKey: row.input_key,
          token: row.token,
        })),
        pendingCount: count.rows[0]?.count ?? 0,
      };
    },
    async acknowledgeInputDelete(item: PendingJobInputDelete): Promise<boolean> {
      if (
        !validUuid(item.token) ||
        exactInputJobId(item.deckId, item.inputKey)?.toLowerCase() !== item.jobId.toLowerCase()
      )
        return false;
      const result = await pool.query(
        `DELETE FROM hub_publication_job_input_outbox
         WHERE deck_id = $1 AND job_id = $2::uuid AND input_key = $3 AND token = $4::uuid`,
        [item.deckId, item.jobId, item.inputKey, item.token],
      );
      return result.rowCount === 1;
    },
  };

  return {
    publications,
    maintenance,

    async submit(job): Promise<JobAdmissionResult> {
      return withTransaction(pool, async (client) => {
        const currentGeneration = await lockDeck(client, job.snapshot.deckId);
        const expired = await client.query(
          `SELECT 1 FROM hub_publication_job_tombstones
           WHERE deck_id = $1 AND job_id = $2::uuid`,
          [job.snapshot.deckId, job.snapshot.id],
        );
        if (expired.rowCount) {
          await enqueueUnusedInput(
            client,
            job.snapshot.deckId,
            job.inputKey,
            job.snapshot.id,
            true,
          );
          return { outcome: 'expired' };
        }
        const existing = await readRecord(client, {
          deckId: job.snapshot.deckId,
          jobId: job.snapshot.id,
        });
        if (existing) return admissionFromExisting(existing, job.requestHash);
        if ((await countActive(client, job.snapshot.deckId)) >= 10) return { outcome: 'limit' };

        const generation = await allocateGeneration(client, job.snapshot.deckId);
        const now = await dbNow(client);
        await supersedeUnpublished(client, job.snapshot.deckId, generation, now);
        const record = baseRecord(job);
        record.generation = generation;
        // lockDeck serializes admissions; this also guards an unexpected external generation writer.
        if (BigInt(currentGeneration) + 1n !== BigInt(generation)) {
          throw new Error('PostgreSQL publication generation changed outside the paired store');
        }
        return { outcome: 'accepted', job: await insertRecord(client, record) };
      });
    },

    async get(identity): Promise<PublicationJobRecord | null> {
      const result = await pool.query<JobRow>(
        'SELECT * FROM hub_publication_jobs WHERE deck_id = $1 AND job_id = $2::uuid',
        [identity.deckId, identity.jobId],
      );
      const row = result.rows[0];
      return row ? mapRecord(row) : null;
    },

    async list(options): Promise<{ items: PublicationJobRecord[]; nextCursor?: string }> {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
        throw new RangeError('Job list limit must be between 1 and 100');
      }
      const cursor =
        options.cursor === undefined ? undefined : decodeCursor(options.cursor, options.deckId);
      const result = await pool.query<JobRow>(
        `SELECT * FROM hub_publication_jobs
         WHERE deck_id = $1 AND (
           $2::timestamptz IS NULL OR created_at < $2::timestamptz OR
           (created_at = $2::timestamptz AND job_id < $3::uuid)
         )
         ORDER BY created_at DESC, job_id DESC LIMIT $4`,
        [options.deckId, cursor?.createdAt ?? null, cursor?.id ?? null, options.limit + 1],
      );
      const hasMore = result.rows.length > options.limit;
      const rows = result.rows.slice(0, options.limit);
      const items = rows.map(mapRecord);
      return {
        items,
        ...(hasMore && items.length > 0
          ? { nextCursor: encodeCursor(options.deckId, items[items.length - 1]!.snapshot) }
          : {}),
      };
    },

    async claim(options): Promise<PublicationJobRecord | null> {
      const nowMs = requireIso(options.now, 'now');
      const leaseUntilMs = requireIso(options.leaseUntil, 'leaseUntil');
      if (leaseUntilMs <= nowMs) throw new RangeError('leaseUntil must be later than now');
      if (!validUuid(options.leaseToken)) throw new TypeError('leaseToken must be a UUID');
      return withTransaction(pool, async (client) => {
        const result = await client.query<JobRow>(
          `SELECT * FROM hub_publication_jobs
           WHERE (
             status = 'queued' OR
             (status = 'retry_wait' AND next_run_at <= $1::timestamptz) OR
             (status = 'running' AND lease_until <= $1::timestamptz)
           ) AND ($2::text IS NULL OR deck_id = $2)
           ORDER BY COALESCE(next_run_at, created_at), created_at, job_id
           LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [options.now, options.deckId ?? null],
        );
        const row = result.rows[0];
        if (!row) return null;
        const record = mapRecord(row);
        const updated = await client.query<JobRow>(
          `UPDATE hub_publication_jobs
           SET status = 'running', version = version + 1,
               next_run_at = NULL, lease_token = $3::uuid, lease_until = $4::timestamptz,
               started_at = COALESCE(started_at, $5::timestamptz),
               finished_at = NULL,
               updated_at = GREATEST(updated_at, $5::timestamptz)
           WHERE deck_id = $1 AND job_id = $2::uuid
           RETURNING *`,
          [
            record.snapshot.deckId,
            record.snapshot.id,
            options.leaseToken,
            options.leaseUntil,
            options.now,
          ],
        );
        const claimed = updated.rows[0];
        if (!claimed) throw new Error('PostgreSQL claim lost its locked job row');
        return mapRecord(claimed);
      });
    },

    async checkpoint(lease, update: JobCheckpoint): Promise<boolean> {
      requireIso(lease.now, 'now');
      if (!validUuid(lease.leaseToken)) return false;
      if (update.leaseUntil !== undefined) {
        const until = requireIso(update.leaseUntil, 'leaseUntil');
        if (until <= Date.parse(lease.now)) return false;
      }
      const values: unknown[] = [lease.deckId, lease.jobId, lease.leaseToken, lease.now];
      const assignments = [
        'version = version + 1',
        'updated_at = GREATEST(updated_at, $4::timestamptz)',
      ];
      const add = (expression: string, value: unknown): void => {
        values.push(value);
        assignments.push(expression.replace('?', `$${values.length}`));
      };
      if (update.phase !== undefined) add('phase = ?', update.phase);
      if (update.attempt !== undefined) add('attempt = ?', update.attempt);
      if (update.clearProgress) assignments.push('progress = NULL');
      else if (update.progress !== undefined) add('progress = ?::jsonb', asJson(update.progress));
      if (update.stages !== undefined) add('stages = ?::jsonb', asJson(update.stages));
      if (update.preparedManifest !== undefined)
        add('prepared_manifest = ?::jsonb', asJson(update.preparedManifest));
      if (update.preparedCached !== undefined) add('prepared_cached = ?', update.preparedCached);
      if (update.leaseUntil !== undefined) add('lease_until = ?::timestamptz', update.leaseUntil);
      const result = await pool.query(
        `UPDATE hub_publication_jobs SET ${assignments.join(', ')}
         WHERE deck_id = $1 AND job_id = $2::uuid AND status = 'running'
           AND lease_token = $3::uuid AND lease_until > $4::timestamptz`,
        values,
      );
      return result.rowCount === 1;
    },

    async commitPublication(
      lease,
      manifest: ReleaseManifest,
      result: JobResult,
      stages: StageSnapshot[],
    ): Promise<'published' | 'superseded' | 'lease_lost'> {
      requireIso(lease.now, 'now');
      if (!validUuid(lease.leaseToken)) return 'lease_lost';
      return withTransaction(pool, async (client) => {
        const generation = await lockDeck(client, lease.deckId);
        const record = await readRecord(client, lease, true);
        if (!record) return 'lease_lost';
        if (record.generation === undefined || BigInt(record.generation) !== BigInt(generation)) {
          if (isActive(record.snapshot.status) && record.snapshot.result === undefined) {
            await supersedeUnpublished(client, lease.deckId, generation, lease.now);
          }
          return 'superseded';
        }
        if (!leaseMatches(record, lease)) return 'lease_lost';
        const published = await client.query(
          `UPDATE hub_publications SET current_manifest = $3::jsonb
           WHERE deck_id = $1 AND generation = $2::bigint`,
          [lease.deckId, generation, JSON.stringify(manifest)],
        );
        if (published.rowCount !== 1) return 'superseded';
        const updated = await client.query(
          `UPDATE hub_publication_jobs
           SET phase = 'thumbnail', result = $4::jsonb, stages = $5::jsonb,
               progress = NULL, version = version + 1,
               updated_at = GREATEST(updated_at, $6::timestamptz)
           WHERE deck_id = $1 AND job_id = $2::uuid AND status = 'running'
             AND lease_token = $3::uuid AND lease_until > $6::timestamptz`,
          [lease.deckId, lease.jobId, lease.leaseToken, asJson(result), asJson(stages), lease.now],
        );
        if (updated.rowCount !== 1)
          throw new Error('PostgreSQL publication fence changed inside its transaction');
        return 'published';
      });
    },

    async finish(lease, update: JobFinish): Promise<boolean> {
      requireIso(lease.now, 'now');
      if (!isDeckId(lease.deckId) || !isJobId(lease.jobId) || !validUuid(lease.leaseToken))
        return false;
      const isRetry = update.status === 'retry_wait';
      const nextRunAt = isRetry ? (update.nextRunAt ?? lease.now) : null;
      if (nextRunAt !== null) requireIso(nextRunAt, 'nextRunAt');
      return withTransaction(pool, async (client) => {
        // Deck rows are always locked before their jobs by publication and admission transactions.
        const deck = await client.query(
          'SELECT generation FROM hub_publications WHERE deck_id = $1 FOR UPDATE',
          [lease.deckId],
        );
        if (deck.rowCount !== 1) return false;
        const result = await client.query<{ kind: 'publication' | 'thumbnail' }>(
          `UPDATE hub_publication_jobs
           SET status = $4, phase = COALESCE($5, phase), version = version + 1,
               stages = $6::jsonb,
               result = CASE WHEN $7::jsonb IS NULL THEN result ELSE $7::jsonb END,
               error = $8::jsonb, next_run_at = $9::timestamptz,
               finished_at = CASE WHEN $4 = 'retry_wait' THEN NULL ELSE GREATEST(updated_at, $10::timestamptz) END,
               lease_token = NULL, lease_until = NULL,
               updated_at = GREATEST(updated_at, $10::timestamptz)
           WHERE deck_id = $1 AND job_id = $2::uuid AND lease_token = $3::uuid
             AND status = 'running' AND lease_until > $10::timestamptz
           RETURNING kind`,
          [
            lease.deckId,
            lease.jobId,
            lease.leaseToken,
            update.status,
            update.phase ?? null,
            asJson(update.stages),
            asJson(update.result),
            asJson(update.error),
            nextRunAt,
            lease.now,
          ],
        );
        const kind = result.rows[0]?.kind;
        if (kind === undefined) return false;
        if (kind === 'publication' && TERMINAL_STATUSES.has(update.status)) {
          await client.query(
            `INSERT INTO hub_publication_job_cleanup (deck_id, pending)
             VALUES ($1, true)
             ON CONFLICT (deck_id) DO UPDATE SET pending = true`,
            [lease.deckId],
          );
        }
        return true;
      });
    },

    async retry(parent, stage, job): Promise<JobAdmissionResult> {
      return withTransaction(pool, async (client) => {
        const generation = await lockDeck(client, parent.deckId);
        const expired = await client.query(
          `SELECT job_id FROM hub_publication_job_tombstones
           WHERE deck_id = $1 AND job_id = ANY($2::uuid[])`,
          [parent.deckId, [parent.jobId, job.snapshot.id]],
        );
        if (expired.rowCount) {
          await enqueueUnusedInput(client, parent.deckId, job.inputKey, undefined, true);
          return { outcome: 'expired' };
        }
        const existing = await readRecord(client, {
          deckId: parent.deckId,
          jobId: job.snapshot.id,
        });
        if (existing) return admissionFromExisting(existing, job.requestHash);
        const parentRecord = await readRecord(client, parent, true);
        if (!parentRecord) return { outcome: 'not_found' };
        if (
          !TERMINAL_STATUSES.has(parentRecord.snapshot.status) ||
          job.snapshot.deckId !== parent.deckId ||
          job.snapshot.parentJobId !== parent.jobId
        )
          return { outcome: 'invalid_retry' };

        const expectedKind = stage === 'thumbnail' ? 'thumbnail' : 'publication';
        if (job.snapshot.kind !== expectedKind) return { outcome: 'invalid_retry' };
        const sibling = await client.query(
          `SELECT 1 FROM hub_publication_jobs
           WHERE deck_id = $1 AND parent_job_id = $2::uuid AND kind = $3
             AND status IN ('queued', 'running', 'retry_wait') LIMIT 1`,
          [parent.deckId, parent.jobId, expectedKind],
        );
        if (sibling.rowCount) return { outcome: 'active_retry' };

        const child = baseRecord(job);
        if (stage === 'thumbnail') {
          const result = parentRecord.snapshot.result;
          if (result === undefined || result.thumbnail === 'ready')
            return { outcome: 'invalid_retry' };
          child.targetRevision = result.revision;
          child.snapshot.result = { ...clone(result), thumbnail: 'pending' };
        } else {
          if (
            parentRecord.snapshot.status !== 'failed' ||
            parentRecord.snapshot.result !== undefined ||
            !parentRecord.inputKey ||
            !parentRecord.inputHash ||
            parentRecord.generation === undefined
          )
            return { outcome: 'invalid_retry' };
          if (BigInt(parentRecord.generation) !== BigInt(generation))
            return { outcome: 'superseded' };
        }
        if ((await countActive(client, parent.deckId)) >= 10) return { outcome: 'limit' };

        if (stage === 'all') {
          const childGeneration = await allocateGeneration(client, parent.deckId);
          const now = await dbNow(client);
          await supersedeUnpublished(client, parent.deckId, childGeneration, now);
          child.generation = childGeneration;
        }
        const acceptedJob = await insertRecord(client, child);
        return { outcome: 'accepted', job: acceptedJob };
      });
    },
  };
}
