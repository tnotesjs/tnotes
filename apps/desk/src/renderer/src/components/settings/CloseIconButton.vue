<script setup lang="ts">
import UiTooltip from '../UiTooltip.vue'

defineProps<{ label: string }>()
const emit = defineEmits<{ click: [] }>()
</script>

<template>
  <UiTooltip class="close-icon-anchor" :label="label" placement="bottom" align="end">
    <button type="button" class="close-icon" :aria-label="label" @click="emit('click')">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 4l8 8M12 4l-8 8"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </UiTooltip>
</template>

<style scoped>
.close-icon-anchor {
  flex: none;
}

.close-icon {
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

.close-icon svg {
  width: 14px;
  height: 14px;
}

.close-icon:hover {
  color: var(--danger, #e03131);
  background: var(--hover);
}
</style>
