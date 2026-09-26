<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import UiTooltip from '../components/UiTooltip.vue'
import NoteDoneToggle from '../components/NoteDoneToggle.vue'
import OutlineIcon from '../components/OutlineIcon.vue'
import PageWidthIcon from '../components/PageWidthIcon.vue'
import HeadingMenu from './HeadingMenu.vue'
import FormatIcon from './FormatIcon.vue'
import FormatOverflowBar from './FormatOverflowBar.vue'
import BlockInsertMenu from './BlockInsertMenu.vue'
import KbPathBreadcrumb from './KbPathBreadcrumb.vue'
import NoteAssetsPanel from './NoteAssetsPanel.vue'
import LivePreviewEditor from '../livePreview/LivePreviewEditor.vue'
import {
  frontmatterDescriptionChange,
  readFrontmatterFields
} from '../livePreview/frontmatterFields'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { useAgentStore } from '../agent/agentStore'

import { registerHeadingFoldRunner } from '../commands/headingFoldBridge'
import { registerViewToggleRunner } from '../commands/viewToggleBridge'
import {
  anchorWithSource,
  captureDtoFromPayload,
  clearSelection,
  invalidateSelection,
  reportSelection,
  type EditorSelectionAnchor,
  type EditorSelectionPayload,
  type SelectionReportIdentity
} from '../selection/selectionReporter'
import {
  pinnedContext,
  reportPinValidation,
  revalidatePinFromDisk
} from '../context/pinnedContextStore'
import { registerPinSelectionRunner } from '../commands/pinSelectionBridge'
import { findTab } from './layoutModel'
import { validateTextAnchor } from '../selection/pinnedAnchorCheck'
import { insertableImageMarkdown } from './noteAssets'
import { pastedImageMarkdown } from '../editor/markdown/pasteImageWidth'
import { insertExcalidrawCanvas } from '../editor/excalidraw/insertCanvas'
import { TN_NOTES_SLASH_ITEMS } from '../markdown/slashMenu'
import { HEADING_NUMBER_DEFAULT_MAX_DEPTH } from '../../../shared/headingNumbering'

import type {
  NoteEditorTab,
  NoteViewMode,
  PinSelectionRequest,
  PinnedSelectionAnchor
} from '../../../shared/contracts'
import type { HeadingFoldCommand } from '../livePreview/headingFold'

interface MarkdownEditorHandle {
  insertTextAt(text: string, position?: number): void
  /** 跳到指定行（1-based）并聚焦。 */
  revealLine?(line: number): boolean
  revealReference?(rawPath: string): boolean
  wrapSelection(prefix: string, suffix: string, placeholder?: string): void
  prefixSelection(prefix: string): void
  setLinePrefix(prefix: string): void
  insertTable(): void
  addHeadingNumbers(maxDepth: number): void
  removeHeadingNumbers(): void
  applyHeadingFold?(command: HeadingFoldCommand): boolean
  /** 采集当前选区（偏移就是源码偏移，两种视图一致） */
  selectionCapture?(): EditorSelectionPayload | null
  /** 可固定的选区（采集结果 + 可校验锚点）；拿不到锚点时返回 null */
  pinnableSelection?(): { capture: EditorSelectionPayload; anchor: EditorSelectionAnchor } | null
  /** 校验固定锚点；返回 null 表示当前视图验不了（交给内容级兜底） */
  validatePinnedAnchor?(
    anchor: EditorSelectionAnchor,
    expected: string
  ): { valid: boolean; reason?: string } | null
  /** 「查看」固定上下文：重新选出固定时的范围并滚到可见 */
  revealPinnedAnchor?(anchor: EditorSelectionAnchor): boolean
  flush(): void
  /** 侧栏改 description 时走编辑器事务，保留撤销栈 */
  getView?: () => {
    state: { doc: { toString(): string; length: number } }
    dispatch(tr: { changes: { from: number; to: number; insert: string } }): void
  } | null
}

const props = defineProps<{ tab: NoteEditorTab; groupId: string; active: boolean }>()
const editor = useEditorStore()
const workspace = useWorkspaceStore()
const key = computed(() => `${props.tab.knowledgeBaseId}:${props.tab.noteUuid}`)
const session = computed(() =>
  workspace.getDocumentSession(props.tab.knowledgeBaseId, props.tab.noteUuid)
)

/**
 * 标题编号左侧的「完成」开关（与目录树里的圆点同一个组件）。
 *
 * 状态直接读会话里的 `document.config.done` —— 主进程就是从 TOC 取的这一位，
 * 切换完成后 `toggleDone` 会把新的 `mutation.note` 同时写回会话与整棵树，两边天然同步，
 * 不必再遍历 TOC 找节点。显示与否跟目录树共用同一个设置，只读时置灰（与同排其它按钮一致）。
 */
const showNoteDone = computed(() => workspace.settings?.toc?.showNoteStatus !== false)
const noteDone = computed(() => session.value?.document.config.done === true)
const noteDoneDisabled = computed(() => Boolean(session.value?.document.readOnly))

