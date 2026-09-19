<script setup lang="ts">
import type { AppSettings } from '../../../../shared/contracts'

defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>编辑器</strong>
      <span>控制可视化编辑器里的浮层与交互</span>
    </header>
    <button type="button" class="reset-group" @click="emit('reset')">重置</button>
    <div class="field-grid">
      <label class="card-toggle" data-setting="selection-toolbar">
        <input v-model="draft.editor.selectionToolbar" type="checkbox" />
        <span>
          <strong>选区浮动工具条</strong>
          <small>选中文字时弹出粗体、斜体、链接等格式按钮；默认关闭</small>
        </span>
      </label>
    </div>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.card-toggle {
  min-height: 56px;
  display: flex !important;
  flex-direction: row !important;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input-bg);
  padding: 9px 11px;
  cursor: pointer;
}

.card-toggle input {
  accent-color: var(--accent);
  margin: 0;
}

.card-toggle > span {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.card-toggle strong {
  color: var(--text);
  font-size: 10px;
}

.card-toggle small {
  color: var(--muted);
  font-size: 9px;
}

.card-toggle:hover {
  border-color: var(--accent);
}
</style>
