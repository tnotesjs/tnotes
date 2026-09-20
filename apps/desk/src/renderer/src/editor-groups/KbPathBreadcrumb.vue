<script setup lang="ts">
/**
 * 知识库路径面包屑（自包含）。
 *
 * 从库根出发显示「库名 > notes > 0001. hello-algo.md」，点任意一段都会展开
 * **该段父目录**的同级条目下拉：目录可以继续进入，文件按统一路由打开。
 * 主进程只列一层且有拒绝名单，所以层级永远靠这里逐层请求，渲染端不缓存文件树。
 *
 * 打开规则集中在 `kbPathBreadcrumb.ts` 的纯函数里（可单测），这里只负责执行：
 * 笔记 → 复用笔记会话；文本 → 只读文本标签；已知非文本 / 画布 → 不打开并提示。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import {
  baseNameOf,
  buildKbPathSegments,
  buildNoteIndex,
  decideKbPathOpen,
  foldKbPathSegments,
  formatKbEntryBytes,
  isUnderNotesDir,
  noteIndexFromFileName,
  parentDirOf
} from './kbPathBreadcrumb'

import type { KbFileEntryDto, KnowledgeBaseDescriptor } from '../../../shared/contracts'
import type {
  KbBreadcrumbItem,
  KbPathEllipsisSegment,
  KbNoteRef,
  KbPathOpenDecision,
  KbPathSegment
} from './kbPathBreadcrumb'

const props = defineProps<{
  knowledgeBaseId: string
  /** 库根相对路径（当前正在看的文件） */
  relPath: string
  /** 兜底显示名：overview 还没加载时用标签页记住的知识库名 */
  fallbackName?: string
}>()

const editor = useEditorStore()
const workspace = useWorkspaceStore()
const baseId = useId()

const barRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)

type KbMenuState =
  | {
      mode: 'entries'
      /** 当前下拉在列的目录（'' = 库根） */
      dirRelPath: string
      /** 触发这一层的段（用于高亮「当前项」） */
      anchorRelPath: string
      anchorEl: HTMLElement | null
    }
  | {
      mode: 'hidden'
      anchorRelPath: string
      hidden: KbPathSegment[]
      anchorEl: HTMLElement | null
    }

const menu = ref<KbMenuState | null>(null)
const entries = ref<KbFileEntryDto[]>([])
const loading = ref(false)
const loadError = ref('')
const filter = ref('')
const activeIndex = ref(0)
const menuPosition = ref({ left: '8px', top: '8px', maxHeight: '60vh' })
const noteIndexMap = ref<ReadonlyMap<string, KbNoteRef>>(new Map())
let noteIndexLoadedFor: string | null = null
// 面包屑条可用宽度：只影响折叠，不影响数据
const barWidth = ref(0)
let resizeObserver: ResizeObserver | null = null
// 目录请求序号：快速连点目录时丢弃过期响应
let loadSequence = 0
// 键盘 / 点击打开后要把焦点还给哪一段
let restoreFocusEl: HTMLElement | null = null

const rootName = computed(
  () =>
    workspace.overview.allKnowledgeBases.find((item) => item.id === props.knowledgeBaseId)
      ?.displayName ??
    workspace.knowledgeBase?.displayName ??
    props.fallbackName ??
    '知识库'
)

const segments = computed(() => buildKbPathSegments(rootName.value, props.relPath))

// 每个分段大约要占的宽度（中英文混排的经验值）；至少保留「首段 + … + 末段」
const SEGMENT_WIDTH = 112
const capacity = computed(() =>
  barWidth.value > 0
    ? Math.max(3, Math.floor(barWidth.value / SEGMENT_WIDTH))
    : Number.MAX_SAFE_INTEGER
)
const items = computed<KbBreadcrumbItem[]>(() => foldKbPathSegments(segments.value, capacity.value))

const currentRelPath = computed(() => segments.value.at(-1)?.relPath ?? '')
const normalizedFilter = computed(() => filter.value.trim().toLowerCase())

const filteredEntries = computed<KbFileEntryDto[]>(() => {
  const query = normalizedFilter.value
  if (!query) return entries.value
  return entries.value.filter(
    (entry) =>
      entry.name.toLowerCase().includes(query) || entry.relPath.toLowerCase().includes(query)
  )
})

