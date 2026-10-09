import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectDeckSource } from './inspect-deck.mjs';

// Static discovery API. Never include source paths, note text or note mappings.
export async function nativePlayerManifest(decks, root, parseSync) {
  const supported = [],
    unsupportedDecks = [];
  for (const deck of decks) {
    try {
      if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(deck.id))
        throw new Error('Native PoC requires ASCII deck IDs');
      const source = resolve(root, deck.sourcePath);
      const inspection = inspectDeckSource({
        id: deck.id,
        source,
        text: await readFile(source, 'utf8'),
        parseSync,
        expectedPages: deck.pages,
      });
      supported.push({
        id: deck.id,
        revision: deck.revision,
        entry: deck.entry,
        clickTotals: inspection.clickTotals,
      });
    } catch {
      // Parser errors may contain private paths/source; keep the public reason fixed.
      unsupportedDecks.push({
        id: deck.id,
        reason:
          'Native PoC requires ASCII IDs and simple v-click slides with matching source pages.',
      });
    }
  }
  return { schemaVersion: 1, protocolVersion: 1, decks: supported, unsupportedDecks };
}
