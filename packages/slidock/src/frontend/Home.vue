<script setup lang="ts">
import type { Catalog, CatalogDeck } from '@slidock/slidock/client';
import type { HubHomeOptions } from './home-options.js';
import SlidockHome from './SlidockHome.vue';
defineProps<{
  catalog: Catalog;
  home?: HubHomeOptions;
  homeHref?: string;
  homeLabel?: string;
  deckHref?: (deck: CatalogDeck) => string;
}>();
</script>
<template>
  <SlidockHome
    :catalog="catalog"
    :title="home?.title ?? homeLabel ?? 'Slidock'"
    :logo="home?.logo ?? (homeLabel && homeLabel !== 'Slidock' ? false : undefined)"
    :home-href="homeHref"
    :category-labels="home?.categoryLabels"
    :deck-href="deckHref"
  >
    <template v-if="home?.links?.length" #nav>
      <a v-for="link in home.links" :key="link.href" :href="link.href">{{ link.label }}</a>
    </template>
    <template v-if="home?.hero === true" #header>
      <section class="home-hero">
        <h1>{{ home?.title ?? homeLabel ?? 'Slidock' }}</h1>
        <p v-if="home?.description">{{ home.description }}</p>
      </section>
    </template>
    <template v-if="home?.footer" #footer>{{ home.footer }}</template>
  </SlidockHome>
</template>
