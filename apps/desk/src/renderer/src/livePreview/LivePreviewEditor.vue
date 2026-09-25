<script setup lang="ts">
/**
 * 笔记编辑器（CodeMirror 6 实时预览）。
 *
 * 编辑器里只有一份 Markdown 文本：可视化与源码是同一个 EditorView 的两种显示，
 * 切换时光标、选区、滚动、撤销历史都保留；保存的就是这份文本（所写即所存）。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewlineAndIndent
} from '@codemirror/commands'
import {
  codeFolding,
  foldKeymap,
  indentUnit,
  syntaxHighlighting,
  syntaxTree
} from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorSelection, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  placeholder,
  rectangularSelection
} from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'

import NoteOutline from '../markdown/NoteOutline.vue'
import { resolveMarkdownImageUrl } from '../markdown/markdownAssetUrl'
import { renumberHeadings, stripHeadingNumbers } from '../editor/markdown/headingNumbering'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { mindmapPreviewMarkdown } from '../editor/markdown/mindmapFence'
import { mindmapFenceOrdinal } from '../editor/markdown/mindmapFenceLocate'
import {
  arrowDownIntoBlock,
  arrowUpIntoBlock,
  clearLineStyles,
  continueMarkup,
  deleteMarkup,
  headingBackspace,
  insertText,
  prefixSelection as prefixSelectionCommand,
  setLinePrefix as setLinePrefixCommand,
  shiftTabCommand,
  tabCommand,
  wrapSelection as wrapSelectionCommand
} from './commands'
import { cardKnowledgeBase, codeGroupTabs, keepCursorOutOfHiddenCodeGroup, livePreviewField } from './decorations'
import { codeBlockFullscreenClass } from './codeBlockChrome'
import { applyHeadingFoldCommand, headingFoldService, keepCursorOutOfFold, type HeadingFoldCommand } from './headingFold'
import { livePreviewEnabled, livePreviewHost } from './host'
import { tnotesMarkdown } from './language'
import { collectHeadings, type OutlineHeading } from './outline'
import { captureSelection } from './selectionCapture'
import { agentReviewExtension } from './agentReview'
import { frontmatterIdGuard } from './frontmatterIdGuard'
import { registerLiveEditor, unregisterLiveEditor } from './editorRegistry'

import type { EditorSelectionAnchor, EditorSelectionPayload } from '../selection/selectionReporter'
import type { NotePageWidth, NoteViewMode } from '../../../shared/contracts'

import { DESK_SELECT_ALL_EVENT } from './events'

import './livePreview.css'

const props = withDefaults(
  defineProps<{
    content: string
    mode: NoteViewMode
    readOnly: boolean
    knowledgeBaseId: string
    noteUuid: string
    /** 笔记在知识库内的相对路径；画布探测需要 */
    noteRelPath?: string
    active: boolean
    pageWidth?: NotePageWidth
    outlineVisible?: boolean
  }>(),
  { pageWidth: 'standard', outlineVisible: true, noteRelPath: '' }
)

const editorStore = useEditorStore()
const workspaceStore = useWorkspaceStore()

const emit = defineEmits<{
  change: [content: string]
  openLink: [url: string]
  openNote: [noteUuid: string]
  pasteImage: [file: File, insertAt: number]
  selectionChange: [payload: EditorSelectionPayload]
  pinSelection: []
  headingLevelChange: [level: number | null]
}>()

const host = ref<HTMLElement | null>(null)
const headings = ref<OutlineHeading[]>([])
const activeHeadingId = ref<string | null>(null)

let view: EditorView | null = null
const modeCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
const contextCompartment = new Compartment()
/** 外部同步（磁盘重载等）产生的修改不回抛 change */
const externalSync = Annotation.define<boolean>()
let lastHeadingLevel: number | null | undefined
let outlineTimer: ReturnType<typeof setTimeout> | null = null

function modeExtensions(mode: NoteViewMode) {
  const visual = mode !== 'source'
  return [
    livePreviewEnabled.of(visual),
    EditorView.editorAttributes.of({ class: visual ? 'cm-lp-visual' : 'cm-lp-source' })
  ]
}

