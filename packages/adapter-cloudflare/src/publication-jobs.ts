import type {
  AutomaticJobCleanupStore,
  JobCleanupLease,
  JobAdmissionResult,
  JobIdentity,
  PendingJobInputDelete,
  PublicationJobMaintenanceStore,
  PublicationJobRecord,
  PublicationJobStore,
} from '@slidock/server';

/** RPC methods implemented by the existing DeckVersions class. */
export interface DeckVersionsCoordinator extends Rpc.DurableObjectBranded {
  begin(deckId?: string): Promise<number>;
  current(deckId?: string): Promise<object | null>;
  commit(generation: number, manifest: object, deckId?: string): Promise<boolean>;
  jobsSubmit(jobJson: string): Promise<string>;
  jobsGet(identityJson: string): Promise<string | null>;
  jobsList(optionsJson: string): Promise<string>;
  jobsClaim(optionsJson: string): Promise<string | null>;
  jobsCheckpoint(leaseJson: string, updateJson: string): Promise<boolean>;
  jobsCommitPublication(
    leaseJson: string,
    manifestJson: string,
    resultJson: string,
    stagesJson: string,
  ): Promise<'published' | 'superseded' | 'lease_lost'>;
  jobsFinish(leaseJson: string, updateJson: string): Promise<boolean>;
  jobsRetry(parentJson: string, stage: 'all' | 'thumbnail', jobJson: string): Promise<string>;
  jobsIsExpired(identityJson: string): Promise<boolean>;
  jobsCleanup(optionsJson: string): Promise<string>;
  jobsCleanupClaim(optionsJson: string): Promise<string | null>;
  jobsCleanupFinish(leaseJson: string, optionsJson: string): Promise<boolean>;
  jobsListInputDeletes(optionsJson: string): Promise<string>;
  jobsAcknowledgeInputDelete(itemJson: string): Promise<boolean>;
}

type DeckVersionsMethodName =
  | 'begin'
  | 'current'
  | 'commit'
  | 'jobsSubmit'
  | 'jobsGet'
  | 'jobsList'
  | 'jobsClaim'
  | 'jobsCheckpoint'
  | 'jobsCommitPublication'
  | 'jobsFinish'
  | 'jobsRetry'
  | 'jobsIsExpired'
  | 'jobsCleanup'
  | 'jobsCleanupClaim'
  | 'jobsCleanupFinish'
  | 'jobsListInputDeletes'
  | 'jobsAcknowledgeInputDelete';

/** Raw method shape used by alarm code inside the object itself. */
export type DeckVersionsDirect = Pick<DeckVersionsCoordinator, DeckVersionsMethodName>;

export type DeckVersionsRpc = Pick<
  DurableObjectStub<DeckVersionsCoordinator>,
  DeckVersionsMethodName
>;

export interface DeckVersionsJobPage {
  items: PublicationJobRecord[];
  nextCursor?: string;
}

type RpcForDeck = (deckId: string) => DeckVersionsDirect;

function requireDeckId(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Durable Object publication jobs require a deck id');
  }
  return value;
}

function toRpc(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error('Durable Object RPC payload is not JSON serializable');
  return serialized;
}

function toRpcValue(value: unknown): object {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Durable Object manifest is not JSON serializable');
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Durable Object manifest must be a JSON object');
  }
  return parsed;
}

function fromRpc<T>(value: string): T {
  return JSON.parse(value) as T;
}

function directStub(stub: DeckVersionsRpc): DeckVersionsDirect {
  return {
    begin: (deckId) => stub.begin(deckId),
    async current(deckId) {
      return await stub.current(deckId);
    },
    commit: (generation, manifest, deckId) => stub.commit(generation, manifest, deckId),
    jobsSubmit: (jobJson) => stub.jobsSubmit(jobJson),
    async jobsGet(identityJson) {
      const value = await stub.jobsGet(identityJson);
      return value === null ? null : value;
    },
    jobsList: (optionsJson) => stub.jobsList(optionsJson),
    async jobsClaim(optionsJson) {
      const value = await stub.jobsClaim(optionsJson);
      return value === null ? null : value;
    },
    jobsCheckpoint: (leaseJson, updateJson) => stub.jobsCheckpoint(leaseJson, updateJson),
    async jobsCommitPublication(leaseJson, manifestJson, resultJson, stagesJson) {
      return await stub.jobsCommitPublication(leaseJson, manifestJson, resultJson, stagesJson);
    },
    jobsFinish: (leaseJson, updateJson) => stub.jobsFinish(leaseJson, updateJson),
    jobsRetry: (parentJson, stage, jobJson) => stub.jobsRetry(parentJson, stage, jobJson),
    jobsIsExpired: (identityJson) => stub.jobsIsExpired(identityJson),
    jobsCleanup: (optionsJson) => stub.jobsCleanup(optionsJson),
    async jobsCleanupClaim(optionsJson) {
      const value = await stub.jobsCleanupClaim(optionsJson);
      return value === null ? null : value;
    },
    jobsCleanupFinish: (leaseJson, optionsJson) => stub.jobsCleanupFinish(leaseJson, optionsJson),
    jobsListInputDeletes: (optionsJson) => stub.jobsListInputDeletes(optionsJson),
    jobsAcknowledgeInputDelete: (itemJson) => stub.jobsAcknowledgeInputDelete(itemJson),
  };
}

