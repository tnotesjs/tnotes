<script setup lang="ts">
defineProps<{
  name:
    | 'refresh'
    | 'search'
    | 'clear'
    | 'zoomOut'
    | 'zoomIn'
    | 'maximize'
    | 'restore'
    | 'close'
    | 'terminal'
    | 'stop'
}>()
</script>

<template>
  <svg class="terminal-icon" viewBox="0 0 16 16" aria-hidden="true">
    <g v-if="name === 'refresh'" fill="none" stroke="currentColor" stroke-width="1.4">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.4-3.5" stroke-linecap="round" />
      <path d="M12.2 2.2v3.2H9" stroke-linecap="round" stroke-linejoin="round" />
    </g>
    <g v-else-if="name === 'search'" fill="none" stroke="currentColor" stroke-width="1.4">
      <circle cx="7" cy="7" r="3.4" />
      <path d="M9.6 9.6 13 13" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'clear'" fill="none" stroke="currentColor" stroke-width="1.4">
      <path
        d="M3 5h10M6 5V3.5h4V5M4.5 5l.6 8h5.8l.6-8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </g>
    <g v-else-if="name === 'zoomOut'" fill="none" stroke="currentColor" stroke-width="1.4">
      <circle cx="7" cy="7" r="3.2" />
      <path d="M5.6 7h2.8M9.4 9.4 12.2 12.2" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'zoomIn'" fill="none" stroke="currentColor" stroke-width="1.4">
      <circle cx="7" cy="7" r="3.2" />
      <path d="M7 5.6v2.8M5.6 7h2.8M9.4 9.4 12.2 12.2" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'maximize'" fill="none" stroke="currentColor" stroke-width="1.4">
      <path
        d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </g>
    <g v-else-if="name === 'restore'" fill="none" stroke="currentColor" stroke-width="1.4">
      <path d="M6 3h7v7M3 6h7v7H3z" stroke-linejoin="round" />
    </g>
    <g v-else-if="name === 'close'" fill="none" stroke="currentColor" stroke-width="1.4">
      <path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round" />
    </g>
    <g v-else-if="name === 'terminal'" fill="none" stroke="currentColor" stroke-width="1.4">
      <path d="M3 4.5 6.2 8 3 11.5M8 12h5" stroke-linecap="round" stroke-linejoin="round" />
    </g>
    <g v-else fill="currentColor">
      <rect x="4" y="4" width="8" height="8" rx="1" />
    </g>
  </svg>
</template>

<style scoped>
.terminal-icon {
  width: 14px;
  height: 14px;
  display: block;
}
</style>
