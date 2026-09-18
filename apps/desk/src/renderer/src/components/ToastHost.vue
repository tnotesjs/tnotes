<script setup lang="ts">
import { dismissToast, useToasts } from '../stores/toast'

const toasts = useToasts()
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast" tag="div" class="toast-stack">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.kind">
        <span>{{ toast.message }}</span>
        <button v-if="toast.action" type="button" class="toast-action" @click="toast.action.run()">
          {{ toast.action.label }}
        </button>
        <button type="button" aria-label="关闭通知" @click="dismissToast(toast.id)">×</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 2000;
  pointer-events: none;
  max-width: min(360px, calc(100vw - 28px));
}

.toast-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--raised);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.36);
  color: var(--text);
  padding: 9px 10px 9px 12px;
  font-size: 11px;
}

.toast span {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}

.toast button {
  flex: none;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 2px;
  font-size: 14px;
  line-height: 1;
}

.toast button:hover {
  color: var(--text);
}

.toast-action {
  flex: none;
  border: 1px solid currentColor !important;
  border-radius: 4px;
  padding: 1px 6px !important;
  font-size: 11px !important;
}

.toast.info {
  border-color: var(--accent);
}

.toast.success {
  border-color: color-mix(in srgb, var(--success) 55%, transparent);
}

.toast.error {
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
  background: var(--danger-soft);
  color: var(--danger);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