async function toggleNoteDone(): Promise<void> {
  if (!session.value) return
  await workspace.toggleDone({ uuid: props.tab.noteUuid, completed: noteDone.value })
}

/** 可视化与源码是同一个编辑器实例的两种显示 */
const markdownEditor = ref<MarkdownEditorHandle | null>(null)
const pageWidthLabel = computed(() => (props.tab.pageWidth === 'wide' ? '超宽显示' : '标准页宽'))
// 标题编号深度生效值：库级约定（tnotes.json）→ desk 全局 → 内置默认
const headingNumberMaxDepth = computed(
  () =>
    workspace.overview.allKnowledgeBases.find((kb) => kb.id === props.tab.knowledgeBaseId)
      ?.headingNumberMaxDepth ??
    workspace.settings?.headingNumberMaxDepth ??
    HEADING_NUMBER_DEFAULT_MAX_DEPTH
)
/** 侧边属性栏开关：复用 tab.noteAssetsVisible（目录右键「本笔记资源」也会打开） */
const propertiesOpen = computed(() => {
  const located = findTab(editor.layout, props.tab.id)
  const tab = located?.tab.type === 'note' ? located.tab : props.tab
  return tab.noteAssetsVisible === true
})

const outlineVisible = computed(() => {
  const located = findTab(editor.layout, props.tab.id)
  const tab = located?.tab.type === 'note' ? located.tab : props.tab
  return tab.outlineVisible !== false
})

const frontmatterFields = computed(() => readFrontmatterFields(session.value?.content ?? ''))
const descriptionDraft = ref('')
const descriptionFocused = ref(false)
/** 侧栏页签：打开时默认「设置」 */
const sideTab = ref<'settings' | 'assets'>('settings')

watch(
  () => frontmatterFields.value.description,
  (value) => {
    if (!descriptionFocused.value) descriptionDraft.value = value
  },
  { immediate: true }
)

watch(key, () => {
  descriptionFocused.value = false
  descriptionDraft.value = readFrontmatterFields(session.value?.content ?? '').description
  sideTab.value = 'settings'
})

const titleInput = ref<HTMLInputElement | null>(null)
const editingTitle = ref(false)
const titleDraft = ref('')
const renaming = ref(false)
const headingLevel = ref<number | null>(null)
const formatDisabled = computed(() => !session.value?.document || session.value.document.readOnly)
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
  'inline-code',
  'quote',
  'unordered-list',
  'ordered-list',
  'checkbox',
  'link',
  'divider'
] as const

watch(key, () => {
  editingTitle.value = false
})

watch(
  () =>
    props.active &&
    editor.titleEditNote?.knowledgeBaseId === props.tab.knowledgeBaseId &&
    editor.titleEditNote?.noteUuid === props.tab.noteUuid &&
    Boolean(session.value?.document) &&
    !session.value?.document.readOnly,
  async (shouldEdit) => {
    if (!shouldEdit || renaming.value) return
    if (!editor.consumeTitleEdit(props.tab.knowledgeBaseId, props.tab.noteUuid)) return
    await editTitle()
  },
  { flush: 'post', immediate: true }
)

/* ------------------------------------------------------------------ */
/* 本机 MCP：选区快照上报（渲染端是快照的唯一来源）                     */
/* ------------------------------------------------------------------ */

/** 是否"当前活动编辑器"：活动标签 + 活动分组都满足才行（后台挂载的编辑器不许覆盖） */
const isActiveEditor = computed(() => props.active && editor.activeGroupId === props.groupId)

/**
 * 快照归属者：分组 + 标签。
 *
 * 切换活动分组时"新活动编辑器上报"与"旧编辑器失效"在同一个 tick 里排队执行、顺序不保证；
 * 上报模块只允许归属者清空，所以旧编辑器不会把新编辑器刚采集的选区抹掉。
 */
const selectionOwner = computed(() => `${props.groupId}:${props.tab.id}`)

const hasUnsavedChanges = computed(() => Boolean(session.value?.dirty))

/** 快照的身份部分：笔记 / 知识库 / 编辑器状态，必须来自同一次读取（原子） */
const selectionIdentity = computed<SelectionReportIdentity | null>(() => {
  const document = session.value?.document
  const kb = workspace.knowledgeBase
  if (!document || !kb || kb.id !== props.tab.knowledgeBaseId) return null
  const collector = props.tab.viewMode === 'source' ? 'source' : 'visual'
  return {
    knowledgeBase: { id: kb.id, name: kb.displayName || kb.name, rootPath: kb.rootPath },
    note: { id: document.uuid, title: document.title, absolutePath: document.filePath },
    editor: {
      viewMode: props.tab.viewMode,
      contentSource: hasUnsavedChanges.value ? 'draft' : 'disk',
      hasUnsavedChanges: hasUnsavedChanges.value,
      revision: document.revision,
      collector
    }
  }
})

