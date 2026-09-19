<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { parserCtx } from '@milkdown/kit/core'
import { editorViewCtx, commandsCtx, serializerCtx } from '@milkdown/kit/core'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import { serializeImageMarkdown } from '@tnotesjs/ui/image-markdown'
import { createCanvasImageClipboardPlugin } from './canvasImageClipboardPlugin'
import { noteRelativeAssetPath } from './noteAssetPath'
import { invalidateCanvasSource, placeholderCanvasSvg } from '../editor/excalidraw/canvasImage'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { documentKey, type DocumentSession } from '../stores/workspace/helpers'
import type { SlashMenuItem } from './slashMenu'
import {
  createBlockShortcutPlugin,
  createMarkdownShortcutInputRules,
  replaceCurrentParagraphWithItem
} from './markdownInputRules'
import { clearRawBlockSelectionState, createRawBlockSelectionPlugin } from './rawBlockInteractions'
import { createTableCaretPlugin } from './tableCaretVisibility'
import { isEditorBlankTarget } from './editorFocusReclaim'
import { createReadonlyTransactionGuard } from './readonlyGuard'
import { clearLineStylesPlugin } from './clearLineStyles'
import { createInlineCodeInteractionPlugin, toggleDeskInlineCode } from './inlineCodeInteractions'
import { wrapInTaskList } from './taskList'
import { insertDefaultTable } from './insertDefaultTable'
import {
  createCodeBlockCommand,
  toggleEmphasisCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
  clearTextInCurrentBlockCommand
} from '@milkdown/kit/preset/commonmark'
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { $prose, callCommand, insert, insertPos, replaceAll } from '@milkdown/kit/utils'
import GithubSlugger from 'github-slugger'

import BlockActionMenu from './BlockActionMenu.vue'
import NoteOutline from './NoteOutline.vue'
import {
  activeOutlineHeadingId,
  collectNoteOutlineHeadings,
  headingElementById,
  type NoteOutlineHeading
} from './noteOutline'
import type { BlockAction } from './BlockActionMenu.vue'
import {
  createBlockDeleteTransaction,
  installBlockHandleClickController,
  resolveBlockActionTarget,
  serializeBlockForClipboard,
  type BlockHandleClickTarget
} from './blockActionMenu'
import { createDeskBlockEditConfig } from './deskBlockEditConfig'
import { createDeskEditor, type DeskEditorHandle } from './deskEditor'
import { hideSelectionToolbar } from './crepePort/toolbar'
import { createDocumentSelectAllPlugin } from './documentSelection'
import { createCodeBlockTitlePlugin } from './codeBlockTitlePlugin'
import { createCodeBlockLatexPreviewPlugin } from './codeBlockLatexPreview'
import { createCodeBlockHighlightBundle } from './codeBlockHighlightPlugin'
import { CHECK_ICON, COPY_ICON } from './copyIcons'
import { toggleDeskCodeBlockCollapsed } from './codeBlockCollapse'
import { exitCodeBlockFullscreen, toggleCodeBlockFullscreen } from './codeBlockFullscreen'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'

import { deskCodeMirrorLanguages } from '../editor/markdown/codeMirrorLanguages'
import {
  projectRawBlocksForMilkdown,
  rawBlockProjectionPlugins
} from '../editor/markdown/rawBlockProjection'
import { createContainerUpgradePlugin } from '../editor/markdown/containerUpgrade'
import { renumberHeadings, stripHeadingNumbers } from '../editor/markdown/headingNumbering'
import { clampViewPosition } from '../editor/markdown/noteViewPosition'
import { flushPendingEdits } from '../editor/markdown/pendingEdits'
import { createDocumentSync, type DocumentSyncHost, type DocumentSyncSession } from './documentSync'
import { createDeskRawBlockView } from './createDeskRawBlockView'
import { createDeskCalloutView, deskCalloutKeymapPlugin } from './deskCalloutView'
import { imageAttrPlugins } from '../editor/markdown/imageAttrs'
import { createDeskImageView } from '../editor/markdown/deskImageView'
import { standaloneImageParagraphPlugin } from '../editor/markdown/standaloneImageParagraph'
import {
  applyHeadingFoldCommand,
  createHeadingSectionCollapsePlugin,
  expandCollapsedSectionsContaining,
  type HeadingFoldCommand
} from './headingSectionCollapse'
import {
  createListItemCollapsePlugin,
  expandCollapsedListItemsContaining
} from './listItemCollapse'
import { createBlockBoundaryCaretPlugin } from './blockBoundaryCaret'
import {
  createBlockBoundaryNavigationPlugin,
  type BlockBoundaryNavigationOptions
} from './blockBoundaryNavigation'

import type { NotePageWidth, NoteTocDisplay, NoteViewMode } from '../../../shared/contracts'
import type { DisplayLimitedItem } from '../editor/markdown/projectionFidelity'

const props = withDefaults(
  defineProps<{
    content: string
    mode: NoteViewMode
    pageWidth?: NotePageWidth
    outlineVisible?: boolean
    tocDisplay?: NoteTocDisplay
    readOnly: boolean
    knowledgeBaseId: string
    noteUuid: string
    active: boolean
    uploadImage: (file: File) => Promise<{ src: string; alt: string }>
    /**
     * 选区浮动工具条开关（对应 AppSettings `editor.selectionToolbar`）。由上层从设置里
     * 读出来传进来 —— 编辑器只做装配，不自己访问 store（访问会在没有 Pinia 的单测里炸）。
     */
    selectionToolbar?: boolean
  }>(),
  { pageWidth: 'standard', outlineVisible: true, tocDisplay: 'expanded', selectionToolbar: false }
)

const emit = defineEmits<{
  change: [content: string]
  openLink: [url: string]
  openNote: [noteUuid: string]
  fatal: [message: string]
  headingLevelChange: [level: number | null]
  /**
   * 编辑器里出现了「比 store 更新、但没能安全 emit」的修改。
   *
   * 这类修改只在编辑器内存里，父组件必须据此提示未保存、并禁止销毁编辑器式切换。
   */
  unsavedDraftChange: [hasDraft: boolean]
  /** 「这些块以源码显示」的清单（行号 + 类型 + 片段），供父组件渲染可展开提示。 */
  displayLimitedChange: [items: DisplayLimitedItem[]]
}>()

