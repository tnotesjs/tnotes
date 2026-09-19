<script setup lang="ts">
import type { AppSettings } from '../../../../shared/contracts'

defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: []; 'open-shortcuts': [] }>()
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>标签与导航</strong>
      <span>控制标签容量、布局和目录联动</span>
    </header>
    <button type="button" class="reset-group" @click="emit('reset')">重置</button>
    <div class="field-grid cols-3">
      <label class="field">
        <span>最多打开标签数</span>
        <input v-model.number="draft.tabs.maxOpenCount" type="number" min="1" max="30" />
      </label>
      <label class="field">
        <span>底部面板标签上限</span>
        <input v-model.number="draft.bottomPanel.maxTabs" type="number" min="1" max="30" />
        <small>终端会话与命令任务合计；默认 10，最大 30</small>
      </label>
      <label class="card-toggle">
        <input v-model="draft.tabs.wrap" type="checkbox" />
        <span><strong>标签自动换行</strong><small>横向空间不足时显示为多行</small></span>
      </label>
      <label class="card-toggle">
        <input v-model="draft.tabs.autoRevealInToc" type="checkbox" />
        <span><strong>跟随活动标签</strong><small>自动切换知识库并定位目录项</small></span>
      </label>
    </div>
    <button type="button" class="entry-row" @click="emit('open-shortcuts')">
      <span class="entry-row__label">
        <strong>快捷键清单</strong>
        <small>查看 Desk 当前支持的标签与编辑快捷键</small>
      </span>
      <span class="entry-row__hint" aria-hidden="true">⌘K</span>
    </button>
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

.entry-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  padding: 9px 11px;
  text-align: left;
}

.entry-row:hover {
  border-color: var(--accent);
  background: var(--hover);
}

.entry-row__label {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.entry-row__label strong {
  color: var(--text);
  font-size: 10px;
}

.entry-row__label small {
  color: var(--muted);
  font-size: 9px;
}

.entry-row__hint {
  color: var(--muted);
  font-size: 10px;
  font-family: var(--font-mono);
}
</style>
