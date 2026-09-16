<script setup lang="ts">
import type { AppSettings } from '../../../../shared/contracts'

defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>目录管理</strong>
      <span>控制目录树与变更区域显示</span>
    </header>
    <button type="button" class="reset-group" @click="emit('reset')">重置</button>
    <div class="field-grid cols-3">
      <label class="field">
        <span>新增笔记位置</span>
        <select v-model="draft.createNotePosition">
          <option value="top">顶部新增</option>
          <option value="end">末尾追加</option>
        </select>
      </label>
    </div>
    <div class="settings-row">
      <label class="switch-field">
        <input v-model="draft.toc.showNoteIndex" type="checkbox" />
        <span>显示笔记编号</span>
      </label>
      <label class="switch-field">
        <input v-model="draft.toc.showNoteStatus" type="checkbox" />
        <span>显示完成状态标识</span>
      </label>
    </div>
    <div class="settings-row">
      <label class="switch-field">
        <input v-model="draft.toc.changesCollapsedByDefault" type="checkbox" />
        <span>变更区域默认折叠</span>
      </label>
    </div>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>
