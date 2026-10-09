import type {
  NativeBridgeDiagnostic,
  NativeBridgeFailure,
  NativeBridgeReady,
  NativeClickElement,
  NativeFrameState,
  NativeNavigationAction,
  NativeRenderedReport,
} from './wire.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isNativeNavigationAction(value: unknown): value is NativeNavigationAction {
  return value === 'next' || value === 'previous' || value === 'toggleBlackout';
}

export function isNativeFrameState(value: unknown): value is NativeFrameState {
  return (
    isRecord(value) &&
    typeof value.deckId === 'string' &&
    isPositiveSafeInteger(value.page) &&
    isNonNegativeSafeInteger(value.clickIndex) &&
    isNonNegativeSafeInteger(value.sessionRevision)
  );
}

export function isNativeBridgeReady(value: unknown): value is NativeBridgeReady {
  return (
    isRecord(value) &&
    isPositiveSafeInteger(value.protocolVersion) &&
    typeof value.deckId === 'string' &&
    typeof value.documentToken === 'string' &&
    (typeof value.mount === 'string' || value.mount === null)
  );
}

export function isNativeBridgeFailure(value: unknown): value is NativeBridgeFailure {
  return (
    isRecord(value) &&
    typeof value.documentToken === 'string' &&
    (typeof value.mount === 'string' || value.mount === null) &&
    typeof value.message === 'string'
  );
}

export function isNativeBridgeDiagnostic(value: unknown): value is NativeBridgeDiagnostic {
  if (!isRecord(value)) return false;
  if (
    'console' in value &&
    value.console !== undefined &&
    value.console !== 'error' &&
    value.console !== 'warn'
  )
    return false;
  for (const field of ['message', 'error', 'source', 'rejection', 'prefetch'])
    if (field in value && value[field] !== undefined && typeof value[field] !== 'string')
      return false;
  return true;
}

export function isNativeClickElement(value: unknown): value is NativeClickElement {
  return (
    isRecord(value) &&
    (typeof value.text === 'string' || value.text === null) &&
    typeof value.visible === 'boolean'
  );
}

export function isNativeRenderedReport(value: unknown): value is NativeRenderedReport {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    typeof value.deckId === 'string' &&
    isPositiveSafeInteger(value.page) &&
    isNonNegativeSafeInteger(value.clickIndex) &&
    isNonNegativeSafeInteger(value.sessionRevision) &&
    typeof value.documentToken === 'string' &&
    typeof value.loaded === 'boolean' &&
    (!('runtimeVersion' in value) ||
      value.runtimeVersion === undefined ||
      typeof value.runtimeVersion === 'string') &&
    (!('theme' in value) || value.theme === undefined || typeof value.theme === 'string') &&
    typeof value.text === 'string' &&
    Array.isArray(value.clickElements) &&
    value.clickElements.every(isNativeClickElement) &&
    (!('nativeReadyLatencyMs' in value) ||
      value.nativeReadyLatencyMs === undefined ||
      (typeof value.nativeReadyLatencyMs === 'number' &&
        Number.isFinite(value.nativeReadyLatencyMs) &&
        value.nativeReadyLatencyMs >= 0))
  );
}