const host = ref<HTMLElement | null>(null)
const outlineHeadings = ref<NoteOutlineHeading[]>([])
const outlineActiveId = ref<string | null>(null)
let deskEditor: DeskEditorHandle | null = null
let destroyed = false
let ready = false
/**
 * 文档同步会话（原文 / 基线 / 保真降级 / 待保存 flush）。
 * 只在 `onMounted` 里创建 —— 它的初始原文必须与「创建编辑器时用的那份 props.content」
 * 严格配对，不能把新 props 与旧编辑器内容配成一组基线。
 */
let session: DocumentSyncSession | null = null
let blockHandleClickCleanup: (() => void) | null = null
const rawSourceReadonlyListeners = new Set<(readOnly: boolean) => void>()

interface BlockActionMenuState extends BlockHandleClickTarget {
  x: number
  y: number
}

const blockActionMenu = ref<BlockActionMenuState | null>(null)
let addBelowMenuOpened = false

function isEffectivelyReadOnly(): boolean {
  return props.readOnly || props.mode === 'readonly'
}

/** 当前笔记的文档会话（剪贴板归属判断与相对路径都要用）。 */
function currentNoteSession(): DocumentSession | undefined {
  const workspace = useWorkspaceStore()
  return workspace.documents[documentKey(props.knowledgeBaseId, props.noteUuid)]
}

function editorView(): EditorView | null {
  return deskEditor?.editor.action((ctx) => ctx.get(editorViewCtx)) ?? null
}

function reportHeadingLevel(view: EditorView): void {
  const node = view.state.selection.$from.parent
  emit(
    'headingLevelChange',
    node.type.name === 'heading'
      ? Number(node.attrs.level)
      : node.type.name === 'paragraph'
        ? 0
        : null
  )
}

function positionBlockActionMenu(target: BlockHandleClickTarget): BlockActionMenuState {
  const width = 224
  const estimatedHeight = 176
  const gap = 6
  const x = Math.max(8, Math.min(target.handleRect.left, window.innerWidth - width - 8))
  const below = target.handleRect.bottom + gap
  const y =
    below + estimatedHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, target.handleRect.top - estimatedHeight - gap)
  return {
    ...target,
    x,
    y
  }
}

function openBlockActionMenu(target: BlockHandleClickTarget): void {
  if (isEffectivelyReadOnly()) return
  addBelowMenuOpened = false
  blockActionMenu.value = positionBlockActionMenu(target)
}

function closeBlockActionMenu(focusEditor = true): void {
  if (!blockActionMenu.value) return
  blockActionMenu.value = null
  addBelowMenuOpened = false
  if (focusEditor) editorView()?.focus()
}

function currentBlockTarget(): { view: EditorView; position: number; dom: HTMLElement } | null {
  const menu = blockActionMenu.value
  const view = editorView()
  if (!menu || !view) return null
  const target = resolveBlockActionTarget(view, menu)
  return target ? { view, ...target } : null
}

function deleteCurrentBlock(): void {
  if (isEffectivelyReadOnly()) return closeBlockActionMenu(false)
  const target = currentBlockTarget()
  if (!target) return closeBlockActionMenu()
  const transaction = createBlockDeleteTransaction(target.view.state, target.position)
  if (transaction) target.view.dispatch(transaction)
  closeBlockActionMenu()
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Electron can expose Clipboard without granting the renderer's async
      // Clipboard permission. Fall through to the synchronous user-gesture
      // path so the menu action still works.
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

/** CodeMirror splits lines into `.cm-line` divs; parent textContent drops newlines. */
function readCodeBlockPlainText(block: Element): string {
  const lines = block.querySelectorAll('.cm-line')
  if (lines.length > 0) {
    return Array.from(lines, (line) => line.textContent ?? '').join('\n')
  }
  return block.querySelector('pre, code')?.textContent ?? ''
}

/** 块边界光标上的 Mod+C / Mod+X：复制/剪切整块的 markdown 源码。 */
const boundaryOptions: BlockBoundaryNavigationOptions = {
  copyBlockAt: (view, position, cut) => {
    if (!deskEditor) return false
    const text = deskEditor.editor.action((ctx) =>
      serializeBlockForClipboard(view.state, position, ctx.get(serializerCtx))
    )
    if (text === null || text === undefined) return false
    void writeClipboard(text)
    if (cut) {
      const tr = createBlockDeleteTransaction(view.state, position)
      if (tr) view.dispatch(tr)
    }
    return true
  }
}

async function copyCurrentBlock(cut = false): Promise<boolean> {
  const menu = blockActionMenu.value
  const target = currentBlockTarget()
  const node = target?.view.state.doc.nodeAt(target.position)
  if (!target || !node || !deskEditor) return false
  const text = deskEditor.editor.action((ctx) =>
    serializeBlockForClipboard(target.view.state, target.position, ctx.get(serializerCtx))
  )
  if (text === null) return false
  await writeClipboard(text)
  if (cut && blockActionMenu.value === menu) {
    const current = resolveBlockActionTarget(target.view, target)
    if (current?.node.eq(node)) deleteCurrentBlock()
  }
  return true
}

function openAddBelowMenu(): void {
  if (isEffectivelyReadOnly() || addBelowMenuOpened || !blockActionMenu.value || !host.value) return
  const addButton = host.value.querySelector<HTMLElement>(
    '.milkdown-block-handle[data-show="true"] .operation-item:first-child'
  )
  if (!addButton) return
  addBelowMenuOpened = true
  addButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
}

async function handleBlockAction(action: BlockAction): Promise<void> {
  if (isEffectivelyReadOnly()) return closeBlockActionMenu(false)
  if (action === 'delete') return deleteCurrentBlock()
  if (action === 'copy') {
    await copyCurrentBlock()
    return closeBlockActionMenu()
  }
  if (action === 'cut') {
    await copyCurrentBlock(true)
    return
  }
  if (action === 'add-below') openAddBelowMenu()
}

function handleBlockMenuOutsidePointer(event: PointerEvent): void {
  if (!blockActionMenu.value) return
  const target = event.target as Element | null
  if (target?.closest('.desk-block-action-menu, .milkdown-block-handle, .milkdown-slash-menu'))
    return
  closeBlockActionMenu(false)
}

function handleBlockMenuDocumentPointerUp(event: PointerEvent): void {
  const target = event.target as Element | null
  if (target?.closest('.milkdown-slash-menu li[data-index]')) {
    closeBlockActionMenu(false)
  }
}

function run(action: (editor: DeskEditorHandle) => void): boolean {
  if (!deskEditor || !ready || isEffectivelyReadOnly()) return false
  action(deskEditor)
  focus()
  return true
}

function command(commandKey: { key: unknown }, payload?: unknown): boolean {
  return run((editor) => {
    editor.editor.action(callCommand(commandKey.key as never, payload as never))
  })
}

/**
 * 定位一处资源引用：找到 src / 文本等于该相对路径的节点，选中它并滚动到可见。
 *
 * 资源面板的「定位引用」走这里。按**节点语义**找而不是按文本偏移：ProseMirror 位置
 * 与 markdown 偏移不是一回事。
 */
function revealReference(rawPath: string): boolean {
  let found = false
  run((editor) => {
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const doc = view.state.doc
      let from = -1
      let to = -1
      let isImage = false
      doc.descendants((node, pos) => {
        if (found) return false
        if (node.type.name === 'image') {
          const src = String(node.attrs.src ?? '')
          if (src === rawPath || src.endsWith(rawPath) || rawPath.endsWith(src)) {
            from = pos
            to = pos + node.nodeSize
            isImage = true
            return false
          }
          return true
        }
        if (node.isText && node.text?.includes(rawPath)) {
          const offset = node.text.indexOf(rawPath)
          from = pos + offset
          to = from + rawPath.length
          return false
        }
        return true
      })
      if (from < 0) return
      found = true
      const tr = view.state.tr
      tr.setSelection(
        isImage ? NodeSelection.create(doc, from) : TextSelection.create(doc, from, to)
      )
      tr.scrollIntoView()
      view.dispatch(tr)
      view.focus()
    })
  })
  return found
}

