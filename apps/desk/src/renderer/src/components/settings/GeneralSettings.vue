<script setup lang="ts">
import { computed } from 'vue'

import { checkForUpdates, useUpdateState } from '../../stores/update'
import { useWorkspaceStore } from '../../stores/workspace'
import AppZoomControl from './AppZoomControl.vue'
import ResetGroupButton from './ResetGroupButton.vue'

import type { AppSettings } from '../../../../shared/contracts'

const props = defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()
const store = useWorkspaceStore()

const breadcrumbChoice = computed({
  get: () => (props.draft.showPathBreadcrumb ? 'shown' : 'hidden'),
  set: (value: string) => {
    props.draft.showPathBreadcrumb = value === 'shown'
  }
})

const titleChoice = computed({
  get: () => (props.draft.showNoteTitle ? 'shown' : 'hidden'),
  set: (value: string) => {
    props.draft.showNoteTitle = value === 'shown'
  }
})

const autosaveChoice = computed({
  get: () => (props.draft.autosave.enabled ? 'on' : 'off'),
  set: (value: string) => {
    props.draft.autosave.enabled = value === 'on'
  }
})

async function setZoom(value: number): Promise<void> {
  try {
    await store.setAppZoom(value)
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  }
}

const updateState = useUpdateState()
const updateSummary = computed(() => {
  const status = updateState.status
  if (updateState.checking || status?.state === 'checking') return '正在检查更新…'
  if (!status || status.state === 'idle') return ''
  if (status.state === 'available')
    return `发现新版本 v${status.latestVersion ?? ''}，可在提示条中前往下载`
  if (status.state === 'up-to-date') return `当前 v${status.currentVersion} 已是最新版本`
  return status.message ?? '检查更新失败'
})

async function checkNow(): Promise<void> {
  await checkForUpdates()
}
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>外观与编辑</strong>
      <span>适用于整个 Desk 工作区</span>
    </header>
    <ResetGroupButton @reset="emit('reset')" />
    <div class="field-grid cols-3">
      <label class="field">
        <span>主题</span>
        <select v-model="draft.theme">
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </label>
      <AppZoomControl
        :model-value="store.settings?.appZoomPercent ?? 100"
        @update:model-value="setZoom"
      />
      <label class="field">
        <span>显示路径面包屑</span>
        <select v-model="breadcrumbChoice">
          <option value="shown">显示</option>
          <option value="hidden">隐藏</option>
        </select>
      </label>
      <label class="field">
        <span>显示笔记标题</span>
        <select v-model="titleChoice">
          <option value="shown">显示</option>
          <option value="hidden">隐藏</option>
        </select>
      </label>
      <label class="field">
        <span>笔记默认视图</span>
        <select v-model="draft.defaultNoteView">
          <option value="visual">可视化编辑</option>
          <option value="source">源码</option>
        </select>
      </label>
      <label class="field">
        <span>笔记默认页宽</span>
        <select v-model="draft.defaultNotePageWidth">
          <option value="standard">标准页宽</option>
          <option value="wide">超宽显示</option>
        </select>
      </label>
      <label class="field">
        <span>笔记内目录</span>
        <select v-model="draft.noteOutline">
          <option value="shown">显示</option>
          <option value="hidden">隐藏</option>
        </select>
      </label>
      <label class="field">
        <span>标题编号层级</span>
        <select v-model.number="draft.headingNumberMaxDepth">
          <option :value="1">1 层（如 1.）</option>
          <option :value="2">2 层（如 1.1.）</option>
          <option :value="3">3 层（如 1.1.1.）</option>
          <option :value="4">4 层</option>
          <option :value="5">5 层</option>
          <option :value="6">6 层</option>
        </select>
      </label>
      <label class="field">
        <span>自动保存</span>
        <select v-model="autosaveChoice">
          <option value="on">开启</option>
          <option value="off">关闭</option>
        </select>
      </label>
      <label class="field" :class="{ 'is-disabled': !draft.autosave.enabled }">
        <span>自动保存延迟</span>
        <span class="delay-input">
          <input
            v-model.number="draft.autosave.delayMs"
            type="number"
            min="250"
            max="30000"
            step="250"
            aria-label="自动保存延迟"
            :disabled="!draft.autosave.enabled"
          />
          <em>ms</em>
        </span>
      </label>
    </div>
    <div class="layout-picker">
      <button
        type="button"
        class="layout-option"
        :class="{ active: draft.workspaceLayout === 'kb-dir-content' }"
        @click="draft.workspaceLayout = 'kb-dir-content'"
      >
        <svg viewBox="0 0 120 56" aria-hidden="true">
          <rect x="0" width="24" height="56" rx="3" />
          <rect x="28" width="32" height="56" rx="3" />
          <rect x="64" width="52" height="56" rx="3" />
        </svg>
        <span>知识库 · 目录 · 内容</span>
      </button>
      <button
        type="button"
        class="layout-option"
        :class="{ active: draft.workspaceLayout === 'content-dir-kb' }"
        @click="draft.workspaceLayout = 'content-dir-kb'"
      >
        <svg viewBox="0 0 120 56" aria-hidden="true">
          <rect x="0" width="52" height="56" rx="3" />
          <rect x="56" width="32" height="56" rx="3" />
          <rect x="92" width="24" height="56" rx="3" />
        </svg>
        <span>内容 · 目录 · 知识库</span>
      </button>
    </div>
    <div class="settings-row update-row">
      <label class="switch-field">
        <input v-model="draft.updates.autoCheck" type="checkbox" />
        <span>自动检查更新</span>
      </label>
      <button
        type="button"
        class="check-update-btn"
        :disabled="updateState.checking"
        @click="checkNow"
      >
        检查更新
      </button>
      <span v-if="updateSummary" class="update-summary">{{ updateSummary }}</span>
    </div>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.layout-picker {
  display: flex;
  gap: 10px;
  margin: 0 0 12px;
}

.delay-input {
  display: flex;
  align-items: center;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--input-bg);
  padding-right: 10px;
  box-sizing: border-box;
}

.delay-input
  input:not([type='checkbox']):not([type='radio']):not([type='file']):not([type='range']) {
  width: 100%;
  min-width: 0;
  height: 100%;
  border: 0;
  border-radius: 0;
  outline: none;
  background: transparent;
  box-shadow: none;
  padding: 0 10px;
}

.delay-input
  input:not([type='checkbox']):not([type='radio']):not([type='file']):not([type='range']):focus {
  border: 0;
  box-shadow: none;
}

.delay-input:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
}

.delay-input em {
  flex: none;
  color: var(--muted);
  font-size: 10px;
  font-style: normal;
}

.field.is-disabled {
  opacity: 0.45;
}

.layout-option {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--muted);
  cursor: pointer;
  padding: 10px;
  font-size: 10px;
}

.layout-option svg {
  width: 128px;
  height: 60px;
}

.layout-option svg rect {
  fill: var(--raised);
  stroke: var(--border);
}

.layout-option.active {
  border-color: var(--accent);
  background: var(--selected);
  color: var(--text);
}

.layout-option.active svg rect {
  fill: color-mix(in srgb, var(--accent) 24%, var(--raised));
  stroke: var(--accent);
}

.update-row {
  align-items: center;
  gap: 12px;
}

.check-update-btn {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text);
  cursor: pointer;
  padding: 4px 12px;
  font-size: 10px;
}

.check-update-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.update-summary {
  color: var(--muted);
  font-size: 10px;
}

.settings-note {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.6;
}
</style>
