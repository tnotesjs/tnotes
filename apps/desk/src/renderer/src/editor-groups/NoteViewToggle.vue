<script setup lang="ts">
import { computed } from 'vue'

import UiTooltip from '../components/UiTooltip.vue'

import type { NoteViewMode } from '../../../shared/contracts'

const props = defineProps<{ viewMode: NoteViewMode }>()
const emit = defineEmits<{ toggle: [] }>()

const label = computed(() =>
  props.viewMode === 'source'
    ? '切换到可视化编辑（⌘K V）· 当前：源码视图'
    : '切换到源码视图（⌘K V）· 当前：可视化编辑'
)
</script>

<template>
  <UiTooltip :label="label">
    <button
      type="button"
      class="view-toggle"
      data-testid="view-toggle"
      :aria-label="viewMode === 'source' ? '源码视图' : '可视化编辑'"
      @click="emit('toggle')"
    >
      <svg v-if="viewMode !== 'source'" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" />
        <path d="m14.5 6.7 2.8 2.8" />
      </svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true">
        <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4l-3 16" />
      </svg>
    </button>
  </UiTooltip>
</template>

<style scoped>
.view-toggle {
  width: 27px;
  height: 25px;
  display: grid;
  place-items: center;
  flex: none;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
}

.view-toggle:hover {
  background: var(--hover);
  color: var(--text);
}

.view-toggle svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
