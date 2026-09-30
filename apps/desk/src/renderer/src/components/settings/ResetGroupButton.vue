<script setup lang="ts">
import UiTooltip from '../UiTooltip.vue'

const emit = defineEmits<{ reset: [] }>()
</script>

<template>
  <UiTooltip class="reset-group-anchor" label="重置设置" placement="bottom" align="end">
    <button type="button" class="reset-group" aria-label="重置设置" @click="emit('reset')">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M0 0h32v32H0z" fill="none" />
        <path
          fill="currentColor"
          d="M18 28A12 12 0 1 0 6 16v6.2l-3.6-3.6L1 20l6 6l6-6l-1.4-1.4L8 22.2V16a10 10 0 1 1 10 10Z"
        />
      </svg>
    </button>
  </UiTooltip>
</template>

<style scoped>
.reset-group-anchor {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 1;
}

.reset-group {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
}

.reset-group svg {
  width: 14px;
  height: 14px;
}

.reset-group:hover {
  color: var(--text);
  background: var(--hover);
}
</style>