function insertTextAt(text: string, position?: number): void {
  run((editor) => {
    if (typeof position === 'number' && position >= 0) {
      editor.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const safePosition = Math.min(position, view.state.doc.content.size)
        insertPos(text, safePosition, true)(ctx)
      })
      return
    }
    editor.editor.action(insert(text))
  })
}

function wrapSelection(prefix: string, suffix: string, placeholder = '文字'): void {
  const marker = `${prefix}\u0000${suffix}`
  if (marker === '**\u0000**') {
    command(toggleStrongCommand)
    return
  }
  if (marker === '*\u0000*') {
    command(toggleEmphasisCommand)
    return
  }
  if (marker === '`\u0000`') {
    run((editor) => {
      editor.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        toggleDeskInlineCode(view.state, view.dispatch)
      })
    })
    return
  }
  if (marker === '~~\u0000~~') {
    command(toggleStrikethroughCommand)
    return
  }
  if (prefix === '[' && suffix.startsWith('](')) {
    const hasSelection = deskEditor?.editor.action(
      (ctx) => !ctx.get(editorViewCtx).state.selection.empty
    )
    if (!hasSelection) {
      insertTextAt(`${prefix}${placeholder}${suffix}`)
      return
    }
    command(toggleLinkCommand, { href: 'https://', title: '' })
    return
  }
  insertTextAt(`${prefix}${placeholder}${suffix}`)
}

function prefixSelection(prefix: string): void {
  if (prefix.trim() === '>') command(wrapInBlockquoteCommand)
  else insertTextAt(prefix)
}

function setLinePrefix(prefix: string): void {
  const heading = prefix.match(/^(#{1,6})\s$/)
  if (heading) {
    command(wrapInHeadingCommand, heading[1].length)
    return
  }
  if (!prefix) {
    command(turnIntoTextCommand)
    return
  }
  if (prefix === '> ') {
    command(wrapInBlockquoteCommand)
    return
  }
  if (prefix === '- ') {
    command(wrapInBulletListCommand)
    return
  }
  if (prefix === '- [ ] ') {
    run((editor) =>
      editor.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        wrapInTaskList(view.state, view.dispatch, view)
      })
    )
    return
  }
  if (prefix === '1. ') {
    command(wrapInOrderedListCommand)
    return
  }
  insertTextAt(prefix)
}

function insertCodeBlock(language = 'ts'): void {
  command(createCodeBlockCommand, language)
}

function insertTable(): void {
  run((editor) => editor.editor.action((ctx) => insertDefaultTable(ctx)))
}

/**
 * 0005：斜杠菜单的 TNotes 项被选中时插入内容。
 * - tip/info/warning/danger：插入 deskCallout（标题可编辑，正文走普通块）。
 * - details / 导图 / 组件 / 代码组 / swiper：插入 deskRawBlock，
 *   并自动打开新插入块的「编辑源码」。
 * - 普通代码块：走代码块组件（createCodeBlockCommand）。
 */
function runSlashItemInsert(item: SlashMenuItem): void {
  if (item.id === 'excalidraw') {
    void insertExcalidrawComponent()
    return
  }
  if (item.kind === 'code') {
    run((editor) => {
      editor.editor.action((ctx) => {
        const commands = ctx.get(commandsCtx)
        // The toolbar command intentionally preserves paragraph text. A slash
        // insertion must first remove its `/query`, just like the slash menu does.
        commands.call(clearTextInCurrentBlockCommand.key)
        commands.call(createCodeBlockCommand.key, 'js')
      })
    })
    return
  }

  // 斜杠菜单和块级快捷输入必须保留同一份 insert（包括末尾换行），
  // 因而两条入口都直接用 replaceCurrentParagraphWithItem 创建节点。
  // 新块定位：插入前后各取一次 deskRawBlock 原子的文档 pos 列表，
  // 通过「前缀 + 后缀」对齐找出新增原子（插入发生在文档任意位置，不能
  // 假设在末尾——例如用户在文档中间的空段落里打 `/`）。
  let newBlockPos: number | null = null
  run((editor) => {
    editor.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const before = rawBlockPositions(view.state.doc)
      const transaction = replaceCurrentParagraphWithItem(
        view.state,
        item,
        view.state.selection.from
      )
      if (!transaction) return
      view.dispatch(transaction)
      const after = rawBlockPositions(view.state.doc)
      newBlockPos = findAddedBlockPos(before, after)
    })
  })

  if (newBlockPos != null) openRawSourceEditorAt(newBlockPos)
}

