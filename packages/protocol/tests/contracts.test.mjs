import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isNativeBridgeDiagnostic,
  isNativeBridgeFailure,
  isNativeBridgeReady,
  isNativeFrameState,
  isNativeNavigationAction,
  isNativeRenderedReport,
  validateCatalog,
  validatePlayerDocument,
} from '../dist/contracts/index.js';

const validDeck = {
  id: 'course/topic-1',
  revision: 'build-17',
  entry: '/course/topic-1/1',
  clickTotals: [0, 2, 4],
};

const validPlayerDocument = (overrides = {}) => ({
  schemaVersion: 1,
  protocolVersion: 1,
  decks: [{ ...validDeck }],
  unsupportedDecks: [],
  ...overrides,
});

const validPlayerDocumentV2 = (overrides = {}) => ({
  ...validPlayerDocument(),
  schemaVersion: 2,
  decks: [{ ...validDeck, playback: { kind: 'revision-query', parameter: 'revision' } }],
  ...overrides,
});

const validCatalog = (overrides = {}) => ({
  schemaVersion: 1,
  categories: [{ id: 'course', name: 'Course', path: ['course'], parentId: null }],
  decks: [
    {
      id: 'course/topic-1',
      title: 'Topic 1',
      entry: '/course/topic-1/1',
      pages: 3,
      revision: 'build-17',
      categoryPath: ['course'],
      frontmatter: { title: 'Topic 1', tags: ['intro', 2026] },
      thumbnail: { src: '/thumbnails/course/topic-1.png', width: 1200, height: 675 },
      runtimeVersion: '53.0.0',
      theme: 'default@0.25.0',
      profile: 'default',
    },
  ],
  ...overrides,
});

test('player document validation preserves v1 copies and tolerates unknown fields', () => {
  const document = validPlayerDocument({
    capabilities: ['future-capability'],
    futureField: { enabled: true },
    decks: [{ ...validDeck, futureDeckField: 'ignored' }],
  });
  const validated = validatePlayerDocument(document);

  assert.deepEqual(validated, { decks: [validDeck], unsupportedDecks: [] });
  assert.notEqual(validated.decks[0], document.decks[0]);
  assert.notEqual(validated.decks[0].clickTotals, document.decks[0].clickTotals);
});

test('player document v2 requires revision-query playback on every supported deck', () => {
  const document = validPlayerDocumentV2({
    futureField: true,
    decks: [
      {
        ...validDeck,
        playback: { kind: 'revision-query', parameter: 'revision', futurePlaybackField: true },
        futureDeckField: 'ignored',
      },
      {
        ...validDeck,
        id: 'course/topic-2',
        entry: '/course/topic-2/1',
        playback: { kind: 'revision-query', parameter: 'revision' },
      },
    ],
  });

  assert.deepEqual(validatePlayerDocument(document), {
    decks: [
      {
        ...validDeck,
        playback: { kind: 'revision-query', parameter: 'revision' },
      },
      {
        ...validDeck,
        id: 'course/topic-2',
        entry: '/course/topic-2/1',
        playback: { kind: 'revision-query', parameter: 'revision' },
      },
    ],
    unsupportedDecks: [],
  });
});

test('player document validation rejects unsupported versions and malformed wire fields', () => {
  assert.throws(
    () => validatePlayerDocument(validPlayerDocument({ schemaVersion: 3 })),
    /native-player\.json schemaVersion must be 1 or 2/u,
  );
  assert.throws(
    () => validatePlayerDocument(validPlayerDocumentV2({ decks: [] })),
    /no supported decks/u,
  );
  assert.throws(
    () => validatePlayerDocument(validPlayerDocumentV2({ decks: [{ ...validDeck }] })),
    /playback must be an object/u,
  );
  assert.throws(
    () =>
      validatePlayerDocument(
        validPlayerDocumentV2({
          decks: [{ ...validDeck, playback: { kind: 'path', parameter: 'revision' } }],
        }),
      ),
    /playback kind must be revision-query/u,
  );
  assert.throws(
    () =>
      validatePlayerDocument(
        validPlayerDocumentV2({
          decks: [{ ...validDeck, playback: { kind: 'revision-query', parameter: 'build' } }],
        }),
      ),
    /playback parameter must be revision/u,
  );
  assert.throws(
    () =>
      validatePlayerDocument(validPlayerDocumentV2({ decks: [{ ...validDeck, revision: '  ' }] })),
    /revision must be a non-empty string/u,
  );
  assert.throws(
    () =>
      validatePlayerDocument(
        validPlayerDocumentV2({
          decks: [{ ...validDeck, entry: '/course/topic-1/1?revision=build-17' }],
        }),
      ),
    /entry must be exactly \/course\/topic-1\/1/u,
  );
  assert.throws(
    () => validatePlayerDocument(validPlayerDocument({ protocolVersion: 2 })),
    /native-player\.json protocolVersion must be 1/u,
  );
  assert.throws(() => validatePlayerDocument(null), /must contain a JSON object/u);
  assert.throws(
    () =>
      validatePlayerDocument(validPlayerDocument({ decks: [{ ...validDeck, clickTotals: [] }] })),
    /clickTotals must be a non-empty array/u,
  );
});