/** 编辑器报告选区变化：只有活动编辑器才写入快照 */
function handleEditorSelection(payload: EditorSelectionPayload): void {
  const identity = selectionIdentity.value
  if (!identity || !isActiveEditor.value) return
  useAgentStore().setSelection(
    payload.empty
      ? null
      : {
          knowledgeBaseId: identity.knowledgeBase.id,
          noteUuid: identity.note.id,
          text: payload.selectedText,
          range: payload.range
        }
  )
  if (payload.empty) {
    clearSelection(selectionOwner.value, identity.note.id)
    return
  }
  reportSelection(selectionOwner.value, identity, payload)
}

/** 主动采集一次（切回本标签、挂载完成、外部刷新后调用） */
function refreshSelection(): void {
  if (!isActiveEditor.value) return
  const payload = markdownEditor.value?.selectionCapture?.()
  if (payload) handleEditorSelection(payload)
}

// 切笔记：旧快照立刻失效（新笔记要等它自己的有效选区）
watch(key, (_next, previous) => {
  if (previous && previous !== key.value)
    invalidateSelection(selectionOwner.value, '切换到另一篇笔记')
  void nextTick(refreshSelection)
})

// 活动编辑器易主：本编辑器成为活动方时重新采集；不再是活动方时让旧快照失效
watch(isActiveEditor, (active, wasActive) => {
  if (active) {
    void nextTick(refreshSelection)
    return
  }
  if (wasActive) invalidateSelection(selectionOwner.value, '切换到其它编辑器')
})

// 磁盘内容被外部改动：编辑器内容与磁盘不再一致，范围不可信
watch(
  () => session.value?.externalConflict,
  (conflict) => {
    if (conflict) invalidateSelection(selectionOwner.value, '磁盘内容已被外部修改')
  }
)

/** 标题折叠命令的执行者：命令面板只认识 `runHeadingFold`，交给当前编辑器。 */
watch(
  [markdownEditor, () => props.active],
  () => {
    // 非活动标签页不碰 runner：它可能正被别的标签页注册着
    if (!props.active) return
    const handle = markdownEditor.value
    registerHeadingFoldRunner(
      handle?.applyHeadingFold ? (command) => handle.applyHeadingFold?.(command) ?? false : null
    )
  },
  { immediate: true }
)

/* ------------------------------------------------------------------ */
/* 固定选区上下文（临时固定给 Agent 用，不跟随活动选区）               */
/* ------------------------------------------------------------------ */

/**
 * 这个标签页是不是当前固定上下文的来源。
 *
 * 归属记的是「分组 + 标签」（DTO 里都存着），但判定只认**标签 id**：
 * 拆分 / 拖拽会重建分组，分组 id 变了并不代表来源标签被关掉；
 * 反过来，同一笔记的**另一份**标签 id 不同，不会被误清。
 */
const pinOwner = computed(() => {
  const context = pinnedContext.value
  if (!context?.owner) return null
  return context.owner.tabId === props.tab.id ? context : null
})

/**
 * 把当前选区固定为 Agent 上下文（右键菜单 / 快捷键 / 命令面板共用）。
 *
 * 固定的是**不可变快照 + 校验锚点**：拿不到可靠锚点时明确拒绝，
 * 而不是固定一份以后验不了的上下文。
 */
async function pinCurrentSelection(): Promise<void> {
  const identity = selectionIdentity.value
  const handle = markdownEditor.value
  if (!identity || !handle?.pinnableSelection) {
    workspace.status = '当前没有可固定的正文选区。'
    return
  }
  const pinnable = handle.pinnableSelection()
  if (!pinnable) {
    workspace.status = '当前选区无法固定：没有选中内容，或选了多个不连续的范围。'
    return
  }
  const request: PinSelectionRequest = {
    owner: {
      groupId: props.groupId,
      tabId: props.tab.id,
      knowledgeBaseId: props.tab.knowledgeBaseId,
      noteUuid: props.tab.noteUuid
    },
    knowledgeBase: identity.knowledgeBase,
    note: identity.note,
    editor: {
      viewMode: identity.editor.viewMode,
      contentSource: identity.editor.contentSource,
      hasUnsavedChanges: identity.editor.hasUnsavedChanges,
      revision: identity.editor.revision
    },
    capture: captureDtoFromPayload(identity, pinnable.capture),
    anchor: anchorWithSource(
      pinnable.anchor,
      identity.editor.contentSource,
      pinnable.capture.selectedText
    ) as PinnedSelectionAnchor
  }
  const result = await window.desk.context.pinSelection(request)
  if (!result.ok) {
    workspace.status = `固定失败：${result.error.message}`
    return
  }
  if (!result.value.accepted) {
    workspace.status = `固定失败：${result.value.reason ?? '未知原因'}`
    return
  }
  workspace.status = '已固定为 Agent 上下文（状态条里可以查看或解除）。'
}

/**
 * 校验固定上下文是否仍然有效。
 *
 * 触发点：内容变化（revision）、磁盘被外部改动、切视图、编辑器重建、固定状态变化 ——
 * **不只监听光标选区**。当前视图能精确校验就用精确锚点；视图不匹配时退到内容级
 * （固定时那段文字还得在当前文档里找得到），绝不假装有效。
 */
