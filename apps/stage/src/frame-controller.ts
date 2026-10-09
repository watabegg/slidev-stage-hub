// At most two documents per viewport. Only Rust state may change their routes.
interface NativeFrameSlot {
  frame: HTMLIFrameElement;
  deckId: string | null;
  ready: boolean;
  failed: boolean;
  token: string | null;
  mount: string | null;
  desired: NativeSession | null;
  timer: number | null;
  sendingRevision: number | null;
  sentAt: number | null;
}

interface NativeFrameControllerCallbacks {
  onRendered: (report: NativeRenderedReport, origin: string) => void;
  onInput: (action: NativeNavigationAction) => void;
  onDiagnostic: (diagnostic: NativeBridgeDiagnostic, origin: string) => void;
  onError: (message: string) => void;
}

// The controlled frame protocol is typed here; retain the existing runtime
// origin, mount, token and revision checks below.
interface NativeFrameMessage {
  nativeBridgeReady?: NativeBridgeReady;
  nativeFailure?: NativeBridgeFailure;
  nativeDiagnostic?: NativeBridgeDiagnostic;
  nativeInput?: NativeNavigationAction;
  documentToken?: string;
  nativeRendered?: NativeRenderedReport;
}

window.NativeFrameController = class implements NativeFrameControllerInstance {
  declare origin: string;
  declare callbacks: NativeFrameControllerCallbacks;
  declare preview: boolean;
  declare active: NativeFrameSlot;
  declare standby: NativeFrameSlot | null;
  declare latest: NativeSession | null;
  declare readonly stats: NativeFrameStats;

  constructor(
    frame: HTMLIFrameElement,
    { origin, onRendered = () => {}, onInput = () => {}, onDiagnostic = () => {}, onError = () => {} }:
      { origin: string } & NativeFrameCallbacks,
  ) {
    this.origin = origin;
    this.callbacks = { onRendered, onInput, onDiagnostic, onError };
    this.preview = frame.id === 'next-preview';
    this.active = this.slot(frame);
    this.standby = null;
    this.latest = null;
    this.stats = { documentLoads: 0, swaps: 0, acknowledgements: 0, documentTokens: [], readyLatenciesMs: [] };
  }

  slot(frame: HTMLIFrameElement): NativeFrameSlot {
    const slot: NativeFrameSlot = {
      frame,
      deckId: null,
      ready: false,
      failed: false,
      token: null,
      mount: null,
      desired: null,
      timer: null,
      sendingRevision: null,
      sentAt: null,
    };
    frame.addEventListener('load', () => {
      if (slot.ready) this.send(slot);
    });
    return slot;
  }

  update(state: NativeSession): void {
    if (this.latest && state.sessionRevision < this.latest.sessionRevision) return;
    this.latest = { ...state };
    if (this.active.deckId === state.deckId && !this.active.failed) {
      if (this.standby) this.cancel(this.standby);
      this.active.desired = this.latest;
      this.send(this.active);
      return;
    }
    let target: NativeFrameSlot;
    if (!this.active.deckId) target = this.active;
    else {
      if (!this.standby) {
        const frame = this.active.frame.cloneNode(false) as HTMLIFrameElement;
        frame.removeAttribute('src');
        frame.removeAttribute('id');
        frame.removeAttribute('hidden');
        frame.classList.add('native-standby');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        this.active.frame.after(frame);
        this.standby = this.slot(frame);
      }
      target = this.standby;
    }
    target.desired = this.latest;
    if (target.deckId === state.deckId && !target.failed) {
      this.send(target);
      return;
    }
    this.cancel(target);
    target.deckId = state.deckId;
    target.ready = false;
    target.failed = false;
    target.token = null;
    target.mount = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    target.sentAt = performance.now();
    target.desired = this.latest;
    const query = new URLSearchParams({
      clicks: String(state.clickIndex),
      embedded: 'true',
      nativeMount: target.mount,
      nativeProtocol: '1',
      nativeParentOrigin: location.origin,
    });
    if (this.preview) query.set('nativePreview', 'true');
    target.timer = window.setTimeout(() => this.fail(target, 'スライドの描画確認がタイムアウトしました'), 15000);
    target.frame.src = `${this.origin}/${state.deckId.split('/').map(encodeURIComponent).join('/')}/${state.page}?${query}`;
  }

  cancel(slot: NativeFrameSlot): void {
    if (slot.timer !== null) window.clearTimeout(slot.timer);
    slot.timer = null;
    slot.desired = null;
    slot.sendingRevision = null;
  }

  fail(slot: NativeFrameSlot, message: string): void {
    if (slot.timer !== null) window.clearTimeout(slot.timer);
    slot.timer = null;
    slot.failed = true;
    this.callbacks.onError(message);
  }

  send(slot: NativeFrameSlot): void {
    if (slot.ready && slot.desired) {
      if (slot.sendingRevision !== slot.desired.sessionRevision) {
        if (slot.timer !== null) window.clearTimeout(slot.timer);
        slot.timer = window.setTimeout(() => this.fail(slot, 'スライドの描画確認がタイムアウトしました'), 15000);
        slot.sendingRevision = slot.desired.sessionRevision;
        if (slot === this.active && slot.ready) slot.sentAt = performance.now();
      }
      slot.frame.contentWindow!.postMessage(
        { nativeState: slot.desired },
        this.origin.startsWith('http') ? this.origin : '*',
      );
    }
  }

  message(event: MessageEvent<unknown>): boolean {
    const slot = [this.active, this.standby].find(candidate => candidate && event.source === candidate.frame.contentWindow);
    // WebKit custom schemes can report null; the exact controlled WindowProxy
    // and its per-navigation mount token still gate every accepted report.
    if (!slot || !(event.origin === this.origin || (!this.origin.startsWith('http') && event.origin === 'null'))) return false;
    if (!event.data || typeof event.data !== 'object') return true;
    const data = event.data as NativeFrameMessage;
    if (data.nativeBridgeReady) {
      const ready = data.nativeBridgeReady;
      if (ready.deckId !== slot.deckId || ready.mount !== slot.mount) return true;
      if (ready.protocolVersion !== 1) {
        this.fail(slot, 'Web側のNative連携プロトコルが対応していません');
        return true;
      }
      if (slot.token !== ready.documentToken) {
        this.stats.documentLoads++;
        this.stats.documentTokens.push(ready.documentToken);
      }
      slot.ready = true;
      slot.token = ready.documentToken;
      this.send(slot);
    }
    if (data.nativeDiagnostic) this.callbacks.onDiagnostic(data.nativeDiagnostic, event.origin);
    if (data.nativeFailure
      && slot.desired?.sessionRevision === this.latest?.sessionRevision
      && (data.nativeFailure.documentToken === slot.token || data.nativeFailure.mount === slot.mount)) {
      this.fail(slot, data.nativeFailure.message);
    }
    if (data.nativeInput
      && data.documentToken === slot.token
      && slot === this.active
      && !this.preview
      && slot.ready
      && slot.deckId === this.latest?.deckId) {
      this.callbacks.onInput(data.nativeInput);
    }
    if (data.nativeRendered) {
      const report = data.nativeRendered;
      const desired = slot.desired;
      if (!desired
        || report.documentToken !== slot.token
        || !report.loaded
        || report.deckId !== desired.deckId
        || report.page !== desired.page
        || report.clickIndex !== desired.clickIndex
        || report.sessionRevision !== desired.sessionRevision
        || report.sessionRevision !== this.latest!.sessionRevision) return true;
      if (slot.timer !== null) window.clearTimeout(slot.timer);
      slot.timer = null;
      this.stats.acknowledgements++;
      report.nativeReadyLatencyMs = performance.now() - slot.sentAt!;
      this.stats.readyLatenciesMs.push(report.nativeReadyLatencyMs);
      if (this.stats.readyLatenciesMs.length > 100) this.stats.readyLatenciesMs.shift();
      if (slot === this.standby) {
        const old = this.active;
        const focused = document.activeElement === old.frame;
        const id = old.frame.id;
        old.frame.removeAttribute('id');
        old.frame.classList.add('native-standby');
        old.frame.setAttribute('aria-hidden', 'true');
        old.frame.tabIndex = -1;
        slot.frame.id = id;
        slot.frame.classList.remove('native-standby');
        slot.frame.removeAttribute('aria-hidden');
        slot.frame.removeAttribute('tabindex');
        this.active = slot;
        this.standby = old;
        this.stats.swaps++;
        this.cancel(old);
        if (focused && !this.preview) slot.frame.focus();
      }
      this.callbacks.onRendered(report, event.origin);
    }
    return true;
  }
};
