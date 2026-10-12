import type { JobPhase, JobStatus } from '@slidock/protocol';
import type { PublicationJobStore } from './jobs/ports.js';
/** Provider-independent storage metadata; ETags are opaque HTTP entity tags. */
export interface ArtifactMetadata {
  contentType?: string;
  etag?: string;
  size?: number;
}
export interface ArtifactObject extends ArtifactMetadata {
  body: ReadableStream<Uint8Array>;
}
export type ArtifactBody = string | Uint8Array | ReadableStream<Uint8Array>;
export interface ArtifactStore {
  get(key: string): Promise<ArtifactObject | null>;
  head(key: string): Promise<ArtifactMetadata | null>;
  /** Returns false only if ifAbsent is requested and the key already exists. */
  put(
    key: string,
    body: ArtifactBody,
    options?: { contentType?: string; ifAbsent?: boolean },
  ): Promise<boolean>;
  /** Delete one object. Missing objects are treated as successfully deleted. */
  delete?(key: string): Promise<void>;
  /** Cursor is opaque and store-specific. An absent cursor means the final page. */
  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<{ keys: string[]; cursor?: string }>;
}
export interface PublicationStore {
  /** Linearizable per deck. Does not change the current manifest. */
  begin(deckId: string): Promise<string>;
  current(deckId: string): Promise<unknown | null>;
  /** Only the most recently begun token can commit. Repeated same-token commits may succeed. */
  commit(deckId: string, token: string, manifest: unknown): Promise<boolean>;
}
export interface RuntimeProfile {
  digest: string;
  theme?: string;
  /** Existing JSON-encoded registration lists, retained for configuration compatibility. */
  layouts?: string;
  components?: string;
}
export interface RuntimeSnapshotFile {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
}
export interface RuntimeSnapshot {
  schemaVersion: 1;
  id: string;
  files: RuntimeSnapshotFile[];
}
export interface PublicationJobEvent {
  event: 'claimed' | 'stage_done' | 'published' | 'finished' | 'retry_wait';
  jobId: string;
  deckId: string;
  phase: JobPhase;
  attempt: number;
  durationMs?: number;
  queueAgeMs?: number;
  code?: string;
  status?: JobStatus;
}
export interface HubServerOptions {
  artifacts: ArtifactStore;
  jobs?: PublicationJobStore;
  /** Disable new admission while keeping status reads and worker draining available. */
  jobsEnabled?: boolean;
  /** Safe structured events for provider telemetry; failures never affect execution. */
  onJobEvent?: (event: PublicationJobEvent) => void | Promise<void>;
  /** Configured origin used for background rendering; never derived from request Host. */
  publicOrigin?: string;
  /** Must equal `jobs.publications` when a paired job store is configured. */
  publications: PublicationStore;
  staticAssets: { fetch(request: Request): Promise<Response> };
  profile: RuntimeProfile;
  loadRuntime?: () => Promise<RuntimeSnapshot | undefined>;
  publishToken?: string;
  allowLocalMutations?: boolean;
  renderThumbnail?: (url: string) => Promise<{ bytes: Uint8Array; usedMs: number | null }>;
}
