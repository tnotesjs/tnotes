<script setup lang="ts">
import { computed } from 'vue'

import UiTooltip from '../components/UiTooltip.vue'
import HeadingMenu from './HeadingMenu.vue'
import FormatIcon from './FormatIcon.vue'
import FormatOverflowBar from './FormatOverflowBar.vue'
import BlockInsertMenu from './BlockInsertMenu.vue'
import { TN_NOTES_SLASH_ITEMS } from '../markdown/slashMenu'
import { useWorkspaceStore } from '../stores/workspace'

import type { InsertItem } from '../markdown/insertCatalog'

/** 工具栏只用到编辑器句柄里的这几项；笔记和 README 两个宿主都满足 */
export interface FormatToolbarEditor {
  insertTextAt(text: string, position?: number): void
  wrapSelection(prefix: string, suffix: string, placeholder?: string): void
  setLinePrefix(prefix: string): void
  insertTable(): void
  addHeadingNumbers(maxDepth: number): void
  removeHeadingNumbers(): void
  /** 光标所在 `:::` 容器类型；插入菜单据此隐藏不能嵌进去的块 */
  containerAtCursor?(): string | null
  /** 此刻能插入的块（与斜杠菜单同一套过滤） */
  availableBlocks?(): InsertItem[]
  /** 按菜单项插入一块（与斜杠菜单同一条插入路径） */
  insertBlock?(id: string): void
}

const props = defineProps<{
  editor: FormatToolbarEditor | null
  disabled: boolean
  active: boolean
  headingLevel: number | null
  /** 宿主不支持的插入项 */
  excludeBlocks?: readonly string[]
}>()

const emit = defineEmits<{ insertCanvas: [] }>()

const workspace = useWorkspaceStore()
const platform = computed(() => workspace.runtimePlatform)

/**
 * 顺序即工具栏顺序。加号和标题、文本格式是同一组。
 * 「标题与文本格式」隐藏时这一组整段不渲染，中间留空。
 * 标题编号的重排和移除只在命令面板里。
 * FormatOverflowBar 从尾部收进「…」，靠前的项在窄面板里仍会留下。
 */
const formatActions = [
  'insert',
  'heading',
  'bold',
  'italic',
  'strikethrough',
  'inline-code',
  'unordered-list',
  'ordered-list',
  'checkbox',
  'link',
  'divider'
] as const

const showTextFormat = computed(() => workspace.settings?.showTextFormatToolbar !== false)

function insertBlock(id: string): void {
  if (props.editor?.insertBlock) {
    props.editor.insertBlock(id)
    return
  }
  if (id === 'canvas') {
    emit('insertCanvas')
    return
  }
  if (id === 'table') {
    props.editor?.insertTable()
    return
  }
  if (id === 'code') {
    props.editor?.insertTextAt('\n```ts\n\n```\n')
    return
  }
  const found = TN_NOTES_SLASH_ITEMS.find((item) => item.id === id)
  if (!found) return
  props.editor?.insertTextAt(found.insert.startsWith('\n') ? found.insert : `\n${found.insert}`)
}
</script>

<template>
  <div class="format-cluster">
    <FormatOverflowBar v-if="showTextFormat" :items="formatActions" :disabled="disabled">
      <template #item="{ item }">
        <BlockInsertMenu
          v-if="item === 'insert'"
          :disabled="disabled"
          :active="active"
          :exclude="excludeBlocks"
          :resolve-parent="() => editor?.containerAtCursor?.() ?? null"
          :resolve-items="() => editor?.availableBlocks?.() ?? []"
          @select="insertBlock"
        />
        <UiTooltip v-else-if="item === 'bold'" label="粗体" shortcut="⌘ B">
          <button
            type="button"
            aria-label="粗体"
            :disabled="disabled"
            @click="editor?.wrapSelection('**', '**')"
          >
            <FormatIcon name="bold" />
          </button>
        </UiTooltip>
        <UiTooltip v-else-if="item === 'italic'" label="斜体" shortcut="⌘ I">
          <button
            type="button"
            aria-label="斜体"
            :disabled="disabled"
            @click="editor?.wrapSelection('*', '*')"
          >
            <FormatIcon name="italic" />
          </button>
        </UiTooltip>
        <UiTooltip v-else-if="item === 'strikethrough'" label="删除线" shortcut="⇧ ⌘ X">
          <button
            type="button"
            aria-label="删除线"
            :disabled="disabled"
            @mousedown.prevent
            @click="editor?.wrapSelection('~~', '~~')"
          >
            <FormatIcon name="strikethrough" />
          </button>
        </UiTooltip>
        <UiTooltip v-else-if="item === 'inline-code'" label="行内代码" shortcut="⌘ E">
          <button
            type="button"
            aria-label="行内代码"
            :disabled="disabled"
            @mousedown.prevent
            @click="editor?.wrapSelection('`', '`')"
          >
            <FormatIcon name="inline-code" />
          </button>
        </UiTooltip>
        <HeadingMenu
          v-else-if="item === 'heading'"
          :level="headingLevel"
          :disabled="disabled"
          :active="active"
          :platform="platform"
          @select="editor?.setLinePrefix($event === 0 ? '' : `${'#'.repeat($event)} `)"
        />
        <UiTooltip v-else-if="item === 'unordered-list'" label="无序列表" shortcut="⇧ ⌘ 8">
          <button
            type="button"
            aria-label="无序列表"
            :disabled="disabled"
            @click="editor?.setLinePrefix('- ')"
          >
            <FormatIcon name="unordered-list" />
          </button>
        </UiTooltip>
        <UiTooltip v-else-if="item === 'ordered-list'" label="有序列表" shortcut="⇧ ⌘ 7">
          <button
            type="button"
            aria-label="有序列表"
            :disabled="disabled"
            @click="editor?.setLinePrefix('1. ')"
          >
            <FormatIcon name="ordered-list" />
          </button>
        </UiTooltip>
        <UiTooltip v-else-if="item === 'checkbox'" label="复选框">
          <button
            type="button"
            aria-label="复选框"
            :disabled="disabled"
            @click="editor?.setLinePrefix('- [ ] ')"
          >
            <FormatIcon name="checkbox" />
          </button>
        </UiTooltip>
        <UiTooltip v-else-if="item === 'link'" label="链接" shortcut="⇧ ⌘ K">
          <button
            type="button"
            aria-label="链接"
            :disabled="disabled"
            @click="editor?.wrapSelection('[', '](https://)', '链接')"
          >
            <FormatIcon name="link" />
          </button>
        </UiTooltip>
        <UiTooltip v-else-if="item === 'divider'" label="分割线">
          <button
            type="button"
            aria-label="分割线"
            :disabled="disabled"
            @click="editor?.insertTextAt('\n---\n')"
          >
            <FormatIcon name="divider" />
          </button>
        </UiTooltip>
      </template>
    </FormatOverflowBar>
  </div>
</template>

<style scoped>
.format-cluster {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0;
}

:deep(.format-overflow .ui-tooltip-host) {
  flex: none;
}

:deep(.format-overflow button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 14px;
}

:deep(.format-overflow button:hover:not(:disabled)) {
  background: var(--hover);
  color: var(--text);
}
</style>