async function validatePinnedContext(): Promise<void> {
  const context = pinOwner.value
  if (!context || context.state !== 'pinned' || !context.anchor || !context.pinId) return
  const expected = context.selection?.selectedText ?? ''
  const precise = markdownEditor.value?.validatePinnedAnchor?.(context.anchor, expected) ?? null
  if (precise) {
    if (!precise.valid) await reportPinValidation(context.pinId, false, precise.reason)
    return
  }
  // 当前视图验不了这个锚点（例如固定在可视化、现在在源码视图）：用**位置锚**校验，
  // 只认"同一偏移范围上还是不是同一段文字" —— 不做全文搜索，
  // 否则"A 前插入内容导致坐标变化"会因为还能搜到而逃过校验。
  const text = session.value?.content ?? ''
  const positional = validateTextAnchor(text, context.anchor)
  if (!positional) {
    await reportPinValidation(
      context.pinId,
      false,
      '固定锚点缺少可校验的位置信息，无法确认它还在原处'
    )
    return
  }
  if (!positional.valid) await reportPinValidation(context.pinId, false, positional.reason)
}

watch(
  () => [session.value?.content, session.value?.document.revision, session.value?.dirty],
  () => void validatePinnedContext()
)
watch(pinnedContext, () => void validatePinnedContext())
watch(
  () => session.value?.externalConflict,
  (conflict) => {
    const context = pinOwner.value
    if (!conflict || !context) return
    // 外部改了来源笔记：请主进程按**磁盘内容**复核（草稿固定不看磁盘），
    // 对不上就明确失效——不拿编辑器里的旧内容当作"还有效"
    if (context.state === 'pinned' && context.pinId) {
      void revalidatePinFromDisk(context.pinId, props.tab.knowledgeBaseId, props.tab.noteUuid).then(
        () => validatePinnedContext()
      )
      return
    }
    void validatePinnedContext()
  }
)
watch(
  () => props.tab.viewMode,
  () => {
    // 切视图本身**不失效**：等新编辑器挂载好再按新视图校验一次
    void nextTick(validatePinnedContext)
  }
)

// 「查看」固定上下文：来源标签页收到请求后把固定时的范围重新选出来
watch(
  () => editor.revealRequest,
  (request) => {
    if (!request || request.tabId !== props.tab.id) return
    void nextTick(() => {
      markdownEditor.value?.revealPinnedAnchor?.(request.anchor)
    })
  }
)

/**
 * 固定上下文（⌘K P）的执行者：只有**当前活动编辑器**（活动标签 + 活动分组）才登记，
 * 否则多分组时后挂载的组内标签会把执行者抢走，快捷键会作用到没有选区的那个面板上。
 */
let unregisterPinRunner: (() => void) | null = null
watch(
  isActiveEditor,
  (active) => {
    if (!active) return
    unregisterPinRunner?.()
    unregisterPinRunner = registerPinSelectionRunner(() => void pinCurrentSelection())
  },
  { immediate: true }
)

// 视图开关（⌘K V）的执行者：同样只认当前活动编辑器
let unregisterViewRunner: (() => void) | null = null
watch(
  isActiveEditor,
  (active) => {
    if (!active) return
    unregisterViewRunner?.()
    unregisterViewRunner = registerViewToggleRunner(toggleMode)
  },
  { immediate: true }
)

onUnmounted(() => {
  if (props.active) registerHeadingFoldRunner(null)
  if (props.active) registerViewToggleRunner(null)
  unregisterPinRunner?.()
  unregisterPinRunner = null
  unregisterViewRunner?.()
  unregisterViewRunner = null
  // 关闭**来源标签**→ 固定失效（不静默回到实时选区）。
  // 注意：拆分 / 拖拽会重建分组并让面板重建（unmount 不代表标签被关），
  // 所以这里要确认"标签真的不在布局里了"才失效。
  const context = pinOwner.value
  if (context?.state === 'pinned' && context.pinId) {
    const located = findTab(editor.layout, props.tab.id)
    const stillOpen = located?.tab.type === 'note' && located.tab.noteUuid === props.tab.noteUuid
    if (!stillOpen) {
      void reportPinValidation(context.pinId, false, '固定上下文的来源标签已关闭')
    }
  }
  if (isActiveEditor.value) invalidateSelection(selectionOwner.value, '关闭了笔记标签')
})

async function editTitle(): Promise<void> {
  if (!session.value || session.value.document.readOnly || renaming.value) return
  titleDraft.value = session.value.document.title
  editingTitle.value = true
  await nextTick()
  titleInput.value?.focus()
  titleInput.value?.select()
}

async function commitTitle(): Promise<void> {
  if (!editingTitle.value) return
  editingTitle.value = false
  const title = titleDraft.value.trim()
  if (!title || title === session.value?.document.title) return
  const { knowledgeBaseId, noteUuid } = props.tab
  renaming.value = true
  try {
    await workspace.renameNote(knowledgeBaseId, noteUuid, title)
  } catch (cause) {
    workspace.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    renaming.value = false
  }
}