function readOnlyExtensions(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

function noteTitle(): string {
  return (
    workspaceStore.getDocumentSession(props.knowledgeBaseId, props.noteUuid)?.document.title ?? ''
  )
}

function openCanvas(sourceRelPath: string): void {
  const knowledgeBase =
    workspaceStore.overview.allKnowledgeBases.find((item) => item.id === props.knowledgeBaseId) ??
    null
  if (!knowledgeBase) {
    workspaceStore.error = `无法打开画布：${sourceRelPath}`
    return
  }
  const fileName = sourceRelPath.split('/').pop() ?? sourceRelPath
  const title = noteTitle() ? `${fileName} · ${noteTitle()}` : fileName
  editorStore.openExcalidraw(knowledgeBase, sourceRelPath, { title })
}

function openMindmap(fenceSource: string): void {
  const knowledgeBase =
    workspaceStore.overview.allKnowledgeBases.find((item) => item.id === props.knowledgeBaseId) ??
    null
  if (!knowledgeBase) {
    workspaceStore.error = '无法打开思维导图编辑'
    return
  }
  const preview = mindmapPreviewMarkdown(fenceSource)
  const titleMatch = preview.markdown.match(/^\s{0,3}#(?!#)\s+(.+?)\s*$/m)
  const topic = (titleMatch?.[1] ?? preview.parts.options.title ?? '思维导图').trim() || '思维导图'
  const title = noteTitle() ? `${topic} · ${noteTitle()}` : topic
  const doc = view?.state.doc.toString() ?? props.content
  const fenceOrdinal = mindmapFenceOrdinal(doc, fenceSource) ?? undefined
  editorStore.openMindmap(knowledgeBase, props.noteUuid, fenceSource, { title, fenceOrdinal })
}

function contextExtensions() {
  return [
    livePreviewHost.of({
      resolveImage: (src) => resolveMarkdownImageUrl(src, props.knowledgeBaseId, props.noteUuid),
      openLink: (href) => openHref(href),
      knowledgeBaseId: props.knowledgeBaseId,
      noteUuid: props.noteUuid,
      noteRelPath: props.noteRelPath,
      isReadOnly: () => props.readOnly,
      openCanvas,
      openMindmap
    }),
    cardKnowledgeBase.of(props.knowledgeBaseId)
  ]
}

function openHref(href: string): void {
  if (!href) return
  if (href.startsWith('desk-note://')) {
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
    const target = headings.value.find(
      (heading) => heading.text.replace(/\s+/g, '-').toLowerCase() === decodeURIComponent(href.slice(1)).toLowerCase()
    )
    if (target) scrollToHeading(target.id)
    return
  }
  emit('openLink', href)
}

function imageFileFrom(data: DataTransfer | null): File | null {
  for (const item of data?.items ?? []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile()
  }
  return null
}

function emitSelection(): void {
  if (!props.active || !view) return
  emit('selectionChange', captureSelection(view.state))
}

function updateHeadingLevel(state: EditorState): void {
  const node = syntaxTree(state).resolveInner(state.selection.main.head, -1)
  let level: number | null = null
  for (let current: typeof node | null = node; current; current = current.parent) {
    const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(current.name)
    if (match) {
      level = Number(match[1])
      break
    }
  }
  if (level === lastHeadingLevel) return
  lastHeadingLevel = level
  emit('headingLevelChange', level)
}

function refreshOutline(): void {
  if (!view) return
  headings.value = collectHeadings(view.state)
  syncActiveHeading()
}

function scheduleOutline(): void {
  if (outlineTimer) clearTimeout(outlineTimer)
  outlineTimer = setTimeout(() => {
    outlineTimer = null
    refreshOutline()
  }, 200)
}

function syncActiveHeading(): void {
  if (!view || headings.value.length === 0) {
    activeHeadingId.value = null
    return
  }
  const top = view.scrollDOM.getBoundingClientRect().top + 24
  const pos = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 8, y: top }, false)
  let active: OutlineHeading | null = headings.value[0]
  for (const heading of headings.value) {
    if (heading.from <= pos) active = heading
    else break
  }
  activeHeadingId.value = active?.id ?? null
}

