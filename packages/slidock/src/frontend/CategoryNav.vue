<script setup lang="ts">
import type { CatalogCategory } from '@slidock/slidock/client';
defineProps<{
  categories: CatalogCategory[];
  total?: number;
  labels?: Record<string, string>;
}>();
const selected = defineModel<string>({ default: '' });
</script>
<template>
  <nav class="category-panel" aria-label="カテゴリ">
    <p class="category-heading">カテゴリ</p>
    <button :aria-pressed="selected === ''" @click="selected = ''">
      すべて <span v-if="total !== undefined" aria-hidden="true">{{ total }}</span>
    </button>
    <button
      v-for="category in categories"
      :key="category.id"
      :aria-pressed="selected === category.id"
      :style="{ paddingLeft: `${12 + (category.path.length - 1) * 16}px` }"
      @click="selected = category.id"
    >
      {{ labels?.[category.id] ?? category.name }}
    </button>
  </nav>
</template>
