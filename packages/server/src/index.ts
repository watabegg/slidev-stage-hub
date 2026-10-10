import { handleRequest } from './worker-handler.js';
import type { HubServerOptions } from './ports.js';

export function createHubServer(options: HubServerOptions): {
  fetch(request: Request): Promise<Response>;
} {
  return { fetch: (request) => handleRequest(request, options) };
}

export * from './ports.js';
export { runtimeSnapshotFromManifest, auditRuntimeRetention } from './runtime.js';
export { publishDeck, type PublishResult } from './publish.js';
export { compileDeck, DeckCompileError } from './compiler.js';
export type { CompileDeckInput, CompileDeckResult, NativeClickMetadata } from './compiler.js';
export { WorkerError, errorResponse } from './errors.js';
export type { ErrorPhase } from './errors.js';
export type { ReleaseManifest, ReleaseSlide } from './manifest.js';