function onTitleKeydown(event: KeyboardEvent): void {
  // Enter used to confirm a Chinese IME candidate must not submit the name.
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    titleInput.value?.blur()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    editingTitle.value = false
  }
}

onMounted(() => {
  void workspace.ensureDocument(props.tab.knowledgeBaseId, props.tab.noteUuid)
  // 编辑器重建 / 重新打开笔记后也要校验固定上下文
  void nextTick(validatePinnedContext)
})

/**
 * 视图开关的提示：只有一个图标，显示的是当前视图。
 * 点一下切到另一个视图，图标跟着换成那一侧。
 */
const viewToggleHint = computed(() =>
  props.tab.viewMode === 'source'
    ? '切换到可视化编辑（⌘K V）· 当前：源码视图'
    : '切换到源码视图（⌘K V）· 当前：可视化编辑'
)

/** 整体开关：当前是可视化就切源码，当前是源码就切可视化 */
function toggleMode(): void {
  setMode(props.tab.viewMode === 'source' ? 'visual' : 'source')
}

function setMode(mode: NoteViewMode): void {
  if (mode === props.tab.viewMode) return
  editor.setNoteViewMode(props.tab.id, mode)
}

/** 编辑器内容变化：所写即所存（保存时不跑 prettier，不改用户没动过的字符） */
function updateContent(content: string): void {
  workspace.updateDocumentContent(key.value, content, true)
}

function activate(): void {
  editor.activate(props.groupId, props.tab.id)
}

function insertTemplate(text: string): void {
  markdownEditor.value?.insertTextAt(text)
}

function insertBlock(id: string): void {
  if (id === 'canvas') {
    void insertCanvas()
    return
  }
  if (id === 'table') {
    markdownEditor.value?.insertTable()
    return
  }
  if (id === 'code') {
    insertTemplate('\n```ts\n\n```\n')
    return
  }
  const found = TN_NOTES_SLASH_ITEMS.find((item) => item.id === id)
  if (!found) return
  insertTemplate(found.insert.startsWith('\n') ? found.insert : `\n${found.insert}`)
}

async function insertCanvas(): Promise<void> {
  if (formatDisabled.value) return
  await insertExcalidrawCanvas({
    knowledgeBaseId: props.tab.knowledgeBaseId,
    noteUuid: props.tab.noteUuid,
    insertTextAt: (text) => markdownEditor.value?.insertTextAt(text)
  })
}

function toggleProperties(): void {
  editor.toggleNoteAssetsVisible(props.tab.id)
}

function closeProperties(): void {
  editor.setNoteAssetsVisible(props.tab.id, false)
}

function onDescriptionInput(): void {
  const single = descriptionDraft.value.replace(/[\r\n]+/g, ' ')
  if (single !== descriptionDraft.value) descriptionDraft.value = single
  commitDescription()
}

/** 侧栏改摘要：只替换 frontmatter 里 description 那一行，经编辑器事务写入 */
function commitDescription(): void {
  if (session.value?.document.readOnly) return
  const view = markdownEditor.value?.getView?.()
  const current = view?.state.doc.toString() ?? session.value?.content ?? ''
  const change = frontmatterDescriptionChange(current, descriptionDraft.value)
  if (!change) return
  if (view) {
    view.dispatch({ changes: change })
    return
  }
  workspace.updateDocumentContent(
    key.value,
    current.slice(0, change.from) + change.insert + current.slice(change.to),
    true
  )
}

/** 资源面板：把已有资源一键插入当前笔记（初版只图片，走与粘贴同一条插入路径） */
function insertAssetReference(relPath: string): void {
  if (session.value?.document.readOnly) return
  const noteRelPath = session.value?.document.relPath ?? ''
  const markdown = insertableImageMarkdown(noteRelPath, relPath)
  if (!markdown) {
    workspace.error = `该类型暂不支持一键插入：${relPath}`
    return
  }
  markdownEditor.value?.insertTextAt(`${markdown}\n`)
}

/** 资源面板：定位笔记里的引用（选中源码里的那一段） */
function locateAssetReference(rawPath: string): void {
  const found = markdownEditor.value?.revealReference?.(rawPath) ?? false
  if (!found) workspace.status = `没有在正文里找到这处引用：${rawPath}`
}

async function pasteImage(file: File, insertAt: number): Promise<void> {
  const targetEditor = markdownEditor.value
  try {
    const attachment = await workspace.uploadImage(
      props.tab.knowledgeBaseId,
      props.tab.noteUuid,
      file
    )
    targetEditor?.insertTextAt(await pastedImageMarkdown(file, attachment.markdownPath), insertAt)
  } catch (cause) {
    workspace.error = cause instanceof Error ? cause.message : String(cause)
  }
}

function openLink(url: string): void {
  try {
    editor.openWeb(url)
  } catch (cause) {
    workspace.error = cause instanceof Error ? cause.message : String(cause)
  }
}
</script>

