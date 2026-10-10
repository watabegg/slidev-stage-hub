import type {
  JobSnapshot,
  JobPhase,
  JobProgress,
  JobResult,
  JobError,
  StageSnapshot,
  ThumbnailMode,
} from '@slidev-stage-hub/protocol';
import type { PublicationStore } from '../ports.js';
import type { ReleaseManifest } from '../manifest.js';
export const JOB_LEASE_MS = 120_000;
export const JOB_HEARTBEAT_MS = 30_000;
export const COMPILER_CONTRACT_VERSION = 'native-click-metadata-v1';
/** Private durable state. Only snapshot is exposed by the HTTP service. */
export interface PublicationJobRecord {
  snapshot: JobSnapshot;
  requestHash: string;
  inputKey?: string;
  inputHash?: string;
  generation?: string;
  targetRevision?: string;
  profileDigest: string;
  /** Runtime descriptor identity captured at admission without archiving its files. */
  runtimeId?: string;
  compilerContractVersion: string;
  thumbnail: ThumbnailMode;
  viewTokenHash: string;
  viewExpiresAt: string;
  leaseToken?: string;
  leaseUntil?: string;
  preparedManifest?: ReleaseManifest;
  preparedCached?: boolean;
}
export type NewPublicationJob = Omit<
  PublicationJobRecord,
  'generation' | 'leaseToken' | 'leaseUntil'
>;
export interface JobIdentity {
  deckId: string;
  jobId: string;
}
export interface JobLease extends JobIdentity {
  leaseToken: string;
  now: string;
}
export type JobAdmissionResult =
  | { outcome: 'accepted' | 'replayed'; job: PublicationJobRecord }
  | {
      outcome: 'conflict' | 'limit' | 'not_found' | 'invalid_retry' | 'superseded' | 'active_retry';
    };
export interface JobCheckpoint {
  phase?: JobPhase;
  attempt?: number;
  progress?: JobProgress;
  clearProgress?: boolean;
  stages?: StageSnapshot[];
  preparedManifest?: ReleaseManifest;
  preparedCached?: boolean;
  /** Heartbeats extend leases using the same fenced checkpoint operation. */
  leaseUntil?: string;
}
export interface JobFinish {
  status: 'retry_wait' | 'succeeded' | 'partial' | 'failed' | 'superseded';
  phase?: JobPhase;
  stages: StageSnapshot[];
  result?: JobResult;
  error?: JobError;
  nextRunAt?: string;
}
/** Must share one transaction authority with publications, including legacy begin. */
export interface PublicationJobStore {
  readonly publications: PublicationStore;
  /** Allocate generation, insert job, supersede unpublished predecessors and persist wake atomically. Same hash replays without allocating. */
  submit(job: NewPublicationJob): Promise<JobAdmissionResult>;
  get(identity: JobIdentity): Promise<PublicationJobRecord | null>;
  /** Descending (createdAt,id); opaque cursor must be bound to deckId. */
  list(options: {
    deckId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: PublicationJobRecord[]; nextCursor?: string }>;
  /** Includes running jobs whose lease expired. Set running and assign a fresh token atomically. */
  claim(options: {
    now: string;
    leaseUntil: string;
    leaseToken: string;
    deckId?: string;
  }): Promise<PublicationJobRecord | null>;
  /** All checkpoint/finish updates require running status, matching token and unexpired lease. False means stop immediately. */
  checkpoint(lease: JobLease, update: JobCheckpoint): Promise<boolean>;
  /** Atomically fence generation+lease, change current and save published result+stages. */
  commitPublication(
    lease: JobLease,
    manifest: ReleaseManifest,
    result: JobResult,
    stages: StageSnapshot[],
  ): Promise<'published' | 'superseded' | 'lease_lost'>;
  finish(lease: JobLease, update: JobFinish): Promise<boolean>;
  /** Admission checks parent terminal, active sibling and latest generation in the same transaction. Thumbnail copies exact result, allocates no generation. */
  retry(
    parent: JobIdentity,
    stage: 'all' | 'thumbnail',
    job: NewPublicationJob,
  ): Promise<JobAdmissionResult>;
}
