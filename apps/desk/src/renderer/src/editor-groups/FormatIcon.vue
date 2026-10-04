<script setup lang="ts">
import { formatIcons as icons, type FormatIconName } from '../components/formatIcons'

defineProps<{ name: FormatIconName }>()
</script>

<template>
  <svg
    class="format-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="1em"
    height="1em"
    :viewBox="`0 0 ${icons[name].size} ${icons[name].size}`"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="`M0 0h${icons[name].size}v${icons[name].size}H0z`" fill="none" />
    <path
      v-for="(path, index) in icons[name].paths"
      :key="index"
      :d="path"
      fill="currentColor"
      fill-rule="evenodd"
      clip-rule="evenodd"
    />
  </svg>
</template>

<style scoped>
.format-icon {
  display: block;
  width: 16px;
  height: 16px;
  stroke: none;
}
</style>