<template>
  <div v-if="session" class="note-pane" @mousedown="activate">
    <div v-if="session.externalConflict" class="conflict-banner">
      <span>磁盘内容已经变化，Desk 没有覆盖你的编辑。</span>
      <button type="button" @click="workspace.reloadCurrentDocument">载入磁盘</button>
      <button type="button" @click="workspace.keepEditorAgainstDisk">保留编辑内容</button>
    </div>

    <div class="note-path-bar">
      <KbPathBreadcrumb
        :knowledge-base-id="tab.knowledgeBaseId"
        :rel-path="session.document.relPath"
        :fallback-name="tab.knowledgeBaseName"
      />
    </div>

    <div class="document-toolbar">
      <div class="document-path" :title="session.document.filePath">
        <NoteDoneToggle
          v-if="showNoteDone"
          :done="noteDone"
          :disabled="noteDoneDisabled"
          @toggle="toggleNoteDone"
        />
        <span class="note-index">{{ session.document.index }}.</span>
        <input
          v-if="editingTitle"
          ref="titleInput"
          v-model="titleDraft"
          class="note-title-input"
          aria-label="笔记名称"
          autocomplete="off"
          @blur="commitTitle"
          @keydown="onTitleKeydown"
        />
        <button
          v-else
          type="button"
          class="note-title-button"
          aria-label="重命名笔记"
          :disabled="session.document.readOnly || renaming"
          @click="editTitle"
        >
          {{ session.document.title }}
        </button>
        <span v-if="session.document.readOnly" class="read-only">只读</span>
      </div>

      <div class="format-cluster">
        <UiTooltip :label="viewToggleHint">
          <button
            type="button"
            class="view-toggle"
            data-testid="view-toggle"
            :aria-label="tab.viewMode === 'source' ? '源码视图' : '可视化编辑'"
            @click="toggleMode()"
          >
            <svg v-if="tab.viewMode !== 'source'" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" />
              <path d="m14.5 6.7 2.8 2.8" />
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4l-3 16" />
            </svg>
          </button>
        </UiTooltip>
        <FormatOverflowBar :items="formatActions" :disabled="formatDisabled">
        <template #item="{ item }">
          <BlockInsertMenu
            v-if="item === 'insert'"
            :disabled="formatDisabled"
            :active="active"
            @select="insertBlock"
          />
          <UiTooltip v-else-if="item === 'bold'" label="粗体" shortcut="⌘ B">
            <button
              type="button"
              aria-label="粗体"
              :disabled="formatDisabled"
              @click="markdownEditor?.wrapSelection('**', '**')"
            >
              <FormatIcon name="bold" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'italic'" label="斜体" shortcut="⌘ I">
            <button
              type="button"
              aria-label="斜体"
              :disabled="formatDisabled"
              @click="markdownEditor?.wrapSelection('*', '*')"
            >
              <FormatIcon name="italic" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'strikethrough'" label="删除线" shortcut="⇧ ⌘ X">
            <button
              type="button"
              aria-label="删除线"
              :disabled="formatDisabled"
              @mousedown.prevent
              @click="markdownEditor?.wrapSelection('~~', '~~')"
            >
              <FormatIcon name="strikethrough" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'inline-code'" label="行内代码" shortcut="⌘ E">
            <button
              type="button"
              aria-label="行内代码"
              :disabled="formatDisabled"
              @mousedown.prevent
              @click="markdownEditor?.wrapSelection('`', '`')"
            >
              <FormatIcon name="inline-code" />
            </button>
          </UiTooltip>
          <HeadingMenu
            v-else-if="item === 'heading'"
            :level="headingLevel"
            :disabled="formatDisabled"
            :active="active"
            :platform="workspace.runtimePlatform"
            @select="markdownEditor?.setLinePrefix($event === 0 ? '' : `${'#'.repeat($event)} `)"
          />
          <UiTooltip v-else-if="item === 'heading-number'" label="标题编号（重排）">
            <button
              type="button"
              aria-label="标题编号（重排）"
              :disabled="formatDisabled"
              @click="markdownEditor?.addHeadingNumbers(headingNumberMaxDepth)"
            >
              <FormatIcon name="heading-number" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'heading-number-remove'" label="移除标题编号">
            <button
              type="button"
              aria-label="移除标题编号"
              :disabled="formatDisabled"
              @click="markdownEditor?.removeHeadingNumbers()"
            >
              <FormatIcon name="heading-number-remove" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'quote'" label="引用" shortcut="⇧ ⌘ U">
            <button
              type="button"
              aria-label="引用"
              :disabled="formatDisabled"
              @click="markdownEditor?.setLinePrefix('> ')"
            >
              <FormatIcon name="quote" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'unordered-list'" label="无序列表" shortcut="⇧ ⌘ 8">
            <button
              type="button"
              aria-label="无序列表"
              :disabled="formatDisabled"
              @click="markdownEditor?.setLinePrefix('- ')"
            >
              <FormatIcon name="unordered-list" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'ordered-list'" label="有序列表">
            <button
              type="button"
              aria-label="有序列表"
              :disabled="formatDisabled"
              @click="markdownEditor?.setLinePrefix('1. ')"
            >
              <FormatIcon name="ordered-list" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'checkbox'" label="复选框">
            <button
              type="button"
              aria-label="复选框"
              :disabled="formatDisabled"
              @click="markdownEditor?.setLinePrefix('- [ ] ')"
            >
              <FormatIcon name="checkbox" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'link'" label="链接">
            <button
              type="button"
              aria-label="链接"
              :disabled="formatDisabled"
              @click="markdownEditor?.wrapSelection('[', '](https://)', '链接')"
            >
              <FormatIcon name="link" />
            </button>
          </UiTooltip>
          <UiTooltip v-else-if="item === 'divider'" label="分割线">
            <button
              type="button"
              aria-label="分割线"
              :disabled="formatDisabled"
              @click="insertTemplate('\n---\n')"
            >
              <FormatIcon name="divider" />
            </button>
          </UiTooltip>
        </template>
        </FormatOverflowBar>
      </div>
      <div class="layout-toggles">
        <UiTooltip :label="pageWidthLabel">
          <button
            type="button"
            class="page-width-toggle"
            :aria-label="pageWidthLabel"
            @click="editor.toggleNotePageWidth(tab.id)"
          >
            <PageWidthIcon :mode="tab.pageWidth" />
          </button>
        </UiTooltip>
        <UiTooltip :label="outlineVisible ? '隐藏目录' : '显示目录'">
          <button
            type="button"
            class="outline-toggle"
            :class="{ active: outlineVisible }"
            :aria-label="outlineVisible ? '隐藏目录' : '显示目录'"
            :aria-pressed="outlineVisible"
            @click="editor.toggleNoteOutlineVisible(tab.id)"
          >
            <OutlineIcon />
          </button>
        </UiTooltip>
        <UiTooltip :label="propertiesOpen ? '关闭文档属性' : '文档属性'">
          <button
            type="button"
            class="properties-toggle"
            data-testid="note-properties-toggle"
            :class="{ active: propertiesOpen }"
            aria-label="文档属性"
            :aria-pressed="propertiesOpen"
            @click="toggleProperties"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <g fill="none" stroke="currentColor" stroke-width="1.5">
                <path
                  d="M2 12c0-3.69 0-5.534.814-6.841a4.8 4.8 0 0 1 1.105-1.243C5.08 3 6.72 3 10 3h4c3.28 0 4.919 0 6.081.916c.43.338.804.759 1.105 1.243C22 6.466 22 8.31 22 12s0 5.534-.814 6.841a4.8 4.8 0 0 1-1.105 1.243C18.92 21 17.28 21 14 21h-4c-3.28 0-4.919 0-6.081-.916a4.8 4.8 0 0 1-1.105-1.243C2 17.534 2 15.69 2 12Z"
                />
                <path stroke-linejoin="round" d="M14.5 3v18" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M18 7h1m-1 3h1" />
              </g>
            </svg>
          </button>
        </UiTooltip>
      </div>
    </div>

    <div class="note-body">
      <div class="note-editor-area">
        <LivePreviewEditor
          :key="key"
          ref="markdownEditor"
          class="editor-surface"
          :content="session.content"
          :mode="tab.viewMode"
          :read-only="session.document.readOnly"
          :knowledge-base-id="tab.knowledgeBaseId"
          :note-uuid="tab.noteUuid"
          :note-rel-path="session.document.relPath"
          :active="active"
          :page-width="tab.pageWidth"
          :outline-visible="outlineVisible"
          @change="updateContent"
          @open-link="openLink"
          @open-note="workspace.openNoteByUuid(tab.knowledgeBaseId, $event)"
          @paste-image="pasteImage"
          @heading-level-change="headingLevel = $event"
          @selection-change="handleEditorSelection"
          @pin-selection="pinCurrentSelection"
        />
      </div>
      <aside
        v-if="propertiesOpen"
        class="note-properties-sidebar"
        data-testid="note-properties-panel"
        aria-label="文档属性"
      >
        <header class="properties-head">
          <div class="properties-tabs" role="tablist" aria-label="侧栏">
            <button
              type="button"
              role="tab"
              class="properties-tab"
              :class="{ active: sideTab === 'settings' }"
              :aria-selected="sideTab === 'settings'"
              @click="sideTab = 'settings'"
            >
              设置
            </button>
            <button
              type="button"
              role="tab"
              class="properties-tab"
              :class="{ active: sideTab === 'assets' }"
              :aria-selected="sideTab === 'assets'"
              @click="sideTab = 'assets'"
            >
              资源
            </button>
          </div>
          <button type="button" class="properties-close" aria-label="关闭文档属性" @click="closeProperties">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div v-if="sideTab === 'settings'" class="properties-scroll">
          <section class="properties-section">
            <label class="properties-label" for="note-description-input">描述</label>
            <textarea
              id="note-description-input"
              v-model="descriptionDraft"
              class="properties-description"
              rows="1"
              :disabled="session.document.readOnly"
              placeholder="描述信息"
              @focus="descriptionFocused = true"
              @blur="descriptionFocused = false"
              @keydown.enter.prevent
              @input="onDescriptionInput"
            />
            <label class="properties-label">ID</label>
            <div class="properties-id" :title="frontmatterFields.id || '无'">
              {{ frontmatterFields.id || '—' }}
            </div>
          </section>
        </div>
        <NoteAssetsPanel
          v-else
          class="note-assets-embedded"
          :knowledge-base-id="tab.knowledgeBaseId"
          :note-uuid="tab.noteUuid"
          :note-rel-path="session.document.relPath"
          :note-index="session.document.index"
          :source="session.content"
          :read-only="session.document.readOnly"
          :show-close="false"
          @insert="insertAssetReference"
          @locate="locateAssetReference"
          @close="closeProperties"
        />
      </aside>
    </div>
  </div>
  <div v-else class="loading-note">正在读取笔记…</div>
