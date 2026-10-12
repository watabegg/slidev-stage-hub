import type { PublicationStore } from '@slidock/server';

type MemoryPublicationDeckState = { generation: bigint; current: unknown | null };
type MemoryPublicationState = { decks: Map<string, MemoryPublicationDeckState> };

/** Shared implementation for the standalone and paired in-memory publication stores. */
export function createMemoryPublicationStoreWithState(
  state: MemoryPublicationState,
  onBegin?: (deckId: string, generation: bigint, now: string) => void,
): PublicationStore {
  return {
    async begin(deckId) {
      const deck = state.decks.get(deckId) ?? { generation: 0n, current: null };
      deck.generation += 1n;
      state.decks.set(deckId, deck);
      onBegin?.(deckId, deck.generation, new Date().toISOString());
      return deck.generation.toString();
    },
    async current(deckId) {
      const value = state.decks.get(deckId)?.current ?? null;
      return value === null ? null : structuredClone(value);
    },
    async commit(deckId, token, manifest) {
      const deck = state.decks.get(deckId);
      if (!deck || !/^(0|[1-9]\d*)$/u.test(token) || BigInt(token) !== deck.generation)
        return false;
      deck.current = structuredClone(manifest);
      return true;
    },
  };
}

export function createMemoryPublicationStore(): PublicationStore {
  return createMemoryPublicationStoreWithState({ decks: new Map() });
}
