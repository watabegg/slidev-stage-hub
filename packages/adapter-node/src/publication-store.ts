import type { PublicationStore } from '@slidev-stage-hub/server';

export function createMemoryPublicationStore(): PublicationStore {
  const decks = new Map<string, { generation: number; current: unknown | null }>();
  return {
    async begin(deckId) {
      const state = decks.get(deckId) ?? { generation: 0, current: null };
      state.generation += 1;
      decks.set(deckId, state);
      return String(state.generation);
    },
    async current(deckId) {
      const value = decks.get(deckId)?.current ?? null;
      return value === null ? null : structuredClone(value);
    },
    async commit(deckId, token, manifest) {
      const state = decks.get(deckId);
      if (!state || token !== String(state.generation)) return false;
      state.current = structuredClone(manifest);
      return true;
    },
  };
}
