<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import type { InlineFormat } from '@tnotesjs/mindmap-core'
import { altShortcut, primaryShortcut } from './platform'

const props = withDefaults(
  defineProps<{
    mode: 'text' | 'nodes'
    /** Viewport coords for `fixed` placement (outline / text selection). */
    position?: { left: number; top: number }
    /**
     * `canvas-bottom`: pin to the mindmap canvas (absolute) so page scroll cannot
     * leave a floating orphan over foreign content.
     * `fixed`: follow `position` in viewport space (outline / text carets).
     */
    placement?: 'fixed' | 'canvas-bottom'
    activeFormats?: Partial<Record<InlineFormat, boolean>>
    /** 宿主没有插入图片入口时隐藏（脑图编辑框） */
    canInsertImage?: boolean
    /** 选中的全是图片节点时为 false：图片说明是纯文本，不出格式按钮 */
    formattable?: boolean
  }>(),
  {
    placement: 'fixed',
    position: undefined,
    activeFormats: undefined,
    canInsertImage: true,
    formattable: true
  }
)

const emit = defineEmits<{
  format: [format: InlineFormat]
  task: []
  image: []
  link: []
  copy: []
  clear: []
  delete: []
}>()

const formats: Array<{ id: InlineFormat; text: string; label: string }> = [
  { id: 'bold', text: 'B', label: `加粗 (${primaryShortcut('B')})` },
  { id: 'italic', text: 'I', label: `斜体 (${primaryShortcut('I')})` },
  { id: 'underline', text: 'U', label: `下划线 (${primaryShortcut('U')})` },
  { id: 'strike', text: 'S', label: `删除线 (${primaryShortcut('Enter')})` },
  { id: 'highlight', text: '▰', label: '高亮' }
]

const toolbarRef = ref<HTMLElement | null>(null)
const toolbarSize = ref({ width: 430, height: 46 })
const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 8

const toolbarStyle = computed(() => {
  if (props.placement === 'canvas-bottom') return undefined
  const point = props.position
  if (!point) return undefined
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight
  const { width, height } = toolbarSize.value
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN)
  const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN)
  const left = Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, point.left - width / 2))
  const preferredTop = point.top - height - ANCHOR_GAP
  const belowTop = point.top + ANCHOR_GAP
  const top = Math.min(
    maxTop,
    Math.max(VIEWPORT_MARGIN, preferredTop < VIEWPORT_MARGIN ? belowTop : preferredTop)
  )
  return { left: `${left}px`, top: `${top}px` }
})

function measureToolbar() {
  nextTick(() => {
    const rect = toolbarRef.value?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    toolbarSize.value = { width: rect.width, height: rect.height }
  })
}

watch(
  () => [props.mode, props.placement, props.position?.left, props.position?.top],
  measureToolbar
)
onMounted(() => {
  measureToolbar()
  window.addEventListener('resize', measureToolbar)
})
onBeforeUnmount(() => window.removeEventListener('resize', measureToolbar))
</script>

