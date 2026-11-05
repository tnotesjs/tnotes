<script setup lang="ts">
/**
 * 工具栏「插入」菜单：和斜杠菜单同一份清单、同一套列表外观，顶部多一个搜索框，
 * 简写（`swdt`、`表格`）同样能过滤。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

import { BlockPicker } from '../markdown/blockPicker'
import { blockTypeOfMenuItem, canNest } from '../markdown/blockSpecs'
import { INSERT_ITEMS, filterInsertItems } from '../markdown/insertCatalog'

import type { InsertItem } from '../markdown/insertCatalog'

const props = defineProps<{
  disabled: boolean
  active: boolean
  /** 宿主不支持的块（README 没有画布） */
  exclude?: readonly string[]
  /** 打开菜单时读一次插入点所在的父块类型（null = 文档根）；没给 resolveItems 时用 */
  resolveParent?: () => string | null
  /** 编辑器给出的可插入项（已按宿主与嵌套规则过滤） */
  resolveItems?: () => InsertItem[]
}>()

const emit = defineEmits<{ select: [id: string] }>()

const menuId = useId()
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const listHost = ref<HTMLElement | null>(null)
const search = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')
const position = ref({ left: '0px', top: '0px' })
let base: InsertItem[] = []
let picker: BlockPicker | null = null

function itemsHere(): InsertItem[] {
  const fromEditor = props.resolveItems?.()
  const parent = props.resolveParent?.() ?? null
  const items =
    fromEditor && fromEditor.length > 0
      ? fromEditor
      : INSERT_ITEMS.filter(
          (item) => !item.slashOnly && canNest(parent, blockTypeOfMenuItem(item.id))
        )
  return items.filter((item) => !props.exclude?.includes(item.id))
}

function render(): void {
  picker?.setItems(filterInsertItems(base, query.value), query.value.trim() === '')
}

function close(restoreFocus = false): void {
  open.value = false
  picker = null
  if (restoreFocus) trigger.value?.focus()
}

async function show(): Promise<void> {
  if (props.disabled || !trigger.value || open.value) return
  base = itemsHere()
  query.value = ''
  const rect = trigger.value.getBoundingClientRect()
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 288))}px`,
    top: `${rect.bottom + 6}px`
  }
  open.value = true
  await nextTick()
  if (!open.value || !listHost.value) return
  picker = new BlockPicker({ onPick: (item) => select(item.id) })
  listHost.value.replaceChildren(picker.dom)
  picker.dom.style.maxHeight = `${Math.max(160, window.innerHeight - rect.bottom - 70)}px`
  render()
  search.value?.focus()
}

function onTriggerClick(): void {
  if (open.value) close(true)
  else void show()
}

function select(id: string): void {
  close()
  emit('select', id)
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    picker?.move(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    picker?.pickSelected()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  } else if (event.key === 'Tab') {
    close(true)
  }
}

function onOutside(event: Event): void {
  const target = event.target as Node | null
  if (!menu.value?.contains(target) && !trigger.value?.contains(target)) close()
}

function onViewportChange(event: Event): void {
  if (event.target instanceof Node && menu.value?.contains(event.target)) return
  close()
}

watch(query, render)

watch(
  () => [props.disabled, props.active],
  ([disabled, active]) => {
    if (disabled || !active) close()
  }
)

onMounted(() => {
  document.addEventListener('pointerdown', onOutside, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('blur', onViewportChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('blur', onViewportChange)
})
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="block-insert-trigger"
    aria-label="插入"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? menuId : undefined"
    :disabled="disabled"
    @mousedown.prevent
    @click="onTriggerClick"
    @keydown.down.prevent="show()"
    @keydown.up.prevent="show()"
  >
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true">
      <path d="M0 0h1024v1024H0z" fill="none" />
      <path fill="currentColor" d="M482 152h60q8 0 8 8v704q0 8-8 8h-60q-8 0-8-8V160q0-8 8-8" />
      <path fill="currentColor" d="M192 474h672q8 0 8 8v60q0 8-8 8H160q-8 0-8-8v-60q0-8 8-8Z" />
    </svg>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      :id="menuId"
      ref="menu"
      class="block-insert-menu"
      role="dialog"
      aria-label="插入"
      :style="position"
    >
      <label class="block-insert-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          ref="search"
          v-model="query"
          type="text"
          spellcheck="false"
          placeholder="搜索，如 表格、swdt"
          aria-label="搜索要插入的块"
          @keydown="onSearchKeydown"
        />
      </label>
      <div ref="listHost" class="block-insert-list" />
    </div>
  </Teleport>
</template>

<style scoped>
.block-insert-trigger {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.block-insert-trigger:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.block-insert-trigger:disabled {
  cursor: not-allowed;
}

.block-insert-trigger svg {
  width: 16px;
  height: 16px;
  display: block;
}

.block-insert-menu {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  overflow: hidden;
  color: var(--text);
  background: var(--raised, var(--panel));
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--tn-shadow-2);
}

.block-insert-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 6px 2px;
  padding: 0 8px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input-bg);
}

.block-insert-search:focus-within {
  border-color: var(--accent);
}

.block-insert-search svg {
  flex: none;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--muted);
  stroke-width: 2;
  stroke-linecap: round;
}

.block-insert-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: 13px var(--font-sans);
}
</style>