/**
 * 插入画布（笔记里就是一张图）。
 *
 * 顺序固定为「先让主进程建两个文件，成功后再插入图片引用」：
 * - 笔记必须有四位编号，否则不创建（文件名归属靠它）
 * - `.excalidraw` 是真相源，同名的 `.svg` 是笔记里引用的那张图（先用占位图）
 * - 创建成功但插入失败时报告文件位置，文件保留（不自动删除）
 * - 插完直接打开标签页：笔记里不提供就地编辑
 */
async function insertExcalidrawComponent(): Promise<void> {
  const workspace = useWorkspaceStore()
  const session = workspace.documents[documentKey(props.knowledgeBaseId, props.noteUuid)]
  const noteRelPath = session?.document.relPath
  const noteIndex = session?.document.index ?? ''
  if (!noteRelPath) {
    workspace.error = '无法定位当前笔记，画布未创建'
    return
  }
  if (!/^\d{4}$/.test(noteIndex)) {
    workspace.error = '当前笔记缺少四位编号，画布未创建（文件名归属需要它）'
    return
  }
  const created = await window.desk.excalidraw.create({
    knowledgeBaseId: props.knowledgeBaseId,
    noteUuid: props.noteUuid
  })
  if (!created.ok) {
    workspace.error = `无法创建画布：${created.error.message}`
    return
  }
  const sourceRelPath = created.value.relPath
  const derived = await window.desk.excalidraw.writeDerived({
    knowledgeBaseId: props.knowledgeBaseId,
    sourceRelPath,
    content: placeholderCanvasSvg()
  })
  if (!derived.ok) {
    workspace.error = `画布已创建但占位图写入失败：${derived.error.message}`
    return
  }
  const relative = noteRelativeAssetPath(noteRelPath, derived.value.relPath)
  if (!relative) {
    workspace.error = `画布已创建但无法计算相对路径，请在资源面板找到它：${sourceRelPath}`
    return
  }
  // 笔记里写的是图片引用（可拖拽改尺寸 / 加描述 / 改对齐），不是组件
  insertTextAt(`${serializeImageMarkdown({ alt: '画布', src: relative })}\n`)
  invalidateCanvasSource(props.knowledgeBaseId, derived.value.relPath)
  workspace.status = `已创建画布 ${sourceRelPath}`
  openExcalidrawTab(sourceRelPath)
}

/** 打开/聚焦该画布的标签页（笔记里不再提供就地编辑） */
function openExcalidrawTab(sourceRelPath: string): void {
  const workspace = useWorkspaceStore()
  const knowledgeBase =
    workspace.overview.allKnowledgeBases.find((item) => item.id === props.knowledgeBaseId) ?? null
  if (!knowledgeBase) {
    workspace.error = `画布已创建但无法打开标签页：${sourceRelPath}`
    return
  }
  useEditorStore().openExcalidraw(knowledgeBase, sourceRelPath)
}

/**
 * Raw NodeViews mount after their insertion transaction. Poll briefly, then
 * open and focus the inline source editor. Both slash insertion (0005) and
 * block shortcuts (0006) use this exact interaction path.
 */
function openRawSourceEditorAt(position: number): void {
  if (isEffectivelyReadOnly()) return
  let attempts = 0
  const tryOpen = (): void => {
    attempts += 1
    const view = deskEditor?.editor.action((ctx) => ctx.get(editorViewCtx))
    if (!view) {
      if (attempts >= 20) window.clearInterval(pollTimer)
      return
    }
    const dom = view.nodeDOM(position)
    if (!(dom instanceof HTMLElement)) {
      if (attempts >= 20) window.clearInterval(pollTimer)
      return
    }
    const editButton = dom.querySelector<HTMLButtonElement>('.desk-raw-block__edit')
    if (!editButton) {
      if (attempts >= 20) window.clearInterval(pollTimer)
      return
    }
    editButton.click()
    window.clearInterval(pollTimer)
  }
  const pollTimer = window.setInterval(tryOpen, 50)
  tryOpen()
}

/** 文档中所有 deskRawBlock 原子的 (pos, kind, source, hidden)，按文档序。 */
function rawBlockPositions(doc: {
  descendants: (
    fn: (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => void
  ) => void
}): Array<{ pos: number; signature: string }> {
  const found: Array<{ pos: number; signature: string }> = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'deskRawBlock') return
    found.push({
      pos,
      signature: `${String(node.attrs.kind)}\u0000${String(node.attrs.hidden)}\u0000${String(node.attrs.source)}`
    })
  })
  return found
}

/**
 * 插入前后 pos 列表 diff：返回第一个新增原子的 pos。
 * 用「前缀相同 + 后缀相同」对齐：新增项位于两者之间。
 */
