<template>
  <svg :viewBox="icon.viewBox" aria-hidden="true">
    <template v-if="icon.accent">
      <path
        :d="icon.paths[0]"
        fill="none"
        stroke="currentColor"
        :stroke-width="icon.strokeWidth ?? 2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <rect
        :width="icon.accent.width"
        :height="icon.accent.height"
        :rx="icon.accent.rx"
        fill="currentColor"
        :opacity="icon.accent.opacity"
        :transform="icon.accent.transform"
      />
      <path
        v-for="(path, index) in icon.paths.slice(1)"
        :key="index"
        :d="path"
        fill="none"
        stroke="currentColor"
        :stroke-width="icon.strokeWidth ?? 2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>
    <template v-else>
      <path
        v-for="(path, index) in icon.paths"
        :key="index"
        :d="path"
        :fill="icon.mode === 'fill' ? 'currentColor' : 'none'"
        :stroke="icon.mode === 'stroke' ? 'currentColor' : undefined"
        :stroke-width="icon.mode === 'stroke' ? (icon.strokeWidth ?? 2) : undefined"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>
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
