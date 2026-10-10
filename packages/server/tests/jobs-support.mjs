import { memoryOptions } from './support.mjs';
const terminal = (s) => ['succeeded', 'partial', 'failed', 'superseded'].includes(s);
export function jobOptions() {
  const fixture = memoryOptions();
  const { options, current, generations } = fixture;
  const records = new Map();
  const key = ({ deckId, jobId }) => JSON.stringify([deckId, jobId]);
  const copy = (v) => (v == null ? v : structuredClone(v));
  const all = (deckId) => [...records.values()].filter((r) => r.snapshot.deckId === deckId);
  function supersede(deckId, now) {
    for (const r of all(deckId))
      if (!terminal(r.snapshot.status) && !r.snapshot.result) {
        r.snapshot.status = 'superseded';
        r.snapshot.version++;
        r.snapshot.updatedAt = now;
        r.snapshot.finishedAt = now;
        delete r.leaseToken;
        delete r.leaseUntil;
      }
  }
  function admit(job, allocate = true) {
    const k = key({ deckId: job.snapshot.deckId, jobId: job.snapshot.id });
    const old = records.get(k);
    if (old)
      return old.requestHash === job.requestHash
        ? { outcome: 'replayed', job: copy(old) }
        : { outcome: 'conflict' };
    if (all(job.snapshot.deckId).filter((r) => !terminal(r.snapshot.status)).length >= 10)
      return { outcome: 'limit' };
    const r = copy(job);
    if (allocate) {
      const n = (generations.get(r.snapshot.deckId) ?? 0) + 1;
      generations.set(r.snapshot.deckId, n);
      supersede(r.snapshot.deckId, r.snapshot.createdAt);
      r.generation = `lease:${n}`;
    }
    records.set(k, r);
    return { outcome: 'accepted', job: copy(r) };
  }
  function owned(lease) {
    const r = records.get(key(lease));
    return r &&
      r.snapshot.status === 'running' &&
      r.leaseToken === lease.leaseToken &&
      Date.parse(r.leaseUntil) > Date.parse(lease.now)
      ? r
      : null;
  }
  function touch(r, now) {
    r.snapshot.updatedAt = now;
    r.snapshot.version++;
  }
  const publications = {
    async begin(deckId) {
      const n = (generations.get(deckId) ?? 0) + 1;
      generations.set(deckId, n);
      supersede(deckId, new Date().toISOString());
      return `lease:${n}`;
    },
    async current(deckId) {
      return copy(current.get(deckId) ?? null);
    },
    async commit(deckId, token, manifest) {
      if (token !== `lease:${generations.get(deckId)}`) return false;
      current.set(deckId, copy(manifest));
      return true;
    },
  };
  const jobs = {
    publications,
    async submit(job) {
      return admit(job);
    },
    async get(identity) {
      return copy(records.get(key(identity)) ?? null);
    },
    async list({ deckId, limit, cursor }) {
      let offset = 0;
      if (cursor) {
        const parsed = JSON.parse(atob(cursor));
        if (parsed.deckId !== deckId) throw new TypeError('Invalid cursor');
        offset = parsed.offset;
      }
      const sorted = all(deckId).sort(
        (a, b) =>
          b.snapshot.createdAt.localeCompare(a.snapshot.createdAt) ||
          b.snapshot.id.localeCompare(a.snapshot.id),
      );
      return {
        items: copy(sorted.slice(offset, offset + limit)),
        ...(offset + limit < sorted.length
          ? { nextCursor: btoa(JSON.stringify({ deckId, offset: offset + limit })) }
          : {}),
      };
    },
    async claim({ now, leaseUntil, leaseToken, deckId }) {
      const r = [...records.values()].find(
        (r) =>
          (!deckId || r.snapshot.deckId === deckId) &&
          ((['queued', 'retry_wait'].includes(r.snapshot.status) &&
            (!r.snapshot.nextRunAt || Date.parse(r.snapshot.nextRunAt) <= Date.parse(now))) ||
            (r.snapshot.status === 'running' && Date.parse(r.leaseUntil) <= Date.parse(now))),
      );
      if (!r) return null;
      r.leaseToken = leaseToken;
      r.leaseUntil = leaseUntil;
      r.snapshot.status = 'running';
      r.snapshot.startedAt ??= now;
      delete r.snapshot.nextRunAt;
      delete r.snapshot.error;
      touch(r, now);
      return copy(r);
    },
    async checkpoint(lease, update) {
      const r = owned(lease);
      if (!r) return false;
      for (const k of ['phase', 'attempt', 'progress', 'stages'])
        if (update[k] !== undefined) r.snapshot[k] = copy(update[k]);
      if (update.clearProgress) delete r.snapshot.progress;
      for (const k of ['preparedManifest', 'preparedCached', 'leaseUntil'])
        if (update[k] !== undefined) r[k] = copy(update[k]);
      touch(r, lease.now);
      return true;
    },
    async commitPublication(lease, manifest, result, stages) {
      const r = owned(lease);
      if (!r) return 'lease_lost';
      if (r.generation !== `lease:${generations.get(lease.deckId)}`) return 'superseded';
      current.set(lease.deckId, copy(manifest));
      r.snapshot.result = copy(result);
      r.snapshot.stages = copy(stages);
      touch(r, lease.now);
      return 'published';
    },
    async finish(lease, update) {
      const r = owned(lease);
      if (!r) return false;
      Object.assign(r.snapshot, copy(update));
      delete r.snapshot.progress;
      if (update.status !== 'retry_wait') r.snapshot.finishedAt = lease.now;
      delete r.leaseToken;
      delete r.leaseUntil;
      touch(r, lease.now);
      return true;
    },
    async retry(parent, stage, job) {
      const old = records.get(key(parent));
      const existing = records.get(key({ deckId: job.snapshot.deckId, jobId: job.snapshot.id }));
      if (existing) return admit(job);
      if (!old) return { outcome: 'not_found' };
      if (!terminal(old.snapshot.status)) return { outcome: 'invalid_retry' };
      if (
        all(parent.deckId).some(
          (r) =>
            r.snapshot.parentJobId === parent.jobId &&
            r.snapshot.kind === job.snapshot.kind &&
            !terminal(r.snapshot.status),
        )
      )
        return { outcome: 'active_retry' };
      if (stage === 'all' && old.generation !== `lease:${generations.get(parent.deckId)}`)
        return { outcome: 'superseded' };
      return admit(job, stage === 'all');
    },
  };
  options.publications = publications;
  options.jobs = jobs;
  options.publicOrigin = 'http://localhost:4180';
  options.publishToken = 'publish-secret';
  options.allowLocalMutations = false;
  return { ...fixture, records, jobs };
}
