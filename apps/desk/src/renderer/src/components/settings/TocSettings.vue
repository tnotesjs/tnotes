<script setup lang="ts">
import type { AppSettings } from '../../../../shared/contracts'
import ResetGroupButton from './ResetGroupButton.vue'

defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>目录管理</strong>
      <span>新笔记写进目录的位置</span>
    </header>
    <ResetGroupButton @reset="emit('reset')" />
    <div class="field-grid cols-3">
      <label class="field">
        <span>新增笔记位置</span>
        <select v-model="draft.createNotePosition">
          <option value="top">顶部新增</option>
          <option value="end">末尾追加</option>
        </select>
      </label>
    </div>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>
