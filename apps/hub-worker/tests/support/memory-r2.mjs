export function createMemoryBucket({ pageSize = 1000, failPut } = {}) {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    async put(key, body) {
      calls.push({ kind: 'put', key });
      if (failPut?.(key)) throw new Error('simulated R2 write failure');
      values.set(key, await bodyToString(body));
      return { key, etag: `etag-${key}` };
    },
    async get(key) {
      calls.push({ kind: 'get', key });
      const value = values.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        httpEtag: `etag-${key}`,
        async json() {
          return JSON.parse(value);
        },
        writeHttpMetadata(headers) {
          headers.set('content-type', 'application/json');
        },
      };
    },
    async head(key) {
      calls.push({ kind: 'head', key });
      return values.has(key) ? { key } : null;
    },
    async list({ prefix = '', limit = 1000, cursor }) {
      calls.push({ kind: 'list', prefix, limit, cursor });
      const matching = [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
      const offset = cursor === undefined ? 0 : Number(cursor);
      const count = Math.min(limit, pageSize);
      const objects = matching.slice(offset, offset + count).map((key) => ({ key }));
      const truncated = offset + objects.length < matching.length;
      return {
        objects,
        truncated,
        ...(truncated ? { cursor: String(offset + objects.length) } : {}),
      };
    },
  };
}

export function createMemoryEnv({ bucket = createMemoryBucket(), current = new Map() } = {}) {
  const generations = new Map();
  const calls = [];
  const versions = {
    calls,
    getByName(id) {
      return {
        async begin() {
          const generation = (generations.get(id) ?? 0) + 1;
          generations.set(id, generation);
          calls.push({ kind: 'begin', id, generation });
          return generation;
        },
        async current() {
          return current.get(id) ?? null;
        },
        async commit(generation, manifest) {
          calls.push({ kind: 'commit', id, generation });
          if (generations.get(id) !== generation) return false;
          current.set(id, manifest);
          return true;
        },
      };
    },
  };
  return {
    FILES: bucket,
    VERSIONS: versions,
    STATIC: {
      async fetch() {
        return new Response('static');
      },
    },
    PROFILE_DIGEST: 'profile-digest',
    PROFILE_LAYOUTS: '["cover","default","section"]',
    PROFILE_COMPONENTS: '["FigureGrid"]',
    current,
    generations,
  };
}

export function releaseManifest(options = {}) {
  const id = options.id;
  const revision = options.revision ?? 'a'.repeat(64);
  const native = Object.hasOwn(options, 'native') ? options.native : { clickTotals: [0] };
  const frontmatter = options.frontmatter ?? { title: id, notes: 'private note' };
  return {
    id,
    revision,
    title: id,
    profileDigest: 'profile-digest',
    frontmatter,
    warnings: [],
    entry: `/${id}/1?revision=${revision}`,
    slides: [
      {
        no: 1,
        frontmatter: {},
        module: `/releases/${id}/${revision}/1.js`,
        css: `/releases/${id}/${revision}/1.css`,
      },
    ],
    ...(native === undefined ? {} : { native }),
  };
}

async function bodyToString(body) {
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  if (body instanceof Blob) return body.text();
  const response = new Response(body);
  return response.text();
}
