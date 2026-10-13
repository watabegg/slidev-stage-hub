<script setup lang="ts">
import SlidockHome from './SlidockHome.vue';
import { useCatalog } from './use-catalog.js';
const { catalog, pending, error, reload } = useCatalog();
</script>
<template>
  <SlidockHome v-if="catalog" :catalog="catalog" />
  <div v-else-if="error" class="catalog-state" role="alert">
    <p>資料一覧を読み込めませんでした。</p>
    <button @click="reload">再試行</button>
  </div>
  <p v-else-if="pending" class="catalog-state" role="status">読み込み中…</p>
</template>
