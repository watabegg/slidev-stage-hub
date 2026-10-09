<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { frontmatterToProps, useSlideContext } from '@slidev/client/context.ts'
import { layouts } from '/@lab/layouts'

const { $frontmatter, $page } = useSlideContext()
const slots = useSlots()
const layoutName = computed(() => $frontmatter.layout || ($page.value === 1 ? 'cover' : 'default'))
const layout = computed(() => {
  const selected = layouts[layoutName.value]
  if (!selected)
    throw new Error(`Unsupported Slidev layout "${layoutName.value}"`)
  return selected
})
const layoutProps = computed(() => frontmatterToProps($frontmatter, $page.value - 1))
</script>

<template>
  <component :is="layout" v-bind="layoutProps" :data-lab-slide-ready="$page">
    <template v-for="(_, name) in slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps || {}" />
    </template>
  </component>
</template>
