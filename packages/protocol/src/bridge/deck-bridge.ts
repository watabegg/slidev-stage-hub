import { isNativeFrameState } from '../contracts/guards.js';
import type { NativeFrameState, NativeNavigationAction } from '../contracts/wire.js';
import type { NativeSlidevQueryValue, NativeSlidevRuntime } from './types.js';

function isNativeMessageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

(() => {
  if (window.__nativeSlidevBridge) return;
  const params = new URLSearchParams(location.search);
  const parentOrigin = params.get('nativeParentOrigin');
  if (
    params.get('nativeProtocol') === '1' &&
    (parent === window || !parentOrigin || !params.get('nativeMount'))
  )
    return;
  // Installed before module/theme listeners by the local server or opt-in Web player.
  window.__nativeSlidevBridge = true;
  const preview = params.has('nativePreview');
  const deckId = location.pathname
    .replace(/\/\d+\/?$/, '')
    .replace(/^\//, '')
    .split('/')
    .map(decodeURIComponent)
    .join('/');
  const documentToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const post = (data: Record<string, unknown>): void =>
    parent.postMessage(data, parentOrigin && parentOrigin !== 'null' ? parentOrigin : '*');
  const editing = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    !!target.closest('input,textarea,select,[contenteditable=true],[contenteditable=""]');
  const actionFor = (key: string): NativeNavigationAction | null =>
    ['ArrowRight', 'ArrowDown', ' ', 'Enter', 'PageDown'].includes(key)
      ? 'next'
      : ['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp'].includes(key)
        ? 'previous'
        : ['b', 'B', '.'].includes(key)
          ? 'toggleBlackout'
          : null;
  let diagnosticCount = 0;
  for (const method of ['error', 'warn'] as const) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]) => {
      original(...args);
      if (diagnosticCount++ < 20) {
        post({
          nativeDiagnostic: { console: method, message: args.map(String).join(' ').slice(0, 1200) },
        });
      }
    };
  }
  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      const target = event.target;
      let source: string | undefined;
      if (target && 'src' in target && typeof target.src === 'string') source = target.src;
      if (!source && target && 'href' in target && typeof target.href === 'string')
        source = target.href;
      post({
        nativeDiagnostic: { error: event.message || 'resource error', source: source || undefined },
      });
    },
    true,
  );
  window.addEventListener('unhandledrejection', (event) => {
    post({ nativeDiagnostic: { rejection: String(event.reason) } });
  });
  const QuietBroadcastChannel = class {
    addEventListener(): void {}
    removeEventListener(): void {}
    postMessage(): void {}
    close(): void {}
  };
  window.BroadcastChannel = QuietBroadcastChannel as unknown as typeof BroadcastChannel;
  window.addEventListener(
    'keydown',
    (event) => {
      const kind = actionFor(event.key);
      // Native owns navigation even if a theme binds an extra key. Ordinary text
      // keeps its browser default, while later theme shortcut listeners are quiet.
      event.stopImmediatePropagation();
      if (!kind || editing(event.target)) return;
      event.preventDefault();
      if (!preview && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat) {
        post({ nativeInput: kind, documentToken });
      }
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (event) => {
      event.stopImmediatePropagation();
      if (actionFor(event.key) && !editing(event.target)) event.preventDefault();
    },
    true,
  );
  // Slidev also handles pointerdown and swipes; stop these before stock handlers.
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend']) {
    window.addEventListener(
      type,
      (event) => {
        if (!editing(event.target)) event.stopImmediatePropagation();
      },
      true,
    );
  }
  window.addEventListener(
    'click',
    (event) => {
      const eventTarget = event.target;
      const target =
        eventTarget instanceof Element
          ? eventTarget
          : eventTarget instanceof Node
            ? eventTarget.parentElement
            : null;
      if (!target) return;
      if (target.closest('nav')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (editing(target) || target.closest('a,button')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Pointer clicks do not advance a presentation; navigation uses explicit controls or keys.
    },
    true,
  );
  window.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  let latest: NativeFrameState | undefined;
  let attempting: NativeFrameState | undefined;
  let applying = false;
  let ready = false;
  const frame = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));
  async function bounded<Value>(promise: Promise<Value>): Promise<Value> {
    let timer: number | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error('slide assets did not load within 12 seconds')),
            12000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }
  function runtime(): NativeSlidevRuntime | undefined {
    return window.__slidevLabNative;
  }
  function currentSlide(page: number): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('#slide-content .slidev-page')].find(
      (slide) => {
        const style = getComputedStyle(slide);
        return (
          Number(slide.dataset.slidevNo) === page &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0 &&
          slide.getBoundingClientRect().width > 0 &&
          !slide.querySelector('.slidev-slide-loading') &&
          !slide.textContent!.includes('Loading slide...') &&
          !slide.textContent!.includes('Failed to fetch this slide.')
        );
      },
    );
  }
  async function applyLatest(): Promise<void> {
    if (applying || !ready || !latest) return;
    applying = true;
    try {
      while (latest) {
        const state: NativeFrameState = latest;
        attempting = state;
        const { router, slides } = runtime()!;
        const slideModule = slides[state.page - 1];
        if (!slideModule?.load) throw new Error('native runtime slide loader unavailable');
        const loaded = await bounded(slideModule.load());
        if (!loaded?.default) throw new Error('slide module failed to load');
        if (state !== latest) continue;
        const query: Record<string, NativeSlidevQueryValue> = {
          ...router.currentRoute.value.query,
          clicks: String(state.clickIndex),
          embedded: 'true',
        };
        if (preview) query.nativePreview = 'true';
        await router.replace({ path: `/${state.page}`, query });
        const deadline = performance.now() + 12000;
        let slide: HTMLElement | undefined;
        while (state === latest && !(slide = currentSlide(state.page))) {
          if (performance.now() > deadline) throw new Error('current slide did not become visible');
          await frame();
        }
        if (state !== latest) continue;
        await bounded(
          Promise.all([
            document.fonts?.ready || Promise.resolve(),
            ...[...slide!.querySelectorAll<HTMLImageElement>('img')].map((image) =>
              image.decode
                ? image.decode()
                : image.complete
                  ? Promise.resolve()
                  : new Promise<void>((resolve, reject) => {
                      image.addEventListener('load', () => resolve(), { once: true });
                      image.addEventListener('error', reject, { once: true });
                    }),
            ),
          ]),
        );
        if (state !== latest) continue;
        await frame();
        await frame();
        slide = currentSlide(state.page);
        if (state !== latest) continue;
        if (!slide || Number(router.currentRoute.value.query.clicks || 0) !== state.clickIndex) {
          throw new Error('rendered route differs from Rust state');
        }
        const canonical = new URL(location.href);
        for (const key of ['nativeMount', 'nativeProtocol', 'nativeParentOrigin'])
          canonical.searchParams.delete(key);
        post({
          nativeRendered: {
            url: canonical.href,
            deckId,
            page: state.page,
            clickIndex: state.clickIndex,
            sessionRevision: state.sessionRevision,
            documentToken,
            loaded: true,
            runtimeVersion: window.__slidevLab?.runtimeVersion,
            theme: window.__slidevLab?.theme,
            text: slide.textContent!.slice(0, 600),
            clickElements: [...slide.querySelectorAll<HTMLElement>('.slidev-vclick-target')].map(
              (element) => ({
                text: element.textContent,
                visible:
                  getComputedStyle(element).visibility !== 'hidden' &&
                  getComputedStyle(element).opacity !== '0',
              }),
            ),
          },
        });
        for (const index of [state.page - 2, state.page]) {
          slides[index]?.load!().catch((error) =>
            post({ nativeDiagnostic: { prefetch: String(error) } }),
          );
        }
        if (state === latest) break;
      }
    } catch (error) {
      if (attempting === latest) {
        post({
          nativeFailure: {
            documentToken,
            mount: params.get('nativeMount'),
            message: String(error),
          },
        });
      }
    } finally {
      applying = false;
      if (attempting !== latest) applyLatest();
    }
  }
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (
      event.source !== parent ||
      (parentOrigin && event.origin !== parentOrigin) ||
      !isNativeMessageRecord(event.data)
    )
      return;
    const data = event.data;
    const state = data.nativeState;
    if (
      isNativeFrameState(state) &&
      state.deckId === deckId &&
      (!latest || state.sessionRevision > latest.sessionRevision)
    ) {
      latest = { ...state };
      applyLatest();
    }
    if (typeof data.nativeTestKey === 'string') {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: data.nativeTestKey,
          repeat: !!data.repeat,
          bubbles: true,
        }),
      );
    }
    if (typeof data.nativeTestKeyUp === 'string') {
      window.dispatchEvent(
        new KeyboardEvent('keyup', { key: data.nativeTestKeyUp, bubbles: true }),
      );
    }
    if (data.nativeTestSlideClick) {
      document
        .querySelector('.slidev-page')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    if (data.nativeTestNavClick) {
      document
        .querySelector('#app nav button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });
  async function start(): Promise<void> {
    const style = document.createElement('style');
    style.textContent = '#app nav{display:none!important}';
    document.head.append(style);
    const deadline = performance.now() + 12000;
    while (!runtime()?.router || !runtime()?.slides) {
      if (performance.now() > deadline) {
        post({
          nativeFailure: {
            documentToken,
            mount: params.get('nativeMount'),
            message: 'native runtime hook unavailable',
          },
        });
        return;
      }
      await frame();
    }
    ready = true;
    post({
      nativeBridgeReady: {
        protocolVersion: 1,
        deckId,
        documentToken,
        mount: params.get('nativeMount'),
      },
    });
    applyLatest();
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