function findAddedBlockPos(
  before: Array<{ pos: number; signature: string }>,
  after: Array<{ pos: number; signature: string }>
): number | null {
  const beforeSigs = before.map((item) => item.signature)
  const afterSigs = after.map((item) => item.signature)
  // 前缀对齐
  let prefix = 0
  while (
    prefix < beforeSigs.length &&
    prefix < afterSigs.length &&
    beforeSigs[prefix] === afterSigs[prefix]
  ) {
    prefix += 1
  }
  // 后缀对齐（不含已对齐前缀）
  let suffix = 0
  while (
    suffix < beforeSigs.length - prefix &&
    suffix < afterSigs.length - prefix &&
    beforeSigs[beforeSigs.length - 1 - suffix] === afterSigs[afterSigs.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const addedCount = afterSigs.length - beforeSigs.length
  if (addedCount <= 0) return null
  // 插入位置 = 前缀 + 新增项序号；返回第一个新增的 pos。
  const index = prefix
  if (index >= after.length) return null
  return after[index].pos
}

function focus(): void {
  if (!deskEditor || !ready || isEffectivelyReadOnly()) return
  deskEditor.editor.action((ctx) => ctx.get(editorViewCtx).focus())
}

function applyReadonlyState(): void {
  const readOnly = isEffectivelyReadOnly()
  if (readOnly) {
    // 切到只读之前把草稿与未提交的对账落下去。
    session?.flush()
  }
  deskEditor?.setReadonly(readOnly)
  rawSourceReadonlyListeners.forEach((listener) => listener(readOnly))
  if (!readOnly) return

  closeBlockActionMenu(false)
  // `deskEditor` is assigned before `editor.create()` resolves; until then the editor
  // view ctx still holds Milkdown's placeholder — a non-null object without
  // `state`. Require a ready editor with an initialized view before touching it.
  const view = editorView()
  if (!ready || !view?.state) return
  clearRawBlockSelectionState(view)
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement && view.dom.contains(activeElement)) {
    activeElement.blur()
  }
  view.dom.blur()
}

function applyGeneratedTocDisplay(): void {
  const collapsed = props.tocDisplay === 'collapsed'
  for (const toc of host.value?.querySelectorAll<HTMLElement>('.desk-generated-toc') ?? []) {
    toc.classList.toggle('is-collapsed', collapsed)
    const toggle = toc.querySelector<HTMLButtonElement>('.desk-generated-toc__toggle')
    toggle?.setAttribute('aria-expanded', String(!collapsed))
    toggle?.setAttribute('aria-label', collapsed ? '展开目录' : '折叠目录')
  }
}

defineExpose({
  revealReference,
  insertTextAt,
  wrapSelection,
  prefixSelection,
  setLinePrefix,
  insertCodeBlock,
  insertTable,
  addHeadingNumbers,
  removeHeadingNumbers,
  applyHeadingFold,
  focus,
  flush,
  hasUnsavedDraft,
  exportDraft,
  revealDisplayLimited
})

const githubSlugger = new GithubSlugger()

function headingElementText(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\s+#+\s*$/, '').trim()
}

function resolveHeadingTarget(targetId: string): HTMLElement | null {
  const root = host.value
  if (!root) return null

  // Milkdown assigns heading ids with a rule that diverges from the TOC anchors
  // (e.g. `1. 本节内容` -> `1.-本节内容` versus the canonical `1-本节内容`).
  // Prefer an exact id match, then fall back to a fresh canonical slug match.
  const byExplicitId = [...root.querySelectorAll<HTMLElement>('[id]')].find(
    (element) => element.id === targetId
  )
  if (byExplicitId) return byExplicitId

  let fallback: HTMLElement | null = null
  for (const element of [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]) {
    if (githubSlugger.slug(headingElementText(element)) === targetId) {
      fallback = element
      break
    }
  }
  return fallback
}

function refreshOutline(): void {
  if (!ready || destroyed) return
  const root = host.value
  if (!root) {
    outlineHeadings.value = []
    outlineActiveId.value = null
    return
  }
  try {
    outlineHeadings.value = collectNoteOutlineHeadings(root)
    outlineActiveId.value = activeOutlineHeadingId(root, outlineHeadings.value)
  } catch {
    // Outline is decorative; never take down the editor.
  }
}

function syncOutlineActive(): void {
  const root = host.value
  if (!root) return
  outlineActiveId.value = activeOutlineHeadingId(root, outlineHeadings.value)
}

function scrollToOutlineHeading(id: string): void {
  const root = host.value
  const target = (root ? headingElementById(root, id) : null) ?? resolveHeadingTarget(id)
  const view = editorView()
  if (view && target) {
    try {
      expandCollapsedSectionsContaining(view, view.posAtDOM(target, 0))
    } catch {
      // posAtDOM can throw if the heading is mid-remap; scrolling still helps.
    }
  }
  target?.scrollIntoView({ block: 'start' })
  outlineActiveId.value = id
}

function handleClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return

  // Milkdown's Copy uses navigator.clipboard.writeText and only sync-catches
  // failures, so Electron's async NotAllowedError never falls back. Intercept
  // in capture and use Desk's permission-safe path instead.
  // 代码块标题左侧的「收起 / 展开」（纯视图状态，不写回 markdown）
  const collapseButton = event.target.closest('.milkdown-code-block .desk-code-collapse')
  if (collapseButton instanceof HTMLElement) {
    event.preventDefault()
    event.stopPropagation()
    const block = collapseButton.closest('.milkdown-code-block')
    if (block instanceof HTMLElement) toggleDeskCodeBlockCollapsed(block)
    return
  }

  const expandButton = event.target.closest('.milkdown-code-block .desk-code-expand')
  if (expandButton instanceof HTMLElement) {
    event.preventDefault()
    event.stopPropagation()
    const block = expandButton.closest('.milkdown-code-block')
    if (block instanceof HTMLElement) toggleCodeBlockFullscreen(block, expandButton)
    return
  }

  const copyButton = event.target.closest('.milkdown-code-block .copy-button')
  if (copyButton instanceof HTMLElement) {
    event.preventDefault()
    event.stopPropagation()
    const block = copyButton.closest('.milkdown-code-block')
    const text = block ? readCodeBlockPlainText(block) : ''
    void writeClipboard(text)
      .then(() => {
        copyButton.dataset.copied = 'true'
        copyButton.innerHTML = CHECK_ICON
        copyButton.setAttribute('aria-label', '已复制')
        window.setTimeout(() => {
          delete copyButton.dataset.copied
          copyButton.innerHTML = COPY_ICON
          copyButton.setAttribute('aria-label', '复制代码')
        }, 1200)
      })
      .catch(() => {
        /* writeClipboard already falls back; ignore residual errors */
      })
    return
  }

  const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor) return
  const href = anchor.getAttribute('href') ?? ''

  // NotesTable rows use desk-note://<uuid> so clicks open the note in Desk.
  if (href.startsWith('desk-note://')) {
    event.preventDefault()
    event.stopPropagation()
    let noteUuid = href.slice('desk-note://'.length)
    try {
      noteUuid = decodeURIComponent(noteUuid)
    } catch {
      /* keep raw */
    }
    if (noteUuid) emit('openNote', noteUuid)
    return
  }

  if (href.startsWith('#')) {
    event.preventDefault()
    let targetId = href.slice(1)
    try {
      targetId = decodeURIComponent(targetId)
    } catch {
      // Keep malformed hashes comparable to the literal heading id.
    }
    const target = resolveHeadingTarget(targetId)
    target?.scrollIntoView({ block: 'start' })
    return
  }
  if (!isEffectivelyReadOnly() && !event.metaKey && !event.ctrlKey) return
  event.preventDefault()
  emit('openLink', href)
}

/**
 * 点击编辑器面板里的空白区（可编辑区之外：正文列左右留白、上下 padding）时，
 * 浏览器会把焦点交给 `BODY` 并留下一个不响应的旧选区。这里主动把焦点收回编辑器，
 * 并把光标放到点击位置最近的文档位置——与「点正文空白继续写」的常规手感一致。
 */
