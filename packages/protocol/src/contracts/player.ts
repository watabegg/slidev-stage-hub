export interface NativeDeck {
  id: string;
  revision: string;
  entry: string;
  clickTotals: number[];
}

export interface PlayerDocument {
  schemaVersion: 1;
  protocolVersion: 1;
  decks: NativeDeck[];
  unsupportedDecks: Array<{ id: string; reason: string }>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNativeDeckId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(id);
}

function validateDeckId(id: unknown, label: string, seenIds: Set<string>): asserts id is string {
  if (!isNativeDeckId(id))
    throw new Error(
      `${label} id must use non-empty ASCII letters, numbers, underscores, or hyphens in slash-separated segments`,
    );
  if (seenIds.has(id))
    throw new Error(`duplicate deck id ${JSON.stringify(id)} in native-player.json`);
  seenIds.add(id);
}

/** Validate native-player.json while returning only the fields Stage consumes. */
export function validatePlayerDocument(
  document: unknown,
): Pick<PlayerDocument, 'decks' | 'unsupportedDecks'> {
  if (!isPlainObject(document)) throw new Error('native-player.json must contain a JSON object');
  if (document.schemaVersion !== 1) throw new Error('native-player.json schemaVersion must be 1');
  if (document.protocolVersion !== 1)
    throw new Error('native-player.json protocolVersion must be 1');
  if (!Array.isArray(document.decks)) throw new Error('native-player.json decks must be an array');
  if (!Array.isArray(document.unsupportedDecks))
    throw new Error('native-player.json unsupportedDecks must be an array');

  const seenIds = new Set<string>();
  const decks = document.decks.map((deck, index): NativeDeck => {
    const label = `deck ${index + 1}`;
    if (!isPlainObject(deck)) throw new Error(`${label} must be an object`);
    validateDeckId(deck.id, label, seenIds);
    if (typeof deck.revision !== 'string' || deck.revision.trim().length === 0)
      throw new Error(`${label} ${deck.id} revision must be a non-empty string`);
    const expectedEntry = `/${deck.id}/1`;
    if (deck.entry !== expectedEntry)
      throw new Error(`${label} ${deck.id} entry must be exactly ${expectedEntry}`);
    if (!Array.isArray(deck.clickTotals) || deck.clickTotals.length === 0)
      throw new Error(`${label} ${deck.id} clickTotals must be a non-empty array`);
    for (const [pageIndex, total] of deck.clickTotals.entries()) {
      if (!Number.isSafeInteger(total) || (total as number) < 0 || (total as number) > 0xffff_ffff)
        throw new Error(
          `${label} ${deck.id} clickTotals[${pageIndex}] must be a safe non-negative u32 integer`,
        );
    }
    return {
      id: deck.id,
      revision: deck.revision,
      entry: deck.entry,
      clickTotals: [...deck.clickTotals] as number[],
    };
  });
  if (decks.length === 0) throw new Error('native-player.json has no supported decks');

  const unsupportedDecks = document.unsupportedDecks.map((deck, index) => {
    const label = `unsupportedDecks[${index}]`;
    if (!isPlainObject(deck)) throw new Error(`${label} must be an object`);
    if (typeof deck.id !== 'string' || deck.id.length === 0)
      throw new Error(`${label} id must be a non-empty string`);
    if (seenIds.has(deck.id))
      throw new Error(`duplicate deck id ${JSON.stringify(deck.id)} in native-player.json`);
    seenIds.add(deck.id);
    if (typeof deck.reason !== 'string')
      throw new Error(`${label} ${deck.id} reason must be a string`);
    return { id: deck.id, reason: deck.reason };
  });

  return { decks, unsupportedDecks };
}
