type NativeNavigationAction = 'next' | 'previous' | 'toggleBlackout';
type NativeActionKind = NativeNavigationAction | 'toggleTimer' | 'resetTimer' | 'selectDeck';

type NativeAction =
  | { kind: NativeNavigationAction | 'toggleTimer' | 'resetTimer' }
  | { kind: 'selectDeck'; value: string };

interface NativeDeck {
  id: string;
  revision: string;
  entry: string;
  clickTotals: number[];
}

interface NativeTimer {
  elapsedMs: number;
  startedAt: number | null;
}

interface NativeSession {
  deckId: string;
  revision: string;
  page: number;
  clickIndex: number;
  blackout: boolean;
  sessionRevision: number;
  timer: NativeTimer;
}

interface NativeTransitionInput {
  source: string;
  sequence: number;
  editing: boolean;
  action: NativeAction;
}

interface NativeSnapshot {
  session: NativeSession;
  decks: NativeDeck[];
  viewerOrigin: string;
  notesAvailable: boolean;
  notesMode: 'markdown' | 'sidecar';
  sourceOrigin: string | null;
}

interface NativeNoteView {
  text: string;
  revision: string;
  page: number;
  deckId: string;
  sourceChanged: boolean;
}

interface NativeDisplay {
  index: number;
  name: string | null;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
}

interface NativeCommandMap {
  snapshot: { args: undefined; result: NativeSnapshot };
  transition: { args: { input: NativeTransitionInput }; result: NativeSession };
  read_notes: { args: { deckId: string; page: number }; result: NativeNoteView };
  save_notes: {
    args: { deckId: string; page: number; expectedRevision: string; text: string };
    result: string;
  };
  qa_reopen_notes: { args: { deckId: string; page: number }; result: NativeNoteView };
  qa_audience_next: { args: undefined; result: void };
  viewer_ready: { args: { report: Record<string, unknown> }; result: void };
  capture: {
    args: { label: 'audience' | 'presenter'; name: string };
    result: string | void;
  };
  displays: { args: undefined; result: NativeDisplay[] };
  swap_windows: { args: undefined; result: string };
  audience_display: {
    args: { index: number | null; fullscreen: boolean };
    result: string;
  };
}

type NativeTauriInvoke = <Command extends keyof NativeCommandMap>(
  command: Command,
  ...args: NativeCommandMap[Command]['args'] extends undefined
    ? []
    : [args: NativeCommandMap[Command]['args']]
) => Promise<NativeCommandMap[Command]['result']>;

interface NativeTauriEvent<Payload> {
  event: string;
  id: number;
  payload: Payload;
}

type NativeTauriListen = (
  event: 'session',
  handler: (event: NativeTauriEvent<NativeSession>) => void,
) => Promise<() => void>;

interface NativeFrameState {
  deckId: string;
  page: number;
  clickIndex: number;
  sessionRevision: number;
}

interface NativeBridgeReady {
  protocolVersion: number;
  deckId: string;
  documentToken: string;
  mount: string | null;
}

interface NativeBridgeFailure {
  documentToken: string;
  mount: string | null;
  message: string;
}

interface NativeBridgeDiagnostic {
  console?: 'error' | 'warn';
  message?: string;
  error?: string;
  source?: string;
  rejection?: string;
  prefetch?: string;
}

interface NativeClickElement {
  text: string | null;
  visible: boolean;
}

interface NativeRenderedReport {
  url: string;
  deckId: string;
  page: number;
  clickIndex: number;
  sessionRevision: number;
  documentToken: string;
  loaded: boolean;
  runtimeVersion?: string;
  theme?: string;
  text: string;
  clickElements: NativeClickElement[];
  nativeReadyLatencyMs?: number;
}

interface NativeFrameStats {
  documentLoads: number;
  swaps: number;
  acknowledgements: number;
  documentTokens: string[];
  readyLatenciesMs: number[];
}

interface NativeFrameCallbacks {
  onRendered?: (report: NativeRenderedReport, origin: string) => void;
  onInput?: (action: NativeNavigationAction) => void;
  onDiagnostic?: (diagnostic: NativeBridgeDiagnostic, origin: string) => void;
  onError?: (message: string) => void;
}

interface NativeFrameControllerInstance {
  readonly stats: NativeFrameStats;
  update(state: NativeSession): void;
  message(event: MessageEvent<unknown>): boolean;
}

type NativeDraft = { text: string; view: NativeNoteView };

interface NativePoc {
  action(kind: NativeActionKind, value?: string): Promise<void>;
  invoke: NativeTauriInvoke;
  getState(): NativeSession;
  getDrafts(): Record<string, NativeDraft>;
  rendered: Map<string, NativeRenderedReport>;
  getOrigin(): string;
  frames: NativeFrameControllerInstance;
}

type NativeSlidevQueryValue = string | number | null | undefined | (string | null)[];

interface NativeSlidevRuntime {
  router: {
    currentRoute: {
      value: { query: Record<string, NativeSlidevQueryValue> };
    };
    replace(location: {
      path: string;
      query: Record<string, NativeSlidevQueryValue>;
    }): Promise<unknown>;
  };
  slides: Array<{ load?: () => Promise<{ default?: unknown }> } | undefined>;
}

interface Window {
  __TAURI__: {
    core: { invoke: NativeTauriInvoke };
    event: { listen: NativeTauriListen };
  };
  NativeFrameController: new (
    frame: HTMLIFrameElement,
    options: { origin: string } & NativeFrameCallbacks,
  ) => NativeFrameControllerInstance;
  __nativeSlidevBridge?: boolean;
  __slidevLabNative?: NativeSlidevRuntime;
  __slidevLab?: { runtimeVersion?: string; theme?: string };
  __nativePoc?: NativePoc;
}
