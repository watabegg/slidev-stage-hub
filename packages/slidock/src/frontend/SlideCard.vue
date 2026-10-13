<script setup lang="ts">
import type { VNode } from 'vue';
import type { CatalogDeck, JsonValue } from '@slidock/slidock/client';
defineProps<{ deck: CatalogDeck; href?: string }>();
defineSlots<{
  preview?(props: { deck: CatalogDeck }): VNode[];
  default?(props: { deck: CatalogDeck }): VNode[];
}>();
const text = (value: JsonValue | undefined): string => Array.isArray(value) ? value.join(' / ') : value == null ? '' : String(value);
</script>
<template>
  <a class="deck-card" :href="href ?? deck.entry">
    <div class="deck-preview">
      <slot name="preview" :deck="deck">
        <img
          :src="deck.thumbnail.src"
          :width="deck.thumbnail.width"
          :height="deck.thumbnail.height"
          :alt="`${deck.title} の1ページ目`"
          loading="lazy"
        />
        <span class="page-count">{{ deck.pages }} pages</span>
      </slot>
    </div>
    <div class="deck-info">
      <slot :deck="deck">
        <h3>{{ deck.title }}</h3>
        <p
          v-if="deck.frontmatter.subtitle || deck.frontmatter.description"
          class="deck-description"
        >
          {{ text(deck.frontmatter.subtitle || deck.frontmatter.description) }}
        </p>
        <p v-if="deck.frontmatter.author || deck.frontmatter.date" class="deck-byline">
          <span v-if="deck.frontmatter.author">{{ text(deck.frontmatter.author) }}</span
          ><span v-if="deck.frontmatter.date">{{ text(deck.frontmatter.date) }}</span>
        </p>
        <div v-if="deck.frontmatter.tags" class="deck-tags">
          <span
            v-for="tag in (Array.isArray(deck.frontmatter.tags) ? deck.frontmatter.tags : [deck.frontmatter.tags])"
            :key="text(tag)"
            >{{ text(tag) }}</span
          >
        </div>
      </slot>
    </div>
  </a>
</template>
