import type { NativeDeckPlayback, PlayerDocumentV2 } from '@slidock/protocol/contracts';
import { WorkerError } from './errors.js';
import { isRecord, type ReleaseManifest } from './manifest.js';
import { loadCurrentManifests, readIndexPage } from './catalog.js';
import type { HubServerOptions } from './ports.js';

const MAX_DISCOVERY_OBJECTS = 1000;
const UNSUPPORTED_REASON = 'This deck uses features the native player cannot render.';
const REVISION_QUERY_PLAYBACK: NativeDeckPlayback = {
  kind: 'revision-query',
  parameter: 'revision',
};

export async function readNativePlayerDocument(env: HubServerOptions): Promise<PlayerDocumentV2> {
  const manifests: ReleaseManifest[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let visited = 0;

  for (;;) {
    const remaining = MAX_DISCOVERY_OBJECTS - visited;
    if (remaining <= 0) {
      throw new WorkerError(503, 'discovery', 'Deck discovery exceeded the 1000 item limit');
    }
    const page = await readIndexPage(
      env.artifacts,
      { limit: Math.min(remaining, MAX_DISCOVERY_OBJECTS), ...(cursor ? { cursor } : {}) },
      'discovery',
    );
    if (page.objects.length > remaining) {
      throw new WorkerError(503, 'discovery', 'Deck discovery exceeded the 1000 item limit');
    }
    visited += page.objects.length;
    if (page.truncated && visited >= MAX_DISCOVERY_OBJECTS) {
      throw new WorkerError(503, 'discovery', 'Deck discovery exceeded the 1000 item limit');
    }

    manifests.push(...(await loadCurrentManifests(env, page.objects, 'discovery')));
    if (!page.truncated) break;
    if (!page.cursor || seenCursors.has(page.cursor)) {
      throw new WorkerError(500, 'discovery', 'Deck discovery failed');
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }

  const decks: PlayerDocumentV2['decks'] = [];
  const unsupportedDecks: PlayerDocumentV2['unsupportedDecks'] = [];
  for (const manifest of manifests) {
    const clickTotals = readClickTotals(manifest.native, manifest.slides.length);
    if (clickTotals === null) {
      unsupportedDecks.push({ id: manifest.id, reason: UNSUPPORTED_REASON });
      continue;
    }
    decks.push({
      id: manifest.id,
      revision: manifest.revision,
      entry: `/${manifest.id}/1`,
      playback: REVISION_QUERY_PLAYBACK,
      clickTotals,
    });
  }

  return { schemaVersion: 2, protocolVersion: 1, decks, unsupportedDecks };
}

function readClickTotals(native: unknown, pageCount: number): number[] | null {
  if (!isRecord(native) || 'unsupportedReason' in native || !Array.isArray(native.clickTotals)) {
    return null;
  }
  if (native.clickTotals.length !== pageCount || pageCount === 0) return null;
  const clickTotals: number[] = [];
  for (const total of native.clickTotals as unknown[]) {
    if (
      typeof total !== 'number' ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > 0xffff_ffff
    ) {
      return null;
    }
    clickTotals.push(total);
  }
  return clickTotals;
}