const filteredHidden = computed<KbPathSegment[]>(() => {
  if (menu.value?.mode !== 'hidden') return []
  const query = normalizedFilter.value
  if (!query) return menu.value.hidden
  return menu.value.hidden.filter(
    (segment) =>
      segment.label.toLowerCase().includes(query) || segment.relPath.toLowerCase().includes(query)
  )
})

interface KbMenuRow {
  key: string
  label: string
  meta: string
  icon: 'directory' | 'file' | 'segment'
  hint: string
  current: boolean
  /** 列表弱提示：主进程认为这个文件不太像文本 */
  unlikelyText: boolean
  pick: () => void
}

const rows = computed<KbMenuRow[]>(() => {
  if (menu.value?.mode === 'hidden') {
    return filteredHidden.value.map((segment) => ({
      key: `segment:${segment.relPath}`,
      label: segment.label,
      meta: segment.isRoot ? '库根' : '目录',
      icon: 'segment' as const,
      hint: segment.relPath || '知识库根目录',
      current: false,
      unlikelyText: false,
      pick: () => openSegment(segment, menu.value?.anchorEl ?? null)
    }))
  }
  const anchorRelPath = menu.value?.mode === 'entries' ? menu.value.anchorRelPath : ''
  return filteredEntries.value.map((entry) => ({
    key: `entry:${entry.relPath}`,
    label: entry.name,
    meta: entry.kind === 'directory' ? '' : formatKbEntryBytes(entry.bytes),
    icon: entry.kind,
    hint:
      entry.kind === 'file' && !entry.textLike ? `${entry.relPath}（可能不是文本）` : entry.relPath,
    current: entry.relPath === anchorRelPath,
    unlikelyText: entry.kind === 'file' && !entry.textLike,
    pick: () => void selectEntry(entry)
  }))
})

const listboxId = computed(() => `${baseId}-listbox`)

function menuIsOpenFor(item: KbBreadcrumbItem): boolean {
  if (!menu.value) return false
  if ('isEllipsis' in item) return menu.value.mode === 'hidden'
  return menu.value.anchorRelPath === item.relPath
}

function isCurrentItem(item: KbBreadcrumbItem): boolean {
  if ('isEllipsis' in item) return false
  return item.relPath === currentRelPath.value
}

function segmentTitle(item: KbBreadcrumbItem): string {
  if ('isEllipsis' in item) return `展开被折叠的 ${item.hidden.length} 层`
  return item.relPath || '知识库根目录'
}

function knowledgeBaseDescriptor(): KnowledgeBaseDescriptor | undefined {
  return (
    workspace.overview.allKnowledgeBases.find((item) => item.id === props.knowledgeBaseId) ??
    (workspace.knowledgeBase?.id === props.knowledgeBaseId ? workspace.knowledgeBase : undefined)
  )
}

/** 懒加载 TOC 并把「四位编号 → uuid」索引缓存起来；切库后重取 */
async function ensureNoteIndex(): Promise<void> {
  if (noteIndexLoadedFor === props.knowledgeBaseId) return
  const knowledgeBaseId = props.knowledgeBaseId
  try {
    const result = await window.desk.knowledgeBases.read(knowledgeBaseId)
    // 等待期间切了库：丢弃这次结果，避免张冠李戴
    if (knowledgeBaseId !== props.knowledgeBaseId || !result.ok) return
    noteIndexMap.value = buildNoteIndex(result.value.toc)
    noteIndexLoadedFor = knowledgeBaseId
  } catch {
    // 读不到 TOC 就退回文本打开，不阻塞面包屑
  }
}

async function decide(relPath: string, kind: 'directory' | 'file'): Promise<KbPathOpenDecision> {
  if (kind === 'file' && isUnderNotesDir(relPath) && noteIndexFromFileName(baseNameOf(relPath))) {
    await ensureNoteIndex()
  }
  return decideKbPathOpen({ relPath, kind, noteIndex: noteIndexMap.value })
}

