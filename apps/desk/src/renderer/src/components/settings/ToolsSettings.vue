<script setup lang="ts">
import type { AppSettings } from '../../../../shared/contracts'
import ResetGroupButton from './ResetGroupButton.vue'

defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>外部工具</strong>
      <span>冲突处理和右键快捷入口会使用这里的 IDE</span>
    </header>
    <ResetGroupButton @reset="emit('reset')" />
    <div class="field-grid cols-3">
      <label class="field">
        <span>默认 IDE</span>
        <select v-model="draft.ide">
          <option value="vscode">VSCode</option>
          <option value="cursor">Cursor</option>
        </select>
      </label>
      <label class="field">
        <span>Git 可执行文件（可选）</span>
        <input v-model="draft.gitPath" placeholder="自动检测" />
      </label>
      <label class="field">
        <span>Node 可执行文件（可选）</span>
        <input v-model="draft.nodePath" placeholder="自动检测" />
      </label>
    </div>
    <div class="settings-row">
      <label class="switch-field">
        <input v-model="draft.confirmBeforeCommit" type="checkbox" />
        <span>提交前再次弹窗确认变更</span>
      </label>
    </div>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>
