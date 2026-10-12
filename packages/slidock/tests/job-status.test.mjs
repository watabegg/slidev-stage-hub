import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const entry = resolve(projectRoot, 'src/frontend/job-status.ts');
const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [
    {
      name: 'vue-component-test-stub',
      setup(buildContext) {
        buildContext.onResolve({ filter: /^vue$/ }, () => ({
          path: 'vue-test-stub',
          namespace: 'vue-test-stub',
        }));
        buildContext.onLoad({ filter: /.*/, namespace: 'vue-test-stub' }, () => ({
          contents: `export function createApp(component, props) {
            const app = { component, props, unmountCount: 0, mount() {}, unmount() { this.unmountCount += 1; } };
            globalThis.__jobStatusTestApp = app;
            return app;
          }`,
          loader: 'js',
        }));
        buildContext.onResolve({ filter: /\.vue$/ }, (args) => ({
          path: args.path,
          namespace: 'vue-component-test-stub',
        }));
        buildContext.onLoad({ filter: /.*/, namespace: 'vue-component-test-stub' }, () => ({
          contents: 'export default {};',
          loader: 'js',
        }));
      },
    },
  ],
});
const frontend = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

const deckId = 'demo/overview';
const jobId = '31c7e3a2-1746-4d90-a941-cc8fe6ac1ba2';
const token = `${'A'.repeat(42)}A`;

test('removes a view token from the fragment before saving it in job-scoped session storage', () => {
  const order = [];
  const values = new Map();
  const environment = {
    location: {
      href: `https://hub.example/_hub/jobs?deckId=${deckId}&jobId=${jobId}#view=${token}`,
      hash: `#view=${token}`,
      origin: 'https://hub.example',
      pathname: '/_hub/jobs',
      search: `?deckId=${deckId}&jobId=${jobId}`,
    },
    history: {
      state: null,
      replaceState(_state, _title, url) {
        order.push('replace');
        assert.equal(new URL(url).hash, '');
      },
    },
    storage: {
      getItem(key) {
        order.push('read');
        return values.get(key) ?? null;
      },
      setItem(key, value) {
        order.push('write');
        values.set(key, value);
      },
      removeItem(key) {
        values.delete(key);
      },
    },
    deckId,
    jobId,
  };

  const resolved = frontend.resolveJobViewToken(environment);
  assert.deepEqual(order, ['replace', 'read', 'write']);
  assert.equal(resolved.token, token);
  assert.equal(resolved.invalid, false);
  assert.equal(values.get(resolved.storageKey), token);
  assert.notEqual(
    resolved.storageKey,
    frontend.jobViewStorageKey(
      environment.location.origin,
      deckId,
      '4b4a7d2c-5662-4c9d-8f46-1f8c41a93c77',
    ),
  );

  const reloaded = frontend.resolveJobViewToken({
    ...environment,
    location: { ...environment.location, href: environment.location.href.split('#')[0], hash: '' },
    history: {
      ...environment.history,
      replaceState() {
        assert.fail('an empty fragment should not change browser history');
      },
    },
  });
  assert.equal(reloaded.token, token);
});

test('rejects malformed fragment tokens without retaining them', () => {
  const stored = [];
  const removed = [];
  const resolved = frontend.resolveJobViewToken({
    location: {
      href: `https://hub.example/_hub/jobs?deckId=${deckId}&jobId=${jobId}#view=secret`,
      hash: '#view=secret',
      origin: 'https://hub.example',
      pathname: '/_hub/jobs',
      search: `?deckId=${deckId}&jobId=${jobId}`,
    },
    history: { state: null, replaceState() {} },
    storage: {
      getItem: () => null,
      setItem: (...args) => stored.push(args),
      removeItem: (key) => removed.push(key),
    },
    deckId,
    jobId,
  });
  assert.equal(resolved.invalid, true);
  assert.equal(resolved.token, undefined);
  assert.deepEqual(stored, []);
  assert.deepEqual(removed, [resolved.storageKey]);
});

test('caller abort unmounts once, aborts the request, and releases route-scoped page layout', () => {
  const caller = new AbortController();
  const target = { nodeType: 1 };
  const classes = new Set();
  const previousDocument = globalThis.document;
  globalThis.document = {
    documentElement: {
      classList: {
        contains: (name) => classes.has(name),
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
    },
  };

  try {
    const unmount = frontend.mountJobStatus(target, {
      client: {},
      deckId,
      jobId,
      signal: caller.signal,
    });
    const app = globalThis.__jobStatusTestApp;
    assert.ok(app);
    assert.notEqual(app.props.signal, caller.signal);
    assert.equal(app.props.signal.aborted, false);
    assert.equal(classes.has('hub-job-status-page'), true);

    caller.abort();
    assert.equal(app.props.signal.aborted, true);
    assert.equal(app.unmountCount, 1);
    assert.equal(classes.has('hub-job-status-page'), false);
    unmount();
    assert.equal(app.unmountCount, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('route layout class stays active until the last mounted status view is removed', () => {
  const classes = new Set();
  const previousDocument = globalThis.document;
  globalThis.document = {
    documentElement: {
      classList: {
        contains: (name) => classes.has(name),
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
    },
  };

  try {
    const options = { client: {}, deckId, jobId };
    const first = frontend.mountJobStatus({ nodeType: 1 }, options);
    const second = frontend.mountJobStatus({ nodeType: 1 }, options);
    assert.equal(classes.has('hub-job-status-page'), true);
    first();
    assert.equal(classes.has('hub-job-status-page'), true);
    second();
    assert.equal(classes.has('hub-job-status-page'), false);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('creates revision-pinned links only for publication results completed by this or a parent job', () => {
  const revision = 'a'.repeat(64);
  const childJobId = '2c2bb85c-831b-43a7-9a06-5f2ef21e0e39';
  const job = {
    id: jobId,
    deckId,
    kind: 'publication',
    status: 'running',
    phase: 'thumbnail',
    version: 5,
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:03Z',
    attempt: 1,
    stages: [{ phase: 'publish', status: 'succeeded', attempt: 1 }],
    result: {
      revision,
      entry: `/${deckId}/1?revision=${revision}`,
      pages: 8,
      cached: false,
      thumbnail: 'pending',
    },
  };

  assert.equal(
    frontend.createPublishedSlideHref(job, deckId, jobId, 'https://hub.example'),
    `/${deckId}/1?revision=${revision}`,
  );
  assert.equal(
    frontend.createPublishedSlideHref(
      {
        ...job,
        result: {
          ...job.result,
          entry: `https://outside.example/${deckId}/1?revision=${revision}`,
        },
      },
      deckId,
      jobId,
      'https://hub.example',
    ),
    undefined,
  );
  assert.equal(
    frontend.createPublishedSlideHref(
      { ...job, stages: [{ phase: 'publish', status: 'running', attempt: 1 }] },
      deckId,
      jobId,
      'https://hub.example',
    ),
    undefined,
  );
  assert.equal(
    frontend.createPublishedSlideHref(
      {
        ...job,
        id: childJobId,
        kind: 'thumbnail',
        status: 'succeeded',
        phase: 'thumbnail',
        stages: [{ phase: 'publish', status: 'skipped', attempt: 0 }],
      },
      deckId,
      childJobId,
      'https://hub.example',
    ),
    `/${deckId}/1?revision=${revision}`,
  );
  assert.equal(
    frontend.createPublishedSlideHref(
      {
        ...job,
        stages: [{ phase: 'publish', status: 'skipped', attempt: 0 }],
      },
      deckId,
      jobId,
      'https://hub.example',
    ),
    undefined,
  );
});