function positionMenu(anchorEl: HTMLElement | null): void {
  const rect = anchorEl?.getBoundingClientRect()
  const width = 320
  const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) : 8
  const top = rect ? rect.bottom + 4 : 8
  menuPosition.value = {
    left: `${left}px`,
    top: `${top}px`,
    maxHeight: `${Math.max(140, window.innerHeight - top - 12)}px`
  }
}

async function loadEntries(dirRelPath: string): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  const result = await window.desk.kbFiles.list({
    knowledgeBaseId: props.knowledgeBaseId,
    relPath: dirRelPath
  })
  if (sequence !== loadSequence) return
  const openMenu = menu.value
  if (openMenu?.mode !== 'entries' || openMenu.dirRelPath !== dirRelPath) return
  loading.value = false
  if (!result.ok) {
    entries.value = []
    loadError.value = result.error.message
    return
  }
  entries.value = result.value.entries
  // 当前项（正在看的目录 / 文件）预高亮，键盘直接回车就能打开它
  const current = entries.value.findIndex((entry) => entry.relPath === openMenu.anchorRelPath)
  activeIndex.value = current >= 0 ? current : 0
}

async function focusFilter(): Promise<void> {
  await nextTick()
  // 自动聚焦输入框：打开即输入筛选，不用再点一次
  inputRef.value?.focus()
  inputRef.value?.select()
}

async function openEntriesFor(segment: KbPathSegment, anchorEl: HTMLElement | null): Promise<void> {
  const dirRelPath = parentDirOf(segment.relPath)
  menu.value = { mode: 'entries', dirRelPath, anchorRelPath: segment.relPath, anchorEl }
  restoreFocusEl = anchorEl
  filter.value = ''
  activeIndex.value = 0
  entries.value = []
  positionMenu(anchorEl)
  await loadEntries(dirRelPath)
  await focusFilter()
}

async function openHiddenFor(
  item: KbPathEllipsisSegment,
  anchorEl: HTMLElement | null
): Promise<void> {
  // 省略号段的下拉列的是被折掉的层级，不是文件系统条目
  loadSequence += 1
  menu.value = { mode: 'hidden', anchorRelPath: item.relPath, hidden: item.hidden, anchorEl }
  restoreFocusEl = anchorEl
  filter.value = ''
  activeIndex.value = 0
  entries.value = []
  loading.value = false
  loadError.value = ''
  positionMenu(anchorEl)
  await focusFilter()
}

async function openSegment(item: KbBreadcrumbItem, anchorEl: HTMLElement | null): Promise<void> {
  if ('isEllipsis' in item) return openHiddenFor(item, anchorEl)
  return openEntriesFor(item, anchorEl)
}

function onSegmentClick(item: KbBreadcrumbItem, event: MouseEvent): void {
  const anchorEl = event.currentTarget as HTMLElement | null
  // 再点同一条 = 收起（键盘 Esc 也走 close）
  if (menuIsOpenFor(item)) {
    close(true)
    return
  }
  void openSegment(item, anchorEl)
}

function onBarKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && menu.value) {
    event.preventDefault()
    close(true)
  }
}

function close(restoreFocus = false): void {
  const anchorEl = restoreFocus ? (restoreFocusEl ?? menu.value?.anchorEl ?? null) : null
  menu.value = null
  entries.value = []
  loading.value = false
  loadError.value = ''
  filter.value = ''
  activeIndex.value = 0
  if (restoreFocus) anchorEl?.focus()
}

async function enterDirectory(entry: KbFileEntryDto): Promise<void> {
  // 目录 = 推进层级，不打开文件；下拉锚点保持不动
  menu.value = {
    mode: 'entries',
    dirRelPath: entry.relPath,
    anchorRelPath: entry.relPath,
    anchorEl: menu.value?.anchorEl ?? null
  }
  filter.value = ''
  activeIndex.value = 0
  await loadEntries(entry.relPath)
  await focusFilter()
}

