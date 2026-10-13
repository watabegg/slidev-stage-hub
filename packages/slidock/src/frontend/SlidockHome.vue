<script setup lang="ts">
import { computed, useId } from 'vue';
import type { Catalog, CatalogCategory, CatalogDeck } from '@slidock/slidock/client';
import type { VNode } from 'vue';
import SlideCard from './SlideCard.vue';
import CategoryNav from './CategoryNav.vue';

const brandIcon = new URL('./assets/slidock.svg', import.meta.url).href;
const props = withDefaults(defineProps<{
  catalog: Catalog;
  title?: string;
  logo?: string | false;
  homeHref?: string;
  categoryLabels?: Record<string, string>;
  deckHref?: (deck: CatalogDeck) => string;
}>(), { title: 'Slidock', homeHref: '/', logo: undefined });
const selected = defineModel<string>('category', { default: '' });
const listId = `slidock-slides-${useId()}`;
const categoryLabel = (id: string) => props.categoryLabels?.[id] ?? props.catalog.categories.find(category => category.id === id)?.name ?? id;
const decks = computed(() => props.catalog.decks.filter(deck => !selected.value || deck.categoryPath.join('/') === selected.value || deck.categoryPath.join('/').startsWith(`${selected.value}/`)));
const groups = computed(() => {
  const result = new Map<string, CatalogDeck[]>();
  for (const deck of decks.value) {
    const category = deck.categoryPath.join('/');
    const group = result.get(category) ?? [];
    group.push(deck);
    result.set(category, group);
  }
  return Array.from(result, ([id, items]) => ({ id, label: id ? categoryLabel(id) : '未分類', decks: items }));
});
const hrefFor = (deck: CatalogDeck) => props.deckHref?.(deck) ?? deck.entry;
const selectCategory = (category: string) => { selected.value = category; };
defineSlots<{
  brand?(props: { title: string; href: string }): VNode[];
  nav?(): VNode[];
  header?(): VNode[];
  sidebar?(props: { categories: CatalogCategory[]; selected: string; select: (category: string) => void }): VNode[];
  'category-heading'?(props: { id: string; label: string; decks: CatalogDeck[] }): VNode[];
  card?(props: { deck: CatalogDeck; href: string }): VNode[];
  empty?(): VNode[];
  footer?(): VNode[];
}>();
</script>
<template>
  <div class="library">
    <a class="skip-link" :href="`#${listId}`">スライド一覧へ</a>
    <header class="library-header">
      <nav class="navbar" aria-label="メインナビゲーション">
        <slot name="brand" :title="title" :href="homeHref">
          <a class="brand" :href="homeHref">
            <img v-if="logo !== false" :src="logo ?? brandIcon" width="36" height="36" alt="" />
            <span>{{ title }}</span>
          </a>
        </slot>
        <a class="slides-link" :href="`#${listId}`">スライド</a>
        <div v-if="$slots.nav" class="navbar-links"><slot name="nav" /></div>
      </nav>
    </header>
    <slot name="header" />
    <div :id="listId" class="library-layout">
      <slot
        name="sidebar"
        :categories="catalog.categories"
        :selected="selected"
        :select="selectCategory"
      >
        <CategoryNav
          v-model="selected"
          :categories="catalog.categories"
          :total="catalog.decks.length"
          :labels="categoryLabels"
        />
      </slot>
      <main class="library-main" aria-label="スライド一覧">
        <div class="category-groups" aria-live="polite">
          <section
            v-for="group in groups"
            :key="group.id"
            class="deck-group"
            :aria-label="group.label"
          >
            <div class="section-heading">
              <slot
                name="category-heading"
                :id="group.id"
                :label="group.label"
                :decks="group.decks"
              >
                <h2>{{ group.label }}</h2>
                <span>{{ group.decks.length }}</span>
              </slot>
            </div>
            <div class="deck-grid">
              <template v-for="deck in group.decks" :key="deck.id">
                <slot name="card" :deck="deck" :href="hrefFor(deck)">
                  <SlideCard :deck="deck" :href="hrefFor(deck)" />
                </slot>
              </template>
            </div>
          </section>
        </div>
        <template v-if="!decks.length">
          <slot name="empty"><p class="empty-library">スライドがありません。</p></slot>
        </template>
      </main>
    </div>
    <footer v-if="$slots.footer" class="library-footer"><slot name="footer" /></footer>
  </div>
</template>
