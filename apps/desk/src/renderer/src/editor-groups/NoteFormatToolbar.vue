<script setup lang="ts">
import { computed } from 'vue'

import UiTooltip from '../components/UiTooltip.vue'
import HeadingMenu from './HeadingMenu.vue'
import FormatIcon from './FormatIcon.vue'
import FormatOverflowBar from './FormatOverflowBar.vue'
import BlockInsertMenu from './BlockInsertMenu.vue'
import { TN_NOTES_SLASH_ITEMS } from '../markdown/slashMenu'
import { useWorkspaceStore } from '../stores/workspace'

import type { NoteViewMode } from '../../../shared/contracts'

/** 工具栏只用到编辑器句柄里的这几项；笔记和 README 两个宿主都满足 */
export interface FormatToolbarEditor {
  insertTextAt(text: string, position?: number): void
  wrapSelection(prefix: string, suffix: string, placeholder?: string): void
  setLinePrefix(prefix: string): void
  insertTable(): void
  addHeadingNumbers(maxDepth: number): void
  removeHeadingNumbers(): void
}

const props = defineProps<{
  editor: FormatToolbarEditor | null
  viewMode: NoteViewMode
  disabled: boolean
  active: boolean
  headingLevel: number | null
  headingNumberMaxDepth: number
  /** 宿主不支持的插入项 */
  excludeBlocks?: readonly string[]
}>()

const emit = defineEmits<{ toggleMode: []; insertCanvas: [] }>()

const workspace = useWorkspaceStore()
const platform = computed(() => workspace.runtimePlatform)

/**
 * 顺序即工具栏顺序。标题三项（级别下拉 / 编号重排 / 移除编号）放在最前：
 * 它们是**块级**结构操作，与后面的行内格式分开；同时 FormatOverflowBar 是从**尾部**
 * 开始收进「…」的，放最前也保证窄面板下它们始终在。
 */
const formatActions = [
  'insert',
  'heading',
  'heading-number',
  'heading-number-remove',
  'bold',
  'italic',
  'strikethrough',
  'highlight',
  'inline-code',
  'quote',
  'unordered-list',
  'ordered-list',
  'checkbox',
  'link',
  'divider'
] as const

const viewToggleHint = computed(() =>
  props.viewMode === 'source'
    ? '切换到可视化编辑（⌘K V）· 当前：源码视图'
    : '切换到源码视图（⌘K V）· 当前：可视化编辑'
)

function insertBlock(id: string): void {
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
    <UiTooltip :label="viewToggleHint">
      <button
        type="button"
        class="view-toggle"
        data-testid="view-toggle"
        :aria-label="viewMode === 'source' ? '源码视图' : '可视化编辑'"
        @click="emit('toggleMode')"
      >
        <svg v-if="viewMode !== 'source'" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" />
          <path d="m14.5 6.7 2.8 2.8" />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4l-3 16" />
        </svg>
      </button>
    </UiTooltip>
    <FormatOverflowBar :items="formatActions" :disabled="disabled">
      <template #item="{ item }">
        <BlockInsertMenu
          v-if="item === 'insert'"
          :disabled="disabled"
          :active="active"
          :exclude="excludeBlocks"
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
        <UiTooltip v-else-if="item === 'highlight'" label="高亮" shortcut="⇧ ⌘ H">
          <button
            type="button"
            aria-label="高亮"
            :disabled="disabled"
            @mousedown.prevent
            @click="editor?.wrapSelection('==', '==')"
          >
            <FormatIcon name="highlight" />
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
        <UiTooltip v-else-if="item === 'heading-number'" label="标题编号（重排）">
          <button
            type="button"
            aria-label="标题编号（重排）"
            :disabled="disabled"
            @click="editor?.addHeadingNumbers(headingNumberMaxDepth)"
          >
            <FormatIcon name="heading-number" />
          </button>
        </UiTooltip>
        <UiTooltip v-else-if="item === 'heading-number-remove'" label="移除标题编号">
          <button
            type="button"
            aria-label="移除标题编号"
            :disabled="disabled"
            @click="editor?.removeHeadingNumbers()"
          >
            <FormatIcon name="heading-number-remove" />
          </button>
        </UiTooltip>
        <UiTooltip v-else-if="item === 'quote'" label="引用" shortcut="⇧ ⌘ U">
          <button
            type="button"
            aria-label="引用"
            :disabled="disabled"
            @click="editor?.setLinePrefix('> ')"
          >
            <FormatIcon name="quote" />
          </button>
        </UiTooltip>
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
        <UiTooltip v-else-if="item === 'ordered-list'" label="有序列表">
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
        <UiTooltip v-else-if="item === 'link'" label="链接">
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

.view-toggle {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  flex: none;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
}

.view-toggle:hover {
  background: var(--hover);
  color: var(--text);
}

.view-toggle svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
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
