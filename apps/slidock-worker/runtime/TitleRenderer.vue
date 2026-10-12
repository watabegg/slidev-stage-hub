<script setup lang="ts">
import { computed } from 'vue'
import { useSlideContext } from '@slidev/client/context.ts'

const props = defineProps<{ no?: number | string }>()
const { $page, $nav } = useSlideContext()
const no = computed(() => +(props.no ?? $page.value))
const title = computed(() => $nav.value.slides[no.value - 1]?.meta?.slide?.title || '')
</script>

<template>
  <span>{{ title }}</span>
</template>
