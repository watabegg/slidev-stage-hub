export function memoryOptions({ failPut, failBegin, failCommit } = {}) {
  const values = new Map();
  const current = new Map();
  const generations = new Map();
  const calls = [];
  const options = {
    artifacts: {
      async put(key, body, metadata = {}) {
        calls.push({ kind: 'put', key });
        if (failPut?.(key)) throw new Error('private storage failure');
        if (metadata.ifAbsent && values.has(key)) return false;
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        values.set(key, { bytes, contentType: metadata.contentType, etag: '"opaque-etag"' });
        return true;
      },
      async get(key) {
        const value = values.get(key);
        return value ? { ...value, body: new Response(value.bytes).body } : null;
      },
      async head(key) {
        const value = values.get(key);
        return value
          ? { contentType: value.contentType, etag: value.etag, size: value.bytes.length }
          : null;
      },
      async list({ prefix, limit, cursor }) {
        const offset = cursor === undefined ? 0 : Number(cursor);
        const all = [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
        const keys = all.slice(offset, offset + limit);
        return {
          keys,
          ...(offset + keys.length < all.length ? { cursor: String(offset + keys.length) } : {}),
        };
      },
    },
    publications: {
      async begin(id) {
        if (failBegin?.(id)) throw new Error('private begin failure');
        const generation = (generations.get(id) ?? 0) + 1;
        generations.set(id, generation);
        return `lease:${generation}`;
      },
      async current(id) {
        return current.get(id) ?? null;
      },
      async commit(id, token, manifest) {
        calls.push({ kind: 'commit', id, token });
        if (failCommit?.(id)) throw new Error('private commit failure');
        if (token !== `lease:${generations.get(id)}`) return false;
        current.set(id, manifest);
        return true;
      },
    },
    staticAssets: {
      async fetch() {
        return new Response('SPA document', { headers: { 'content-type': 'text/html' } });
      },
    },
    profile: { digest: 'profile-digest' },
    allowLocalMutations: true,
  };
  return { options, values, current, generations, calls };
}

export function compileResult(input) {
  return {
    title: input.markdown.slice(2),
    frontmatter: {},
    warnings: [],
    native: { clickTotals: [0] },
    slides: [{ no: 1, frontmatter: {}, code: 'export default {}', css: '' }],
  };
}

export function pngHeader() {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(16, 1200);
  view.setUint32(20, 675);
  return bytes;
}