<template>
  <div
    ref="toolbarRef"
    class="selection-toolbar"
    :class="{ 'is-canvas-anchored': placement === 'canvas-bottom' }"
    :style="toolbarStyle"
    role="toolbar"
    :aria-label="mode === 'text' ? '文字格式工具栏' : '多主题工具栏'"
    @pointerdown.prevent
    @mousedown.prevent
  >
    <template v-if="formattable">
      <button
        v-for="item in formats"
        :key="item.id"
        type="button"
        class="format-button"
        :class="[{ active: activeFormats?.[item.id] }, `is-${item.id}`]"
        :data-tooltip="item.label"
        :aria-label="item.label"
        @click="emit('format', item.id)"
      >
        <AppIcon v-if="item.id === 'highlight'" name="highlight" :size="21" />
        <template v-else>{{ item.text }}</template>
      </button>
      <span class="toolbar-divider" />
    </template>
    <button
      type="button"
      class="tool-button"
      :data-tooltip="`添加/取消待办 (${primaryShortcut('L', { shift: true })})`"
      aria-label="添加或取消待办"
      @click="emit('task')"
    >
      <AppIcon name="check" :size="20" />
    </button>
    <template v-if="mode === 'text'">
      <button
        v-if="canInsertImage"
        type="button"
        class="tool-button"
        :data-tooltip="`添加图片 (${altShortcut('Enter')})`"
        aria-label="添加图片"
        @click="emit('image')"
      >
        <AppIcon name="image" :size="20" />
      </button>
      <button
        type="button"
        class="tool-button"
        :data-tooltip="`添加链接 (${primaryShortcut('K')})`"
        aria-label="添加链接"
        @click="emit('link')"
      >
        <AppIcon name="link" :size="20" />
      </button>
      <button
        type="button"
        class="tool-button"
        :data-tooltip="`行内代码 (${primaryShortcut('E')})`"
        aria-label="行内代码"
        @click="emit('format', 'code')"
      >
        <AppIcon name="code" :size="20" />
      </button>
    </template>
    <button
      v-else
      type="button"
      class="tool-button"
      :data-tooltip="`复制 (${primaryShortcut('C')})`"
      aria-label="复制所选主题"
      @click="emit('copy')"
    >
      <AppIcon name="copy" :size="20" />
    </button>
    <span class="toolbar-divider" />
    <button
      v-if="formattable"
      type="button"
      class="tool-button"
      :data-tooltip="`清除样式 (${primaryShortcut('\\')})`"
      aria-label="清除样式"
      @click="emit('clear')"
    >
      <AppIcon name="clearFormat" :size="20" />
    </button>
    <button
      type="button"
      class="tool-button danger"
      :data-tooltip="`删除 (${primaryShortcut('D', { shift: true })})`"
      aria-label="删除"
      @click="emit('delete')"
    >
      <AppIcon name="trash" :size="20" />
    </button>
  </div>
</template>

<style scoped>
.selection-toolbar {
  position: fixed;
  z-index: 120;
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 46px;
  padding: 5px 7px;
  border: 1px solid color-mix(in srgb, var(--mm-border) 85%, transparent);
  border-radius: 11px;
  background: color-mix(in srgb, var(--mm-panel-bg) 94%, #545760 6%);
  color: var(--mm-text);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.24);
}
.selection-toolbar.is-canvas-anchored {
  position: absolute;
  left: 50%;
  right: auto;
  top: auto;
  bottom: 18px;
  transform: translateX(-50%);
}
.format-button,
.tool-button {
  position: relative;
  display: inline-flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 21px;
}
.format-button::after,
.tool-button::after {
  position: absolute;
  z-index: 2;
  /* 宿主可能有全局 [data-tooltip]::after（例如 Desk 往下弹），这里把方向和显隐都定死 */
  top: auto;
  bottom: calc(100% + 9px);
  min-width: 0;
  border: 0;
  visibility: visible;
  transition: none;
  left: 50%;
  width: max-content;
  max-width: min(260px, calc(100vw - 16px));
  padding: 7px 10px;
  border-radius: 7px;
  background: #f5f5f7;
  color: #25262b;
  box-shadow: 0 5px 18px rgb(0 0 0 / 0.22);
  content: attr(data-tooltip);
  font-family: system-ui, sans-serif;
  font-size: 13px;
  font-style: normal;
  font-weight: 500;
  line-height: 1.2;
  opacity: 0;
  pointer-events: none;
  transform: translateX(-50%);
  white-space: nowrap;
}
.format-button:hover::after,
.tool-button:hover::after,
.format-button:focus-visible::after,
.tool-button:focus-visible::after {
  opacity: 1;
}
.format-button:hover,
.tool-button:hover,
.format-button.active {
  background: var(--mm-hover);
  color: var(--mm-accent);
}
.format-button.is-bold {
  font-weight: 800;
}
.format-button.is-italic {
  font-family: Georgia, serif;
  font-style: italic;
}
.format-button.is-underline {
  text-decoration: underline;
  text-underline-offset: 4px;
}
.format-button.is-strike {
  text-decoration: line-through;
}
.format-button.is-highlight {
  color: #d3c900;
}
.tool-button.danger {
  color: #e14f5b;
}
.toolbar-divider {
  width: 1px;
  height: 25px;
  margin: 0 3px;
  background: var(--mm-border);
}
</style>