async function applyDecision(decision: KbPathOpenDecision): Promise<void> {
  const knowledgeBase = knowledgeBaseDescriptor()
  if (decision.action === 'enter-directory') return
  if (!knowledgeBase) {
    close()
    workspace.status = '知识库信息未加载，暂时无法打开这个文件'
    return
  }
  if (decision.action === 'open-note') {
    close()
    try {
      await workspace.openNoteByUuid(props.knowledgeBaseId, decision.note.uuid)
    } catch (cause) {
      // 笔记会话打不开时退回只读文本，至少让用户看到内容
      editor.openTextFile(knowledgeBase, decision.relPath)
      const reason = cause instanceof Error ? cause.message : String(cause)
      workspace.status = `打开笔记失败（${reason}），已按文本文件打开`
    }
    return
  }
  if (decision.action === 'open-text') {
    editor.openTextFile(knowledgeBase, decision.relPath)
    if (decision.notice) workspace.status = decision.notice
    close()
    return
  }
  close()
  workspace.status = decision.reason
}

async function selectEntry(entry: KbFileEntryDto): Promise<void> {
  if (entry.kind === 'directory') {
    await enterDirectory(entry)
    return
  }
  await applyDecision(await decide(entry.relPath, 'file'))
}

function moveActive(delta: number): void {
  const length = rows.value.length
  if (length === 0) return
  activeIndex.value = (activeIndex.value + delta + length) % length
}

function selectActive(): void {
  const row = rows.value[activeIndex.value]
  if (row) row.pick()
}

function onFilterKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    selectActive()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }
}

function onDocumentPointerDown(event: Event): void {
  if (!menu.value) return
  const target = event.target as Node | null
  if (menuRef.value?.contains(target) || barRef.value?.contains(target)) return
  close()
}

function onDocumentFocusIn(event: Event): void {
  if (!menu.value) return
  const target = event.target as Node | null
  if (menuRef.value?.contains(target) || barRef.value?.contains(target)) return
  close()
}

function closeOnViewportChange(): void {
  if (menu.value) close()
}

watch(
  () => props.relPath,
  () => close()
)

watch(
  () => props.knowledgeBaseId,
  () => {
    noteIndexLoadedFor = null
    noteIndexMap.value = new Map()
    close()
  }
)

watch(filter, () => {
  activeIndex.value = 0
})

watch(rows, (next) => {
  if (activeIndex.value >= next.length) activeIndex.value = Math.max(0, next.length - 1)
})

watch(activeIndex, async () => {
  await nextTick()
  const active = menuRef.value?.querySelector<HTMLElement>('.kb-path-row.is-active')
  if (active && typeof active.scrollIntoView === 'function') {
    active.scrollIntoView({ block: 'nearest' })
  }
})

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('focusin', onDocumentFocusIn)
  window.addEventListener('resize', closeOnViewportChange)
  window.addEventListener('scroll', closeOnViewportChange, true)
  window.addEventListener('blur', closeOnViewportChange)
  if (typeof ResizeObserver !== 'undefined' && barRef.value) {
    resizeObserver = new ResizeObserver((records) => {
      barWidth.value = records[0]?.contentRect.width ?? 0
    })
    resizeObserver.observe(barRef.value)
  }
  void ensureNoteIndex()
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('focusin', onDocumentFocusIn)
  window.removeEventListener('resize', closeOnViewportChange)
  window.removeEventListener('scroll', closeOnViewportChange, true)
  window.removeEventListener('blur', closeOnViewportChange)
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <nav ref="barRef" class="kb-path-breadcrumb" aria-label="知识库路径" @keydown="onBarKeydown">
    <template
      v-for="(item, index) in items"
      :key="'isEllipsis' in item ? 'ellipsis' : item.relPath || 'root'"
    >
      <span v-if="index > 0" class="kb-path-sep" aria-hidden="true">›</span>
      <button
        type="button"
        class="kb-path-segment"
        :class="{
          'is-current': isCurrentItem(item),
          'is-ellipsis': 'isEllipsis' in item,
          'is-open': menuIsOpenFor(item)
        }"
        :title="segmentTitle(item)"
        :aria-label="'isEllipsis' in item ? segmentTitle(item) : `${item.label} 的目录内容`"
        aria-haspopup="dialog"
        :aria-expanded="menuIsOpenFor(item)"
        @click="onSegmentClick(item, $event)"
      >
        {{ item.label }}
      </button>
    </template>
  </nav>

  <Teleport to="body">
    <div
      v-if="menu"
      ref="menuRef"
      class="kb-path-menu"
      role="dialog"
      aria-label="知识库路径选择"
      :style="menuPosition"
      @mousedown.prevent
    >
      <input
        ref="inputRef"
        v-model="filter"
        class="kb-path-filter"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="筛选名称…"
        aria-label="筛选目录内容"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="true"
        :aria-controls="listboxId"
        :aria-activedescendant="rows.length > 0 ? `${baseId}-row-${activeIndex}` : undefined"
        @keydown="onFilterKeydown"
      />
      <p v-if="loading" class="kb-path-note">正在读取…</p>
      <p v-else-if="loadError" class="kb-path-note is-error" role="alert">{{ loadError }}</p>
      <ul v-else :id="listboxId" class="kb-path-list" role="listbox" aria-label="目录内容">
        <li v-if="rows.length === 0" class="kb-path-empty">没有匹配的条目</li>
        <li
          v-for="(row, index) in rows"
          :id="`${baseId}-row-${index}`"
          :key="row.key"
          class="kb-path-row"
          :class="{
            'is-active': index === activeIndex,
            'is-current': row.current,
            'is-unlikely-text': row.unlikelyText
          }"
          role="option"
          :aria-selected="index === activeIndex"
          :title="row.hint"
          @click="row.pick()"
        >
          <svg
            v-if="row.icon === 'directory'"
            class="kb-path-icon"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path
              d="M1.5 4.2A1.7 1.7 0 0 1 3.2 2.5h2.4l1.3 1.5h5.9a1.7 1.7 0 0 1 1.7 1.7v6.1a1.7 1.7 0 0 1-1.7 1.7H3.2a1.7 1.7 0 0 1-1.7-1.7V4.2Z"
            />
          </svg>
          <svg
            v-else-if="row.icon === 'file'"
            class="kb-path-icon"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d="M4 1.5h5.2L13 5.3v9.2H4V1.5Z" />
            <path d="M9.2 1.5v4h3.8" />
          </svg>
          <svg v-else class="kb-path-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 8h12" />
          </svg>
          <span class="kb-path-name">{{ row.label }}</span>
          <span v-if="row.meta" class="kb-path-meta">{{ row.meta }}</span>
        </li>
      </ul>
    </div>
  </Teleport>
