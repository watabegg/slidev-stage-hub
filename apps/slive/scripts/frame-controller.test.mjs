import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/frame-controller.ts', import.meta.url));
const compiled = await build({
  entryPoints: [source],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
});

class FakeFrame {
  constructor(id) {
    this.id = id;
    this.src = '';
    this.listeners = new Map();
    this.messages = [];
    this.contentWindow = { postMessage: (...message) => this.messages.push(message) };
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  dispatch(name) {
    this.listeners.get(name)?.();
  }
}

function createController({ decks = [] } = {}) {
  const timerIds = new Set();
  let nextTimerId = 0;
  const window = {
    setTimeout() {
      const id = ++nextTimerId;
      timerIds.add(id);
      return id;
    },
    clearTimeout(id) {
      timerIds.delete(id);
    },
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    location: { origin: 'tauri://localhost' },
    performance: { now: () => 12 },
    window,
  });
  vm.runInContext(compiled.outputFiles[0].text, context);
  const frame = new FakeFrame('deck');
  const controller = new window.NativeFrameController(frame, {
    origin: 'https://slides.example.test',
    decks,
  });
  return { controller, frame, timerIds };
}

const state = (overrides = {}) => ({
  deckId: 'course/topic-one',
  revision: 'revision-A',
  page: 1,
  clickIndex: 0,
  blackout: false,
  sessionRevision: 1,
  timer: { elapsedMs: 0, startedAt: null },
  ...overrides,
});

const playbackDeck = {
  id: 'course/topic-one',
  revision: 'revision-A',
  entry: '/course/topic-one/1',
  clickTotals: [0, 1],
  playback: { kind: 'revision-query', parameter: 'revision' },
};

function reportFor(overrides = {}) {
  return {
    url: 'https://slides.example.test/course/topic-one/1?revision=revision-A',
    deckId: 'course/topic-one',
    page: 1,
    clickIndex: 0,
    sessionRevision: 1,
    documentToken: 'document-1',
    loaded: true,
    text: 'Topic one',
    clickElements: [],
    ...overrides,
  };
}

test('revision-query frames pin the content URL, retain native flags, and reject mismatched acknowledgements', () => {
  const { controller, frame, timerIds } = createController({ decks: [playbackDeck] });
  const initial = state();
  controller.update(initial);
  const initialUrl = new URL(frame.src);
  assert.equal(initialUrl.searchParams.get('revision'), 'revision-A');
  assert.equal(initialUrl.searchParams.get('clicks'), '0');
  assert.equal(initialUrl.searchParams.get('embedded'), 'true');
  assert.equal(initialUrl.searchParams.get('nativeProtocol'), '1');
  assert.equal(initialUrl.searchParams.get('nativeParentOrigin'), 'tauri://localhost');

  const mount = initialUrl.searchParams.get('nativeMount');
  const readyEvent = {
    source: frame.contentWindow,
    origin: 'https://slides.example.test',
    data: {
      nativeBridgeReady: {
        protocolVersion: 1,
        deckId: initial.deckId,
        documentToken: 'document-1',
        mount,
      },
    },
  };
  assert.equal(controller.message(readyEvent), true);
  const timer = controller.active.timer;
  assert.equal(timerIds.has(timer), true);

  const mismatched = reportFor({
    url: 'https://slides.example.test/course/topic-one/1?revision=revision-B',
  });
  assert.equal(controller.message({ ...readyEvent, data: { nativeRendered: mismatched } }), true);
  assert.equal(controller.stats.acknowledgements, 0);
  assert.equal(controller.active.timer, timer);
  assert.equal(timerIds.has(timer), true);

  frame.dispatch('load');
  assert.equal(frame.messages.length, 2, 'a repeated load resends state without changing src');
  assert.equal(new URL(frame.src).searchParams.get('revision'), 'revision-A');

  const accepted = reportFor();
  controller.message({ ...readyEvent, data: { nativeRendered: accepted } });
  assert.equal(controller.stats.acknowledgements, 1);
  assert.equal(controller.active.timer, null);
  assert.equal(timerIds.has(timer), false);
});

test('v1 frames keep their original URL and do not require a revision query in acknowledgements', () => {
  const v1Deck = { ...playbackDeck };
  delete v1Deck.playback;
  const { controller, frame } = createController({ decks: [v1Deck] });
  const initial = state();
  controller.update(initial);
  const url = new URL(frame.src);
  assert.equal(url.searchParams.has('revision'), false);

  const mount = url.searchParams.get('nativeMount');
  const event = {
    source: frame.contentWindow,
    origin: 'https://slides.example.test',
    data: {
      nativeBridgeReady: {
        protocolVersion: 1,
        deckId: initial.deckId,
        documentToken: 'document-1',
        mount,
      },
    },
  };
  controller.message(event);
  controller.message({
    ...event,
    data: {
      nativeRendered: reportFor({
        url: 'https://slides.example.test/course/topic-one/1',
      }),
    },
  });
  assert.equal(controller.stats.acknowledgements, 1);
});