function scrollToHeading(id: string): void {
  const heading = headings.value.find((item) => item.id === id)
  if (!view || !heading) return
  view.dispatch({
    selection: { anchor: view.state.doc.lineAt(heading.from).to },
    effects: EditorView.scrollIntoView(heading.from, { y: 'start', yMargin: 16 })
  })
  activeHeadingId.value = id
  view.focus()
}

/** 打开笔记时光标放在 frontmatter 之后的第一行正文（而不是 frontmatter 里） */
function initialCursor(doc: string): number {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(doc)
  let pos = frontmatter ? frontmatter[0].length : 0
  while (pos < doc.length && (doc[pos] === '\n' || doc[pos] === '\r')) pos += 1
  return Math.min(pos, doc.length)
}

function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(initialCursor(doc)),
    extensions: [
      tnotesMarkdown(),
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      EditorView.lineWrapping,
      indentUnit.of('    '),
      EditorState.tabSize.of(4),
      syntaxHighlighting(classHighlighter),
      codeGroupTabs,
      headingFoldService,
      codeBlockFullscreenClass,
      keepCursorOutOfHiddenCodeGroup,
      keepCursorOutOfFold,
      codeFolding({ placeholderText: '…' }),
      livePreviewField,
      search({ top: true }),
      highlightSelectionMatches(),
      placeholder('开始写作…'),
      agentReviewExtension(),
      frontmatterIdGuard(),
      modeCompartment.of(modeExtensions(props.mode)),
      readOnlyCompartment.of(readOnlyExtensions(props.readOnly)),
      contextCompartment.of(contextExtensions()),
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      keymap.of([
        { key: 'Enter', run: continueMarkup },
        { key: 'Enter', run: insertNewlineAndIndent },
        { key: 'Backspace', run: headingBackspace },
        { key: 'Backspace', run: deleteMarkup },
        { key: 'Tab', run: tabCommand },
        { key: 'Shift-Tab', run: shiftTabCommand },
        { key: 'ArrowDown', run: arrowDownIntoBlock },
        { key: 'ArrowUp', run: arrowUpIntoBlock },
        { key: 'Mod-b', run: (v) => (wrapSelectionCommand(v, '**', '**'), true) },
        { key: 'Mod-i', run: (v) => (wrapSelectionCommand(v, '*', '*'), true) },
        { key: 'Mod-e', run: (v) => (wrapSelectionCommand(v, '`', '`', '代码'), true) },
        { key: 'Mod-Shift-x', run: (v) => (wrapSelectionCommand(v, '~~', '~~'), true) },
        { key: 'Mod-k', run: (v) => (wrapSelectionCommand(v, '[', '](https://)', '链接'), true) },
        { key: 'Mod-Shift-7', run: (v) => (setLinePrefixCommand(v, '1. '), true) },
        { key: 'Mod-Shift-8', run: (v) => (setLinePrefixCommand(v, '- '), true) },
        { key: 'Mod-Alt-t', run: (v) => (setLinePrefixCommand(v, '- [ ] '), true) },
        { key: 'Mod-Alt-u', run: (v) => (setLinePrefixCommand(v, '> '), true) },
        { key: 'Mod-Alt-s', run: (v) => (insertText(v, '\n---\n'), true) },
        { key: 'Mod-Alt-0', run: (v) => (setLinePrefixCommand(v, ''), true) },
        ...[1, 2, 3, 4, 5, 6].map((level) => ({
          key: `Mod-Alt-${level}`,
          run: (v: EditorView) => (setLinePrefixCommand(v, `${'#'.repeat(level)} `), true)
        })),
        { key: 'Mod-\\', run: clearLineStyles },
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...defaultKeymap
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const external = update.transactions.some((tr) => tr.annotation(externalSync))
          if (!external) emit('change', update.state.doc.toString())
          scheduleOutline()
        }
        if (update.docChanged || update.selectionSet) {
          emitSelection()
          updateHeadingLevel(update.state)
        }
      }),
      EditorView.domEventHandlers({
        paste(event, editorView) {
          const file = imageFileFrom(event.clipboardData)
          if (!file || editorView.state.readOnly) return false
          event.preventDefault()
          emit('pasteImage', file, editorView.state.selection.main.from)
          return true
        },
        drop(event, editorView) {
          const file = imageFileFrom(event.dataTransfer)
          if (!file || editorView.state.readOnly) return false
          event.preventDefault()
          const pos = editorView.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editorView.state.selection.main.from
          emit('pasteImage', file, pos)
          return true
        },
        mousedown(event) {
          const target = event.target as HTMLElement | null
          const anchor = target?.closest<HTMLAnchorElement>('.cm-lp-card a[href]')
          if (anchor) {
            event.preventDefault()
            openHref(anchor.getAttribute('href') ?? '')
            return true
          }
          const link = target?.closest<HTMLElement>('.cm-lp-link')
          if (link && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            openHref(link.dataset.href ?? '')
            return true
          }
          return false
        },
        scroll() {
          syncActiveHeading()
        }
      })
    ]
  })
}