</template>

<style scoped>
.kb-path-breadcrumb {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font: 10px/1.6 var(--font-sans);
  white-space: nowrap;
}

.kb-path-sep {
  flex: none;
  opacity: 0.55;
}

.kb-path-segment {
  flex: none;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.kb-path-segment:hover,
.kb-path-segment:focus-visible {
  outline: none;
  background: var(--hover);
  color: var(--text);
}

.kb-path-segment.is-current {
  color: var(--text);
}

.kb-path-segment.is-open {
  border-color: var(--border);
  background: var(--panel);
  color: var(--text);
}

.kb-path-segment.is-ellipsis {
  letter-spacing: 2px;
}

.kb-path-menu {
  position: fixed;
  z-index: 1200;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-width: calc(100vw - 16px);
  overflow: hidden;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgb(0 0 0 / 28%);
}

.kb-path-filter {
  flex: none;
  margin: 6px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--editor-bg);
  color: var(--text);
  font: 12px/1.4 var(--font-sans);
}

.kb-path-filter:focus {
  outline: none;
  border-color: var(--accent);
}

.kb-path-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0 6px 6px;
  list-style: none;
}

.kb-path-note,
.kb-path-empty {
  margin: 0;
  padding: 8px 12px;
  color: var(--muted);
  font: 12px/1.6 var(--font-sans);
}

.kb-path-note.is-error {
  color: var(--danger, #e5484d);
}

.kb-path-row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  padding: 3px 7px;
  border-radius: 5px;
  cursor: pointer;
  font: 12px/1.4 var(--font-sans);
}

.kb-path-row.is-active {
  background: var(--hover);
}

.kb-path-row.is-current {
  color: var(--accent-strong);
}

.kb-path-row.is-current.is-active {
  background: var(--selected);
}

.kb-path-icon {
  flex: none;
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.8;
}

.kb-path-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-path-row.is-unlikely-text .kb-path-name {
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}

.kb-path-meta {
  flex: none;
  margin-left: auto;
  color: var(--muted);
  font-size: 10px;
}
</style>
