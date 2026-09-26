<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ name: string }>()

const PATHS: Record<string, string[]> = {
  plus: ['M8 3v10', 'M3 8h10'],
  history: ['M2.5 8a5.5 5.5 0 1 0 1.6-3.9', 'M2.5 2.8v2.4h2.4', 'M8 5v3.2l2 1.3'],
  image: ['M2.5 3.5h11v9h-11z', 'M2.5 11l3.2-3.2 2.3 2.3 1.8-1.8 3.7 3.7', 'M10.5 6.2h.01'],
  send: ['M8 12.5V3.5', 'M4.5 7 8 3.5 11.5 7'],
  chevron: ['M4.5 6.5 8 10l3.5-3.5'],
  chevronRight: ['M6.5 4.5 10 8l-3.5 3.5'],
  file: ['M4 2.5h5l3 3v8H4z', 'M9 2.5v3h3'],
  filePlus: ['M4 2.5h5l3 3v8H4z', 'M9 2.5v3h3', 'M8 7.5v4', 'M6 9.5h4'],
  search: ['M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M10.3 10.3 13.5 13.5'],
  list: ['M5.5 4h8', 'M5.5 8h8', 'M5.5 12h8', 'M2.5 4h.01', 'M2.5 8h.01', 'M2.5 12h.01'],
  pencil: ['M10.5 2.8 13.2 5.5 6 12.7l-3.2.5.5-3.2z'],
  at: ['M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M10.5 8v1a2 2 0 0 0 4 0V8a6.5 6.5 0 1 0-2.6 5.2'],
  close: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
  copy: ['M5.5 5.5h7v7h-7z', 'M3.5 10.5v-7h7'],
  infinity: ['M5.2 5.6C3.2 4 1.5 5.2 1.5 8s1.7 4 3.7 2.4L8 8l2.8-2.4C12.8 4 14.5 5.2 14.5 8s-1.7 4-3.7 2.4L8 8z'],
  chat: ['M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z'],
  brain: ['M6 3a2 2 0 0 0-2 2 2 2 0 0 0-1 3.5A2 2 0 0 0 5 12h1V3z', 'M10 3a2 2 0 0 1 2 2 2 2 0 0 1 1 3.5A2 2 0 0 1 11 12h-1V3z'],
  model: ['M8 1.8 13.5 5v6L8 14.2 2.5 11V5z', 'M2.5 5 8 8l5.5-3', 'M8 8v6.2']
}

const paths = computed(() => PATHS[props.name] ?? [])
</script>

<template>
  <svg
    v-if="name === 'stop'"
    class="agent-icon"
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" />
  </svg>
  <svg v-else-if="name === 'spinner'" class="agent-icon spin" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>
  <svg v-else class="agent-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path
      v-for="(d, index) in paths"
      :key="index"
      :d="d"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<style scoped>
.agent-icon {
  width: 1em;
  height: 1em;
  flex: none;
}

.spin {
  animation: agent-spin 0.9s linear infinite;
}

@keyframes agent-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
