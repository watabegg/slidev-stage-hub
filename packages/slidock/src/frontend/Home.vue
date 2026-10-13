<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Catalog, CatalogDeck, JsonValue } from '@slidock/slidock/client';

const brandIcon = new URL('./assets/slidock.svg', import.meta.url).href;

const props = defineProps<{
  catalog: Catalog;
  homeHref?: string;
  homeLabel?: string;
  deckHref?: (deck: CatalogDeck) => string;
}>();
const selected = ref('');
const decks = computed(() =>
  props.catalog.decks.filter(
    (deck) =>
      !selected.value ||
      deck.categoryPath.join('/') === selected.value ||
      deck.categoryPath.join('/').startsWith(`${selected.value}/`),
  ),
);
const label = computed(() => selected.value || 'すべての資料');
const text = (value: JsonValue | undefined): string =>
  Array.isArray(value) ? value.join(' / ') : value == null ? '' : String(value);
</script>

<template>
  <div class="library">
    <header class="library-header">
      <a class="brand" :href="homeHref ?? '/'">
        <img
          v-if="homeLabel === undefined || homeLabel === 'Slidock'"
          :src="brandIcon"
          width="48"
          height="48"
          alt=""
        />
        <div>{{ homeLabel ?? 'Slidock' }}<span>資料ライブラリ</span></div> </a
      ><span class="library-caption">考えを、スライドから。</span>
    </header>
    <div class="library-layout">
      <aside class="category-panel" aria-label="カテゴリ">
        <p class="eyebrow">CATEGORIES</p>
        <button :aria-pressed="selected === ''" @click="selected = ''">
          すべての資料 <span>{{ catalog.decks.length }}</span>
        </button>
        <button
          v-for="category in catalog.categories"
          :key="category.id"
          :aria-pressed="selected === category.id"
          :style="{ paddingLeft: `${16 + (category.path.length - 1) * 16}px` }"
          @click="selected = category.id"
        >
          {{ category.name }}
        </button>
      </aside>
      <main class="library-main">
        <div class="section-heading">
          <div>
            <p class="eyebrow">SLIDES / {{ selected || 'ALL' }}</p>
            <h1>{{ label }}</h1>
          </div>
          <p>{{ decks.length }} 件の資料</p>
        </div>
        <div class="deck-grid">
          <a
            v-for="deck in decks"
            :key="deck.id"
            class="deck-card"
            :href="deckHref ? deckHref(deck) : deck.entry"
          >
            <div class="deck-preview">
              <img
                :src="deck.thumbnail.src"
                :width="deck.thumbnail.width"
                :height="deck.thumbnail.height"
                :alt="`${deck.title} の1ページ目`"
                loading="lazy"
              /><span class="page-count">{{ deck.pages }} pages</span>
            </div>
            <div class="deck-info">
              <p class="deck-category">{{ deck.categoryPath.join(' / ') || '未分類' }}</p>
              <h2>{{ deck.title }}</h2>
              <p
                v-if="deck.frontmatter.subtitle || deck.frontmatter.description"
                class="deck-description"
              >
                {{ text(deck.frontmatter.subtitle || deck.frontmatter.description) }}
              </p>
              <p class="deck-byline">
                <span>{{ text(deck.frontmatter.author) }}</span
                ><span>{{ text(deck.frontmatter.date) }}</span>
              </p>
              <div v-if="deck.frontmatter.tags" class="deck-tags">
                <span
                  v-for="tag in (Array.isArray(deck.frontmatter.tags) ? deck.frontmatter.tags : [deck.frontmatter.tags])"
                  :key="text(tag)"
                  >{{ text(tag) }}</span
                >
              </div>
            </div>
          </a>
        </div>
        <p v-if="!decks.length" class="empty-library">このカテゴリには資料がありません。</p>
      </main>
    </div>
    <footer class="library-footer">SLIDE LIBRARY · スライドを選んで閲覧できます</footer>
  </div>
</template>