function handleCanvasMousedown(event: MouseEvent): void {
  if (isEffectivelyReadOnly()) return
  const root = host.value
  if (!root || !(event.target instanceof Element)) return
  if (!isEditorBlankTarget(event.target, root)) return
  const view = editorView()
  if (!view || !view.editable) return
  event.preventDefault()
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
  const doc = view.state.doc
  const pos = coords ? Math.max(0, Math.min(coords.pos, doc.content.size)) : doc.content.size
  const bias = coords && pos < doc.content.size ? 1 : -1
  view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(pos), bias)))
  closeBlockActionMenu(false)
  view.focus()
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  const root = host.value
  if (!root?.querySelector('.milkdown-code-block.is-fullscreen')) return
  event.preventDefault()
  exitCodeBlockFullscreen(root)
}

/**
 * 文档同步会话的宿主接口。
 *
 * 分工：**视图连接留在组件里**（选区 / 滚动位置、整篇替换、从文档派生的 TOC 与大纲刷新），
 * 原文、canonical 基线、保真降级与待保存 flush 由 `createDocumentSync` 持有。
 *
 * 会话在 `onMounted` 里创建 —— 它的初始原文必须与「创建编辑器时用的那份 props.content」
 * 严格配对，不能把新 props 与旧编辑器内容配成一组基线。
 */
interface EditorViewSnapshot {
  from: number
  to: number
  scrollTop: number
  scrollEl: HTMLElement | null
}

function editorScrollElement(view: EditorView | null): HTMLElement | null {
  if (!view) return host.value
  return (view.dom.closest('.milkdown') as HTMLElement | null) ?? host.value
}

function createDocumentSyncHost(): DocumentSyncHost<EditorViewSnapshot> {
  return {
    readMarkdown: () => (ready && deskEditor ? deskEditor.getMarkdown() : null),
    readTopLevelNode: (index) => editorView()?.state.doc.child(index) ?? null,
    replaceDocument: (projected) => {
      deskEditor?.editor.action(replaceAll(projected, true))
    },
    captureViewState: () => {
      const view = editorView()
      const scrollEl = editorScrollElement(view)
      return {
        from: view?.state.selection.from ?? 0,
        to: view?.state.selection.to ?? 0,
        scrollTop: scrollEl?.scrollTop ?? 0,
        scrollEl
      }
    },
    restoreViewState: (snapshot) => {
      const view = editorView()
      if (!view || !snapshot) return
      const restored = clampViewPosition(
        snapshot,
        view.state.doc.content.size,
        Math.max(0, (snapshot.scrollEl?.scrollHeight ?? 0) - (snapshot.scrollEl?.clientHeight ?? 0))
      )
      try {
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.between(
              view.state.doc.resolve(restored.from),
              view.state.doc.resolve(restored.to)
            )
          )
        )
      } catch {
        // Positions that cannot be resolved after a structural rewrite stay at the default caret.
      }
      if (snapshot.scrollEl) snapshot.scrollEl.scrollTop = restored.scrollTop
    },
    afterDocumentReplaced: () => {
      applyGeneratedTocDisplay()
      refreshOutline()
    },
    emitSource: (source) => emit('change', source),
    reportStatus: (message) => {
      useWorkspaceStore().status = message
    },
    reportUnsavedDraft: (hasDraft) => {
      if (destroyed) return
      emit('unsavedDraftChange', hasDraft)
    },
    currentPropContent: () => props.content,
    reportDisplayLimited: (items) => {
      setDisplayLimited(items)
    },
    flushPendingDrafts: () =>
      flushPendingEdits(props.knowledgeBaseId, props.noteUuid, { requireClean: false })
  }
}

/**
 * 「以源码显示」的块（可视化排版不了的块）在文档里的下标集合。
 *
 * 这些块在编辑器里就是普通段落（按原文转义后显示），所以用 **decoration** 给它们加
 * 标记：既能让作者一眼看到「这块没做可视化排版」，也不会像直接改 DOM 那样在重渲染后丢失。
 */
const displayLimitedIndexes = ref<ReadonlySet<number>>(new Set())
const displayLimitedItems = ref<DisplayLimitedItem[]>([])

function setDisplayLimited(items: DisplayLimitedItem[]): void {
  displayLimitedItems.value = items
  displayLimitedIndexes.value = new Set(items.map((item) => item.index))
  emit('displayLimitedChange', items)
  refreshDisplayLimitedMarks()
}

/** 让 decoration 重新计算：只带 meta 的空事务，不动文档。 */
function refreshDisplayLimitedMarks(): void {
  const view = ctxView()
  if (!view || view.isDestroyed) return
  view.dispatch(view.state.tr.setMeta(displayLimitedKey, Date.now()))
}

function ctxView(): EditorView | null {
  try {
    return deskEditor?.editor.ctx.get(editorViewCtx) ?? null
  } catch {
    return null
  }
}

const displayLimitedKey = new PluginKey('deskDisplayLimited')
const displayLimitedPlugin = $prose(
  () =>
    new Plugin({
      key: displayLimitedKey,
      props: {
        decorations(state) {
          const indexes = displayLimitedIndexes.value
          if (indexes.size === 0) return null
          const decorations: Decoration[] = []
          state.doc.forEach((node, offset, index) => {
            if (!indexes.has(index)) return
            decorations.push(
              Decoration.node(offset, offset + node.nodeSize, {
                class: 'desk-display-limited',
                'data-display-limited': 'true'
              })
            )
          })
          return DecorationSet.create(state.doc, decorations)
        }
      }
    })
)

/**
 * 定位到第 `index` 个「以源码显示」的块：滚动过去并短暂高亮。
 * 找不到（文档结构变了）就返回 false，让调用方兜底提示。
 */
function revealDisplayLimited(index: number): boolean {
  const view = ctxView()
  if (!view || view.isDestroyed) return false
  let found = false
  view.state.doc.forEach((_node, offset, current) => {
    if (current !== index || found) return
    found = true
    let dom: Node | null = null
    try {
      dom = view.nodeDOM(offset)
    } catch {
      dom = null
    }
    if (dom instanceof HTMLElement) {
      dom.scrollIntoView({ block: 'center' })
      dom.classList.add('is-display-limited-flash')
      window.setTimeout(() => dom?.classList.remove('is-display-limited-flash'), 1600)
    }
  })
  return found
}

/**
 * 编辑器里是否有尚未 emit 出去的修改（保存被拦截时为 true）。
 * 只说明「比 store 新」，不代表导出内容完整安全。
 */
