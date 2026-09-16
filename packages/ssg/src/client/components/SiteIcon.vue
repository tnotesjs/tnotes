<template>
  <svg :viewBox="icon.viewBox" aria-hidden="true">
    <path
      v-for="(path, index) in icon.paths"
      :key="index"
      :d="path"
      :fill="icon.mode === 'fill' ? 'currentColor' : 'none'"
      :stroke="icon.mode === 'stroke' ? 'currentColor' : undefined"
      :stroke-width="icon.mode === 'stroke' ? 2 : undefined"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup lang="ts">
/**
 * Renders one shape from the local icon set.
 *
 * Shared by the header and the sidebar tools so both sides produce byte-identical
 * SSR and client markup — an icon that renders differently on hydration would be
 * a mismatch, not just a visual glitch.
 *
 * Icons carry no size of their own: every call site is icon-only, so the button
 * owns the box and CSS scales the glyph to `currentColor`'s colour.
 */
import { computed } from 'vue'

import { SITE_ICONS, type SiteIconName } from '../icons'

const props = defineProps<{ name: SiteIconName }>()
const icon = computed(() => SITE_ICONS[props.name])
</script>