</template>

<style scoped>
.note-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  container-name: desk-note-pane;
}

.document-toolbar {
  position: relative;
  height: 40px;
  flex: none;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--editor-bg);
}

/* 路径面包屑：独立的 slim 行，压在标题工具条上方 */
.note-path-bar {
  flex: none;
  height: 22px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--editor-bg);
}

.layout-toggles {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 1px;
}

.document-path {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 10px;
}

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

.note-index,
.read-only {
  flex: none;
}

.note-title-button,
.note-title-input {
  min-width: 0;
  height: 26px;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0 4px;
  background: transparent;
  color: inherit;
  font: inherit;
}

.note-title-button {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  cursor: text;
}

.note-title-button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.note-title-button:disabled {
  cursor: default;
}

.note-title-input {
  flex: 1;
  outline: none;
  border-color: var(--accent);
  background: var(--panel);
  color: var(--text);
}

.read-only {
  margin-left: 6px;
  border-radius: 4px;
  background: var(--warning-soft);
  color: var(--warning);
  padding: 2px 5px;
}

.layout-toggles button,
.conflict-banner button,
:deep(.format-overflow button) {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 10px;
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
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 14px;
}

:deep(.format-overflow button:hover:not(:disabled)) {
  background: var(--hover);
  color: var(--text);
}

