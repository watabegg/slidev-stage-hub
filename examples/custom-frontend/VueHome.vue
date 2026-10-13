<script setup lang="ts">
import { ref } from 'vue';
import { SlidockHome, SlideCard, useCatalog } from '@slidock/slidock/frontend';
const { catalog, pending, error, reload } = useCatalog();
const category = ref('');
</script>
<template>
  <SlidockHome v-if="catalog" v-model:category="category" :catalog="catalog" title="My slides">
    <template #nav>
      <a href="https://sli.dev">Slidev</a>
    </template>
    <template #card="{ deck, href }">
      <SlideCard :deck="deck" :href="href" class="my-slide-card">
        <h3>{{ deck.title }}</h3>
        <p class="deck-description">{{ deck.pages }}ページ</p>
      </SlideCard>
    </template>
    <template #empty><p>まだスライドがありません。</p></template>
  </SlidockHome>
  <div v-else-if="error" role="alert">
    <p>スライドを読み込めませんでした。</p>
    <button @click="reload">再試行</button>
  </div>
  <p v-else-if="pending" role="status">読み込み中…</p>
</template>