function storeForDeck(rpcForDeck: RpcForDeck): PublicationJobStore {
  const maintenance: PublicationJobMaintenanceStore = {
    automatic: {
      async claim(options) {
        if (options.deckId === undefined) return null;
        const deckId = requireDeckId(options.deckId);
        const value = await rpcForDeck(deckId).jobsCleanupClaim(toRpc({ ...options, deckId }));
        return value === null ? null : fromRpc<JobCleanupLease>(value);
      },
      finish(lease, options) {
        const deckId = requireDeckId(lease.deckId);
        return rpcForDeck(deckId).jobsCleanupFinish(toRpc(lease), toRpc(options));
      },
    } satisfies AutomaticJobCleanupStore,
    isExpired(identity: JobIdentity) {
      const deckId = requireDeckId(identity.deckId);
      return rpcForDeck(deckId).jobsIsExpired(toRpc(identity));
    },
    cleanup(options) {
      const deckId = requireDeckId(options.deckId);
      return rpcForDeck(deckId)
        .jobsCleanup(toRpc({ ...options, deckId }))
        .then((value) =>
          fromRpc<{ jobs: { jobId: string; finishedAt: string }[]; more: boolean }>(value),
        );
    },
    listPendingInputDeletes(options) {
      const deckId = requireDeckId(options.deckId);
      return rpcForDeck(deckId)
        .jobsListInputDeletes(toRpc({ ...options, deckId }))
        .then((value) => fromRpc<{ items: PendingJobInputDelete[]; pendingCount: number }>(value));
    },
    acknowledgeInputDelete(item) {
      const deckId = requireDeckId(item.deckId);
      return rpcForDeck(deckId).jobsAcknowledgeInputDelete(toRpc(item));
    },
  };
  const publications: PublicationJobStore['publications'] = {
    async begin(deckId) {
      const generation = await rpcForDeck(requireDeckId(deckId)).begin(deckId);
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error('Durable Object returned an invalid publication generation');
      }
      return String(generation);
    },
    current(deckId) {
      return rpcForDeck(requireDeckId(deckId)).current(deckId);
    },
    async commit(deckId, token, manifest) {
      // DO generations are numbers. Reject alternate encodings rather than letting
      // Number accept whitespace, exponents, signs, or unsafe rounded integers.
      if (!/^[1-9][0-9]*$/u.test(token)) return false;
      const generation = Number(token);
      if (!Number.isSafeInteger(generation)) return false;
      return rpcForDeck(requireDeckId(deckId)).commit(generation, toRpcValue(manifest), deckId);
    },
  };

  return {
    publications,
    maintenance,
    submit(job) {
      const deckId = requireDeckId(job.snapshot.deckId);
      return rpcForDeck(deckId)
        .jobsSubmit(toRpc(job))
        .then((value) => fromRpc<JobAdmissionResult>(value));
    },
    get(identity) {
      const deckId = requireDeckId(identity.deckId);
      return rpcForDeck(deckId)
        .jobsGet(toRpc(identity))
        .then((value) => (value === null ? null : fromRpc<PublicationJobRecord>(value)));
    },
    list(options) {
      const deckId = requireDeckId(options.deckId);
      return rpcForDeck(deckId)
        .jobsList(toRpc({ ...options, deckId }))
        .then((value) => fromRpc<DeckVersionsJobPage>(value));
    },
    claim(options) {
      if (options.deckId === undefined) {
        throw new Error('Durable Object job claims require a deck id');
      }
      const deckId = requireDeckId(options.deckId);
      return rpcForDeck(deckId)
        .jobsClaim(toRpc({ ...options, deckId }))
        .then((value) => (value === null ? null : fromRpc<PublicationJobRecord>(value)));
    },
    checkpoint(lease, update) {
      const deckId = requireDeckId(lease.deckId);
      return rpcForDeck(deckId).jobsCheckpoint(toRpc(lease), toRpc(update));
    },
    commitPublication(lease, manifest, result, stages) {
      const deckId = requireDeckId(lease.deckId);
      return rpcForDeck(deckId).jobsCommitPublication(
        toRpc(lease),
        toRpc(manifest),
        toRpc(result),
        toRpc(stages),
      );
    },
    finish(lease, update) {
      const deckId = requireDeckId(lease.deckId);
      return rpcForDeck(deckId).jobsFinish(toRpc(lease), toRpc(update));
    },
    retry(parent, stage, job) {
      const deckId = requireDeckId(parent.deckId);
      if (job.snapshot.deckId !== deckId) {
        throw new Error('Retry job deck id does not match its parent');
      }
      return rpcForDeck(deckId)
        .jobsRetry(toRpc(parent), stage, toRpc(job))
        .then((value) => fromRpc<JobAdmissionResult>(value));
    },
  };
}

/** Route both publication and job operations through the same deck DO namespace. */
export function createDurableObjectPublicationJobStore(
  namespace: Pick<DurableObjectNamespace<DeckVersionsCoordinator>, 'getByName'>,
): PublicationJobStore {
  return storeForDeck((deckId) => directStub(namespace.getByName(deckId)));
}

/** Keep the original publication-only adapter API for existing consumers. */
export function createDurableObjectPublicationStore(
  namespace: Pick<DurableObjectNamespace<DeckVersionsCoordinator>, 'getByName'>,
): PublicationJobStore['publications'] {
  return createDurableObjectPublicationJobStore(namespace).publications;
}

/** Avoid a self-RPC from DeckVersions.alarm() while retaining the same store contract. */
export function createDeckBoundDurableObjectPublicationJobStore(
  coordinator: DeckVersionsDirect,
  deckId: string,
): PublicationJobStore {
  const boundDeckId = requireDeckId(deckId);
  return storeForDeck((requestedDeckId) => {
    if (requireDeckId(requestedDeckId) !== boundDeckId) {
      throw new Error('Durable Object RPC was routed to the wrong deck');
    }
    return coordinator;
  });
}