function hasUnsavedDraft(): boolean {
  return session?.hasUnsavedDraft() ?? false
}

/**
 * 导出编辑器的当前 Markdown 草稿，用于「复制当前修改」。
 * **未经完整性校验**，不能直接当成可保存的源码。
 */
function exportDraft(): string | null {
  return session?.exportDraft() ?? null
}

/** Commit block-local Edit drafts, then emit. Call before leaving visual mode. */
function flush(): void {
  if (session) {
    session.flush()
    return
  }
  // 会话在 onMounted 里创建；挂载前被父组件调用时仍要把草稿落下去（与抽取前一致）。
  flushPendingEdits(props.knowledgeBaseId, props.noteUuid, { requireClean: false })
}

/**
 * 标题编号：重排（先剥再按上限重编）与剥除。
 * replaceAll 是单个 ProseMirror 事务，一步撤销；随后采纳新原文（更新原文 + 基线）并 emit。
 */
function addHeadingNumbers(maxDepth: number): void {
  if (!deskEditor || !ready || isEffectivelyReadOnly() || !session) return
  flushPendingEdits(props.knowledgeBaseId, props.noteUuid, { requireClean: false })
  const result = renumberHeadings(session.reconcile(), maxDepth)
  if (!result.changed) return
  deskEditor.editor.action(replaceAll(projectRawBlocksForMilkdown(result.text), true))
  session.adoptSource(result.text)
  session.flush()
  focus()
}

function removeHeadingNumbers(): void {
  if (!deskEditor || !ready || isEffectivelyReadOnly() || !session) return
  flushPendingEdits(props.knowledgeBaseId, props.noteUuid, { requireClean: false })
  const result = stripHeadingNumbers(session.reconcile())
  if (!result.changed) return
  deskEditor.editor.action(replaceAll(projectRawBlocksForMilkdown(result.text), true))
  session.adoptSource(result.text)
  session.flush()
  focus()
}

function applyHeadingFold(command: HeadingFoldCommand): boolean {
  const view = editorView()
  if (!view) return false
  const transaction = applyHeadingFoldCommand(view.state, command)
  if (!transaction) return false
  view.dispatch(transaction)
  return true
}

onMounted(async () => {
  if (!host.value) return
  // 会话的初始原文 = 创建编辑器用的那份 props.content。两者必须是同一个值，
  // 否则 markReady() 读到的基线对不上原文；初始化期间 props 变了，在 ready 后补一次同步。
  const createdFrom = props.content
  session = createDocumentSync(createDocumentSyncHost(), createdFrom)
  const codeBlockHighlights = createCodeBlockHighlightBundle()
  // 自组装配（替代 Crepe）：基座 + kit 直供能力 + 从 Crepe 移植的 latex / block-edit /
  // toolbar，见 deskEditor.ts 与 crepePort/。序列化配置（序列化选项、上传、块手柄过滤）
  // 由 createDeskEditor 内部统一应用。
  const editor = createDeskEditor({
    root: host.value,
    defaultValue: projectRawBlocksForMilkdown(props.content),
    isReadOnly: isEffectivelyReadOnly,
    uploadImage: (file) => props.uploadImage(file),
    codeBlock: {
      languages: deskCodeMirrorLanguages,
      extensions: codeBlockHighlights.extensions,
      theme: document.documentElement.dataset.theme === 'light' ? githubLight : githubDark,
      copyText: '\u200b',
      copyIcon: COPY_ICON,
      previewOnlyByDefault: true
    },
    placeholder: {
      text: '输入 / 插入内容',
      mode: 'block'
    },
    latex: {},
    blockEdit: createDeskBlockEditConfig({ runSlashItem: runSlashItemInsert }),
    toolbar: {},
    // 选区浮动工具条开关由上层传入（`editor.selectionToolbar`，默认关闭）。
    // 这里用 getter 而不是快照值：设置面板一改，prop 更新就立即生效，不必重建编辑器。
    selectionToolbar: () => props.selectionToolbar
  })
  editor.editor.use(
    createCanvasImageClipboardPlugin({
      knowledgeBaseId: () => props.knowledgeBaseId,
      noteUuid: () => props.noteUuid,
      noteIndex: () => currentNoteSession()?.document.index ?? '',
      noteRelPath: () => currentNoteSession()?.document.relPath ?? '',
      isEffectivelyReadOnly
    })
  )
  editor.editor.use(rawBlockProjectionPlugins)
  editor.editor.use(createDeskCalloutView())
  editor.editor.use(deskCalloutKeymapPlugin)
  editor.editor.use(imageAttrPlugins)
  editor.editor.use(standaloneImageParagraphPlugin)
  editor.editor.use(displayLimitedPlugin)
  editor.editor.use(createCodeBlockTitlePlugin())
  editor.editor.use(createCodeBlockLatexPreviewPlugin())
  editor.editor.use(codeBlockHighlights.plugin)
  editor.editor.use(createMarkdownShortcutInputRules())
  editor.editor.use(createInlineCodeInteractionPlugin())
  editor.editor.use(createTableCaretPlugin())
  editor.editor.use(clearLineStylesPlugin)
  editor.editor.use(
    createBlockShortcutPlugin({
      onRawBlockInserted: openRawSourceEditorAt
    })
  )
  editor.editor.use(createDocumentSelectAllPlugin({ isPaneActive: () => props.active }))
  editor.editor.use(
    $prose(() =>
      createContainerUpgradePlugin({
        parser: () => {
          const parse = editor.editor.ctx.get(parserCtx)
          return (markdown: string) => parse(projectRawBlocksForMilkdown(markdown))
        },
        onUpgraded: (result) => {
          for (const line of result.lines) session?.noteUpgradedParagraph(line.trim())
        }
      })
    )
  )
  editor.editor.use(createRawBlockSelectionPlugin(boundaryOptions))
  editor.editor.use(createBlockBoundaryCaretPlugin())
  editor.editor.use(createBlockBoundaryNavigationPlugin(boundaryOptions))
  editor.editor.use(createHeadingSectionCollapsePlugin())
  editor.editor.use(createListItemCollapsePlugin())
  editor.editor.use(
    createReadonlyTransactionGuard({
      isReadOnly: isEffectivelyReadOnly,
      isExternalSync: () => session?.isSynchronizing() ?? false
    })
  )
  editor.editor.use(
    createDeskRawBlockView({
      isEffectivelyReadOnly,
      rawSourceReadonlyListeners,
      knowledgeBaseId: () => props.knowledgeBaseId,
      noteUuid: () => props.noteUuid,
      uploadImage: (file) => props.uploadImage(file),
      writeClipboard
    })
  )
  editor.editor.use(
    createDeskImageView({
      knowledgeBaseId: () => props.knowledgeBaseId,
      noteUuid: () => props.noteUuid,
      noteRelPath: () => {
        const session =
          useWorkspaceStore().documents[documentKey(props.knowledgeBaseId, props.noteUuid)]
        return session?.document.relPath ?? ''
      },
      isReadOnly: isEffectivelyReadOnly,
      writeClipboard
    })
  )
  editor.editor.use(
    $prose(
      () =>
        new Plugin({
          view: (view) => {
            reportHeadingLevel(view)
            return {
              update: (view, previousState) => {
                if (!view.state.doc.eq(previousState.doc)) {
                  session?.queueFlush()
                  if (ready) queueMicrotask(refreshOutline)
                }
                if (
                  !view.state.selection.eq(previousState.selection) ||
                  !view.state.doc.eq(previousState.doc)
                ) {
                  reportHeadingLevel(view)
                }
                // 选区落进被折叠的列表子树（撤销 / 程序化定位）时自动展开；
                // 延到微任务里，避免在 view update 过程中再 dispatch。
                if (!view.state.selection.eq(previousState.selection)) {
                  queueMicrotask(() => {
                    expandCollapsedListItemsContaining(view, view.state.selection.from)
                  })
                }
              }
            }
          }
        })
    )
  )
  editor.setReadonly(isEffectivelyReadOnly())
  deskEditor = editor
  try {
    await editor.create()
    if (destroyed) {
      await editor.destroy()
      return
    }
    // ready 先立起来：markReady() 通过 readMarkdown() 读基线，而后者以 ready 为门。
    ready = true
    session.markReady()
    session.scheduleFidelityCheck()
    applyReadonlyState()
    applyGeneratedTocDisplay()
    if (host.value) {
      blockHandleClickCleanup = installBlockHandleClickController({
        root: host.value,
        getView: editorView,
        onClick: openBlockActionMenu
      })
      document.addEventListener('pointerdown', handleBlockMenuOutsidePointer, {
        capture: true
      })
      document.addEventListener('pointerup', handleBlockMenuDocumentPointerUp, {
        capture: true
      })
      document.addEventListener('keydown', handleKeydown)
    }
    // 初始化期间 props 变过：编辑器是按 createdFrom 建的，这里补一次同步，
    // 不能把新 props 与旧编辑器内容配成一组基线。
    if (props.content !== createdFrom) await session.syncExternal(props.content)
    if (props.active) focus()
    refreshOutline()
  } catch (cause) {
    // 建编辑器失败：会话不该再排任何检查。
    session?.dispose()
    try {
      await editor.destroy()
    } catch {
      // A partially-created editor may not have every cleanup timer available.
    }
    if (deskEditor === editor) deskEditor = null
    emit('fatal', cause instanceof Error ? cause.message : String(cause))
  }
})

