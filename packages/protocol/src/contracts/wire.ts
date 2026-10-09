export type NativeNavigationAction = 'next' | 'previous' | 'toggleBlackout';

export interface NativeFrameState {
  deckId: string;
  page: number;
  clickIndex: number;
  sessionRevision: number;
}

export interface NativeBridgeReady {
  protocolVersion: number;
  deckId: string;
  documentToken: string;
  mount: string | null;
}

export interface NativeBridgeFailure {
  documentToken: string;
  mount: string | null;
  message: string;
}

export interface NativeBridgeDiagnostic {
  console?: 'error' | 'warn';
  message?: string;
  error?: string;
  source?: string;
  rejection?: string;
  prefetch?: string;
}

export interface NativeClickElement {
  text: string | null;
  visible: boolean;
}

export interface NativeRenderedReport {
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