test('catalog validation checks current shape and finite JSON metadata', () => {
  const catalog = validCatalog();
  assert.equal(validateCatalog(catalog), catalog);
  assert.throws(
    () => validateCatalog(validCatalog({ schemaVersion: 2 })),
    /catalog\.json schemaVersion must be 1/u,
  );
  assert.throws(
    () => validateCatalog(validCatalog({ decks: [{ ...catalog.decks[0], pages: 0 }] })),
    /pages must be a positive integer/u,
  );
  assert.throws(
    () =>
      validateCatalog(
        validCatalog({ decks: [{ ...catalog.decks[0], frontmatter: { score: Number.NaN } }] }),
      ),
    /frontmatter must contain finite JSON values/u,
  );
  assert.throws(
    () =>
      validateCatalog(
        validCatalog({
          decks: [{ ...catalog.decks[0], thumbnail: { ...catalog.decks[0].thumbnail, width: 0 } }],
        }),
      ),
    /thumbnail width must be a positive integer/u,
  );
});

test('bridge guards enforce field types, action names, and integer bounds', () => {
  assert.equal(
    isNativeFrameState({ deckId: 'course/topic-1', page: 1, clickIndex: 0, sessionRevision: 0 }),
    true,
  );
  for (const field of [
    { page: 0 },
    { clickIndex: -1 },
    { sessionRevision: -1 },
    { sessionRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(
      isNativeFrameState({
        deckId: 'course/topic-1',
        page: 1,
        clickIndex: 0,
        sessionRevision: 0,
        ...field,
      }),
      false,
    );

  assert.equal(isNativeNavigationAction('next'), true);
  assert.equal(isNativeNavigationAction('selectDeck'), false);
  assert.equal(
    isNativeBridgeReady({
      protocolVersion: 2,
      deckId: 'course/topic-1',
      documentToken: 't',
      mount: null,
    }),
    true,
    'well-formed future versions remain distinguishable from malformed ready messages',
  );
  assert.equal(
    isNativeBridgeReady({
      protocolVersion: 1,
      deckId: 'course/topic-1',
      documentToken: 't',
      mount: 4,
    }),
    false,
  );
  assert.equal(
    isNativeBridgeFailure({ documentToken: 't', mount: null, message: 'failure' }),
    true,
  );
  assert.equal(
    isNativeBridgeFailure({ documentToken: 't', mount: false, message: 'failure' }),
    false,
  );
  assert.equal(isNativeBridgeDiagnostic({ console: 'warn', message: 'warning', extra: 1 }), true);
  assert.equal(
    isNativeBridgeDiagnostic({ error: 'resource error', source: undefined }),
    true,
    'undefined optional diagnostics fields are emitted by the classic bridge',
  );
  assert.equal(isNativeBridgeDiagnostic({ console: 'debug' }), false);
});

test('rendered report guard checks nested elements and bounded state fields', () => {
  const report = {
    url: 'https://slides.example.test/course/topic-1/1',
    deckId: 'course/topic-1',
    page: 1,
    clickIndex: 0,
    sessionRevision: 1,
    documentToken: 't',
    loaded: true,
    text: 'Topic 1',
    clickElements: [{ text: null, visible: true }],
  };
  assert.equal(isNativeRenderedReport(report), true);
  assert.equal(
    isNativeRenderedReport({ ...report, runtimeVersion: undefined, theme: undefined }),
    true,
    'the classic bridge may include undefined optional runtime metadata',
  );
  assert.equal(isNativeRenderedReport({ ...report, sessionRevision: -1 }), false);
  assert.equal(
    isNativeRenderedReport({ ...report, clickElements: [{ text: 1, visible: true }] }),
    false,
  );
});

test('bridge public export is a standalone classic script', async () => {
  const source = await readFile(new URL('../dist/deck-bridge.js', import.meta.url), 'utf8');
  assert.match(source, /nativeBridgeReady/u);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/mu);
});
