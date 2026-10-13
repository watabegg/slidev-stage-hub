<script setup lang="ts">
import { SlidockHome, useCatalog } from '@slidock/slidock/frontend';
const { catalog, pending, error, reload } = useCatalog();
</script>
<template>
  <SlidockHome v-if="catalog" :catalog="catalog">
    <template #nav>
      <a href="https://sli.dev">Slidev</a>
      <a href="https://github.com/watabegg/slidock">GitHub</a>
    </template>
  </SlidockHome>
  <div v-else-if="error" class="catalog-state" role="alert">
    <p>スライドを読み込めませんでした。</p>
    <button @click="reload">再試行</button>
  </div>
  <p v-else-if="pending" class="catalog-state" role="status">読み込み中…</p>
</template>