.layout-toggles button {
  width: 27px;
  height: 25px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  padding: 0;
}

.layout-toggles svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.outline-toggle.active {
  color: var(--accent-strong);
  background: var(--selected);
}

.outline-toggle svg {
  fill: currentColor;
  stroke: none;
}

.conflict-banner {
  min-height: 35px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 10px;
}

.conflict-banner span {
  flex: 1;
}

.conflict-banner button {
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  border-radius: 5px;
  color: var(--warning);
  padding: 4px 7px;
}

.editor-surface {
  flex: 1;
  min-height: 0;
}

/* 复制预览用 absolute 覆盖在整块笔记面板上 */
.note-pane {
  position: relative;
}

.note-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: stretch;
}

.note-editor-area {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.note-properties-sidebar {
  flex: none;
  width: 320px;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--editor-bg);
}

.properties-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 8px 8px 10px;
  border-bottom: 1px solid var(--border);
}

.properties-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
}

.properties-tab {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 5px;
}

.properties-tab:hover {
  color: var(--text);
  background: var(--hover);
}

.properties-tab.active {
  color: var(--text);
  background: var(--hover);
}

.properties-close {
  width: 27px;
  height: 25px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  border-radius: 5px;
}

.properties-close svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}

.properties-close:hover {
  background: var(--hover);
  color: var(--text);
}

.properties-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.properties-section {
  flex: none;
  padding: 12px;
  border-bottom: 1px solid var(--border);
}

.properties-label,
.properties-subhead {
  display: block;
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
}

.properties-label + .properties-label,
.properties-description + .properties-label {
  margin-top: 12px;
}

.properties-description {
  display: block;
  width: 100%;
  box-sizing: border-box;
  /* 5 行字：行盒 1.5em，上下各留 6px，再加 1px 边框 */
  height: calc(5 * 1.5em + 14px);
  min-height: calc(5 * 1.5em + 14px);
  max-height: calc(5 * 1.5em + 14px);
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-bg, var(--bg));
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  resize: none;
  overflow-x: hidden;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.properties-description:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.properties-id {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  opacity: 0.55;
  word-break: break-all;
  user-select: text;
}

.note-assets-embedded {
  flex: 1;
  min-height: 0;
  border: 0;
}

.properties-toggle.active {
  color: var(--accent-strong);
  background: var(--hover);
}

.properties-toggle svg {
  stroke-width: 1.5;
}

/* 窄面板放不下侧栏：收窄一些，仍然可用 */
@container desk-note-pane (max-width: 900px) {
  .note-properties-sidebar {
    width: 260px;
  }
}

.loading-note {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 11px;
}
</style>