watch(
  () => props.content,
  (content) => {
    if (!ready || !deskEditor) return
    // 是不是自己刚 emit 出去的值、要不要整篇替换，都由会话判断。
    session?.handleExternalContent(content)
  }
)

watch(
  () => [props.mode, props.readOnly] as const,
  () => {
    // Before `editor.create()` resolves there is no view to update; onMounted
    // applies the readonly state once ready, so skip the pre-ready window.
    if (!ready || !deskEditor) return
    applyReadonlyState()
  }
)

watch(
  () => props.tocDisplay,
  () => applyGeneratedTocDisplay()
)

watch(
  () => props.selectionToolbar,
  (enabled) => {
    // 关掉开关时立刻收起已显示的浮条：`shouldShow` 只在编辑器更新时重算，
    // 光靠它会让上一次选区留下的浮条一直挂到下次编辑器交互（期间仍拦截指针事件）。
    if (enabled || !deskEditor) return
    hideSelectionToolbar(deskEditor.editor)
  }
)

watch(
  () => props.active,
  (active) => {
    if (active) {
      host.value?.querySelector('.ProseMirror')?.dispatchEvent(new Event('desk-code-chrome-sync'))
      focus()
    }
  }
)

onBeforeUnmount(() => {
  if (host.value) exitCodeBlockFullscreen(host.value)
  // Switching to source unmounts the visual editor; flush first so pending raw-block
  // drafts and in-progress visual edits are committed, then retire the session
  // (queued microtasks / idle fidelity checks stop owning this document).
  flush()
  session?.dispose()
  destroyed = true
  ready = false
  blockHandleClickCleanup?.()
  blockHandleClickCleanup = null
  document.removeEventListener('pointerdown', handleBlockMenuOutsidePointer, {
    capture: true
  })
  document.removeEventListener('pointerup', handleBlockMenuDocumentPointerUp, {
    capture: true
  })
  document.removeEventListener('keydown', handleKeydown)
  closeBlockActionMenu(false)
  const editor = deskEditor
  deskEditor = null
  if (editor) void editor.destroy()
})
</script>

<template>
  <div
    class="milkdown-markdown-editor tn-prose"
    :class="{
      'is-readonly': isEffectivelyReadOnly(),
      'is-wide': pageWidth === 'wide',
      'is-outline-hidden': !props.outlineVisible,
      'is-toc-hidden': tocDisplay === 'hidden'
    }"
  >
    <div
      ref="host"
      class="milkdown-markdown-editor__canvas"
      v-once
      @click.capture="handleClick"
      @mousedown="handleCanvasMousedown"
      @scroll.passive="syncOutlineActive"
    />
    <NoteOutline
      v-show="props.outlineVisible"
      :headings="outlineHeadings"
      :active-id="outlineActiveId"
      @select="scrollToOutlineHeading"
    />
    <Teleport to="body">
      <BlockActionMenu
        v-if="blockActionMenu"
        :x="blockActionMenu.x"
        :y="blockActionMenu.y"
        @action="handleBlockAction"
        @add-below="openAddBelowMenu"
        @close="closeBlockActionMenu"
      />
    </Teleport>
  </div>
</template>

<style scoped src="./milkdownMarkdownEditor.scoped.css"></style>

<style src="./milkdownMarkdownEditor.global.css"></style>