/** 用最小差异替换文档（外部重载时保住光标与滚动） */
function syncContent(next: string): void {
  if (!view) return
  const current = view.state.doc.toString()
  if (current === next) return
  let start = 0
  const limit = Math.min(current.length, next.length)
  while (start < limit && current.charCodeAt(start) === next.charCodeAt(start)) start += 1
  let endCurrent = current.length
  let endNext = next.length
  while (endCurrent > start && endNext > start && current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)) {
    endCurrent -= 1
    endNext -= 1
  }
  view.dispatch({
    changes: { from: start, to: endCurrent, insert: next.slice(start, endNext) },
    annotations: externalSync.of(true)
  })
}

/** 整篇替换成新文本，但只提交真正变了的行（标题编号这类批量修改，一步撤销） */
function replaceByLines(next: string): void {
  if (!view || view.state.readOnly) return
  const doc = view.state.doc
  const nextLines = next.split('\n')
  if (nextLines.length !== doc.lines) {
    view.dispatch({ changes: { from: 0, to: doc.length, insert: next }, userEvent: 'input' })
    return
  }
  const changes: Array<{ from: number; to: number; insert: string }> = []
  nextLines.forEach((text, index) => {
    const line = doc.line(index + 1)
    if (line.text !== text) changes.push({ from: line.from, to: line.to, insert: text })
  })
  if (changes.length > 0) view.dispatch({ changes, userEvent: 'input' })
}

function selectRange(from: number, to: number): boolean {
  if (!view) return false
  const length = view.state.doc.length
  const anchor = Math.min(Math.max(0, from), length)
  const head = Math.min(Math.max(0, to), length)
  view.dispatch({
    selection: EditorSelection.single(anchor, head),
    effects: EditorView.scrollIntoView(anchor, { y: 'center' })
  })
  view.focus()
  return true
}

function selectionCapture(): EditorSelectionPayload | null {
  return view ? captureSelection(view.state) : null
}

function pinnableSelection(): { capture: EditorSelectionPayload; anchor: EditorSelectionAnchor } | null {
  const payload = selectionCapture()
  if (!payload || payload.empty || payload.unsupportedReason || !payload.anchor) return null
  return { capture: payload, anchor: payload.anchor }
}

function validatePinnedAnchor(
  anchor: EditorSelectionAnchor,
  expected: string
): { valid: boolean; reason?: string } | null {
  if (!view || anchor.kind !== 'source-range' || !anchor.sourceRange) return null
  const { startOffset, endOffset } = anchor.sourceRange
  const current = view.state.doc.sliceString(startOffset, endOffset)
  if (current === expected) return { valid: true }
  return {
    valid: false,
    reason: `固定时的源码范围（偏移 ${startOffset}–${endOffset}）现在已经不是原来那段内容（内容或坐标变了）`
  }
}

function revealPinnedAnchor(anchor: EditorSelectionAnchor): boolean {
  if (anchor.kind !== 'source-range' || !anchor.sourceRange) return false
  return selectRange(anchor.sourceRange.startOffset, anchor.sourceRange.endOffset)
}

