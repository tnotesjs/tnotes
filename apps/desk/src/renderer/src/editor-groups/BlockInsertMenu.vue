<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

import { TN_NOTES_SLASH_ITEMS } from '../markdown/slashMenu'

const props = defineProps<{
  disabled: boolean
  active: boolean
}>()

const emit = defineEmits<{ select: [id: string] }>()

const menuIds = [
  'tip',
  'info',
  'warning',
  'danger',
  'details',
  'code',
  'code-group',
  'table',
  'swiper',
  'mermaid',
  'mindmap',
  'canvas',
  'bilibili',
  'word-list',
  'notes-table',
  'footprints'
] as const
const items = menuIds.map((id) => {
  if (id === 'canvas') return { id, label: '画布' }
  if (id === 'table') return { id, label: '表格' }
  const found = TN_NOTES_SLASH_ITEMS.find((item) => item.id === id)
  return { id, label: found?.label ?? id }
})

const menuId = useId()
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const position = ref({ left: '0px', top: '0px', maxHeight: '320px' })

function close(restoreFocus = false): void {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}

function focusAt(index: number): void {
  menu.value?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
}

async function show(focusMenu = false): Promise<void> {
  if (props.disabled || !trigger.value) return
  if (open.value) {
    if (focusMenu) focusAt(0)
    return
  }
  const rect = trigger.value.getBoundingClientRect()
  position.value = {
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 308))}px`,
    top: `${rect.bottom + 6}px`,
    maxHeight: `${Math.max(0, window.innerHeight - rect.bottom - 14)}px`
  }
  open.value = true
  await nextTick()
  if (open.value && focusMenu) focusAt(0)
}

function onTriggerClick(): void {
  if (open.value) close(true)
  else void show(true)
}

function select(id: string): void {
  close()
  emit('select', id)
}

function onKeydown(event: KeyboardEvent): void {
  const buttons = [...(menu.value?.querySelectorAll('button') ?? [])]
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  } else if (event.key === 'Tab') {
    close(true)
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    focusAt(index)
  }
}

function onOutside(event: Event): void {
  const target = event.target as Node | null
  if (!menu.value?.contains(target) && !trigger.value?.contains(target)) close()
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (!open.value || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  close(true)
}

function onViewportChange(event: Event): void {
  if (event.target instanceof Node && menu.value?.contains(event.target)) return
  close()
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close()
  }
)

watch(
  () => props.active,
  (active) => {
    if (!active) close()
  }
)

onMounted(() => {
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('keydown', onDocumentKeydown, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('blur', onViewportChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('keydown', onDocumentKeydown, true)
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
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-controls="open ? menuId : undefined"
    :disabled="disabled"
    @mousedown.prevent
    @click="onTriggerClick"
    @keydown.down.prevent="show(true)"
    @keydown.up.prevent="show(true)"
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
      role="menu"
      aria-label="插入"
      :style="position"
      @mousedown.prevent
      @keydown="onKeydown"
    >
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        role="menuitem"
        @click="select(item.id)"
      >
        {{ item.label }}
      </button>
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
  width: 18px;
  height: 18px;
  display: block;
}

.block-insert-menu {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(8, auto);
  width: 300px;
  max-width: calc(100vw - 16px);
  column-gap: 4px;
  overflow-y: auto;
  padding: 6px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgb(0 0 0 / 28%);
}

.block-insert-menu button {
  display: block;
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  border: 0;
  border-radius: 5px;
  color: inherit;
  background: transparent;
  font: 13px var(--font-sans);
  text-align: left;
  cursor: pointer;
}

.block-insert-menu button:hover,
.block-insert-menu button:focus-visible {
  outline: none;
  background: var(--hover);
}
</style>