function revealReference(rawPath: string): boolean {
  if (!view || !rawPath) return false
  const index = view.state.doc.toString().indexOf(rawPath)
  if (index < 0) return false
  return selectRange(index, index + rawPath.length)
}

function revealLine(line: number): boolean {
  if (!view || !Number.isFinite(line)) return false
  const target = Math.min(Math.max(Math.round(line), 1), view.state.doc.lines)
  const pos = view.state.doc.line(target).from
  return selectRange(pos, pos)
}

function selectAll(): void {
  if (!view || !props.active || !host.value) return
  const group = host.value.closest('.editor-group')
  if (group && !group.classList.contains('active')) return
  view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) })
  view.focus()
}

function withView(run: (editorView: EditorView) => void): void {
  if (view) run(view)
}

defineExpose({
  selectionCapture,
  pinnableSelection,
  validatePinnedAnchor,
  revealPinnedAnchor,
  revealReference,
  revealLine,
  insertTextAt: (text: string, position?: number) => withView((v) => insertText(v, text, position)),
  wrapSelection: (prefix: string, suffix: string, placeholderText?: string) =>
    withView((v) => wrapSelectionCommand(v, prefix, suffix, placeholderText)),
  prefixSelection: (prefix: string) => withView((v) => prefixSelectionCommand(v, prefix)),
  setLinePrefix: (prefix: string) => withView((v) => setLinePrefixCommand(v, prefix)),
  insertTable: () => withView((v) => insertText(v, '\n|  |  |\n| --- | --- |\n|  |  |\n')),
  addHeadingNumbers: (maxDepth: number) =>
    withView((v) => {
      const result = renumberHeadings(v.state.doc.toString(), maxDepth)
      if (result.changed) replaceByLines(result.text)
    }),
  removeHeadingNumbers: () =>
    withView((v) => {
      const result = stripHeadingNumbers(v.state.doc.toString())
      if (result.changed) replaceByLines(result.text)
    }),
  applyHeadingFold: (command: HeadingFoldCommand) => (view ? applyHeadingFoldCommand(view, command) : false),
  selectAll,
  focus: () => view?.focus(),
  flush: () => undefined,
  getView: () => view
})

onMounted(() => {
  if (!host.value) return
  view = new EditorView({ state: createState(props.content), parent: host.value })
  registerLiveEditor(props.knowledgeBaseId, props.noteUuid, view)
  window.addEventListener(DESK_SELECT_ALL_EVENT, selectAll)
  refreshOutline()
  updateHeadingLevel(view.state)
})

onBeforeUnmount(() => {
  window.removeEventListener(DESK_SELECT_ALL_EVENT, selectAll)
  if (outlineTimer) clearTimeout(outlineTimer)
  if (view) unregisterLiveEditor(props.knowledgeBaseId, props.noteUuid, view)
  view?.destroy()
  view = null
})

watch(
  () => props.content,
  (content) => syncContent(content)
)

watch(
  () => props.mode,
  (mode) => {
    view?.dispatch({ effects: modeCompartment.reconfigure(modeExtensions(mode)) })
    view?.focus()
  }
)

watch(
  () => props.readOnly,
  (readOnly) => view?.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly)) })
)

watch(
  () => [props.knowledgeBaseId, props.noteUuid, props.noteRelPath],
  () => view?.dispatch({ effects: contextCompartment.reconfigure(contextExtensions()) })
)

watch(
  () => props.active,
  (active) => {
    if (active) void nextTick(() => view?.requestMeasure())
  }
)
</script>

<template>
  <div
    class="live-editor"
    :class="{ 'is-wide': pageWidth === 'wide', 'is-outline-hidden': !outlineVisible }"
    data-testid="live-editor"
  >
    <div ref="host" class="live-editor__canvas" />
    <NoteOutline
      v-if="outlineVisible"
      :headings="headings"
      :active-id="activeHeadingId"
      @select="scrollToHeading"
    />
  </div>
</template>

<style scoped>
.live-editor {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
  background: var(--editor-bg);
}

.live-editor__canvas {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.live-editor__canvas :deep(.cm-editor) {
  flex: 1;
  min-width: 0;
  height: 100%;
}
</style>
