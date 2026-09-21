<script setup lang="ts">
/**
 * 笔记源码视图（Monaco）。
 *
 * 与可视化编辑器共用同一份 markdown：内容只在用户真的输入时 emit `change`，
 * 外部同步（磁盘重载 / 视图切换回流）不 emit，避免"回声"把父组件状态搅乱。
 *
 * 保留的既有行为（e2e 与用户习惯都依赖）：
 * - 暴露给工具栏的同一组方法（插入 / 包裹 / 行前缀 / 标题编号 / 全选）
 * - 只读时所有入口都被挡住
 * - 粘贴图片交给宿主落地（emit `pasteImage` + 当前插入偏移）
 * - `Mod-\` 剥掉选区内的 Markdown 样式标记
 * - 页宽（标准 / 超宽）与明暗主题跟随应用
 * - 应用菜单的"全选"走 DESK_SELECT_ALL_EVENT
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  loadMonaco,
  monacoThemeName,
  readOnlyEditorOptions,
  refreshMonacoTheme
} from '../monaco/monaco'

import { sourceLineStyleChangesFor } from './clearSourceLineStyles'
import { headingFoldTargetLines } from './sourceFolding'
import { DESK_SELECT_ALL_EVENT, shouldHandleDeskSelectAll } from './documentSelection'
import { renumberHeadings, stripHeadingNumbers } from '../editor/markdown/headingNumbering'
import {
  insertTextEdit,
  prefixLinesEdit,
  replaceAllEdit,
  setLinePrefixEdit,
  wrapSelectionEdit,
  type TextEdit
} from './sourceEdits'

import type { HeadingFoldCommand } from './headingSectionCollapse'
import type { NotePageWidth, NoteViewMode } from '../../../shared/contracts'
import type * as MonacoApi from 'monaco-editor'

const props = withDefaults(
  defineProps<{
    content: string
    mode: NoteViewMode
    pageWidth?: NotePageWidth
    readOnly: boolean
    knowledgeBaseId: string
    noteUuid: string
    active: boolean
  }>(),
  { pageWidth: 'standard' }
)

const emit = defineEmits<{
  change: [content: string]
  openLink: [url: string]
  openNote: [noteUuid: string]
  pasteImage: [file: File, insertAt: number]
}>()

const host = ref<HTMLElement | null>(null)
const mountError = ref('')

let monaco: Awaited<ReturnType<typeof loadMonaco>> | null = null
let editor: MonacoApi.editor.IStandaloneCodeEditor | null = null
let appearanceObserver: MutationObserver | null = null
let resizeObserver: ResizeObserver | null = null
let pasteListener: ((event: ClipboardEvent) => void) | null = null
let disposing = false
/** 外部同步期间不回抛 change（初始化与 props 回流都算） */
let syncing = false

/**
 * 懒加载失败的原因归一化：这类失败几乎都是「页面里的模块地址过期了」，
 * 重新加载窗口就能拿到新的地址，所以提示里给出这个动作。
 */
function loadFailureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return `源码编辑器加载失败：${detail}。若刚更新过依赖或代码，重新加载窗口即可恢复。`
}

async function retryMount(): Promise<void> {
  mountError.value = ''
  if (disposing || !host.value) return
  try {
    monaco = await loadMonaco()
  } catch (cause) {
    mountError.value = loadFailureMessage(cause)
    return
  }
  createEditor(host.value)
}

function reloadWindow(): void {
  window.location.reload()
}

const isEffectivelyReadOnly = (): boolean => props.readOnly || props.mode === 'readonly'

function model(): MonacoApi.editor.ITextModel | null {
  return editor?.getModel() ?? null
}

/** 选区（0 基偏移）→ 供纯函数使用的区间 */
function selectionOffsets(): { from: number; to: number } {
  const current = editor?.getSelection()
  if (!current) return { from: 0, to: 0 }
  return { from: offsetOf(current.getStartPosition()), to: offsetOf(current.getEndPosition()) }
}

function offsetOf(position: MonacoApi.IPosition): number {
  return model()?.getOffsetAt(position) ?? 0
}

function selectionEnd(): number {
  const current = editor?.getSelection()
  if (!current || !model()) return 0
  return model()!.getOffsetAt(current.getEndPosition())
}

/** 应用一次纯函数算出来的编辑，并把选区放回去 */
function applyEdit(edit: TextEdit): void {
  const instance = editor
  const textModel = model()
  if (!instance || !textModel) return
  instance.executeEdits('desk-source', [{ range: rangeOf(edit.from, edit.to), text: edit.insert }])
  instance.setSelection(rangeOf(edit.selectionFrom, edit.selectionTo))
  instance.focus()
}

/** 0 基偏移 → Monaco 区间（用 model 自带换算，避免自己数行） */
function rangeOf(from: number, to: number): MonacoApi.IRange {
  const textModel = model()
  if (!textModel) {
    return { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
  }
  const start = textModel.getPositionAt(from)
  const end = textModel.getPositionAt(to)
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column
  }
}

function runEdit(build: (text: string, from: number, to: number) => TextEdit): boolean {
  const textModel = model()
  if (!textModel || isEffectivelyReadOnly()) return false
  const { from, to } = selectionOffsets()
  applyEdit(build(textModel.getValue(), from, to))
  return true
}

function insertTextAt(text: string, position?: number): void {
  const textModel = model()
  if (!textModel || isEffectivelyReadOnly()) return
  const { from } = selectionOffsets()
  applyEdit(insertTextEdit(textModel.getValue(), text, position, from))
}

function wrapSelection(prefix: string, suffix: string, placeholder = '文字'): void {
  runEdit((text, from, to) => wrapSelectionEdit(text, from, to, prefix, suffix, placeholder))
}

function prefixSelection(prefix: string): void {
  runEdit((text, from, to) => prefixLinesEdit(text, from, to, prefix))
}

function setLinePrefix(prefix: string): void {
  runEdit((text, from, to) => setLinePrefixEdit(text, from, to, prefix))
}

function insertTable(): void {
  insertTextAt('\n|  |  |\n| --- | --- |\n|  |  |\n')
}

/** 标题编号：重排（先剥再按上限重编）与剥除，都是单次编辑 → 一步撤销 */
function addHeadingNumbers(maxDepth: number): void {
  const textModel = model()
  if (!textModel || isEffectivelyReadOnly()) return
  const result = renumberHeadings(textModel.getValue(), maxDepth)
  if (!result.changed) return
  applyEdit(replaceAllEdit(textModel.getValue(), result.text))
}

function removeHeadingNumbers(): void {
  const textModel = model()
  if (!textModel || isEffectivelyReadOnly()) return
  const result = stripHeadingNumbers(textModel.getValue())
  if (!result.changed) return
  applyEdit(replaceAllEdit(textModel.getValue(), result.text))
}

/** 清掉选区内行的 Markdown 样式标记（`Mod-\`） */
function clearLineStyles(): boolean {
  const textModel = model()
  if (!textModel || isEffectivelyReadOnly()) return false
  const { from, to } = selectionOffsets()
  const changes = sourceLineStyleChangesFor(textModel.getValue(), from, to)
  if (changes.length === 0) return true
  editor?.executeEdits(
    'desk-clear-line-styles',
    changes.map((change) => ({
      range: rangeOf(change.from, change.to),
      text: change.insert
    }))
  )
  editor?.focus()
  return true
}

/**
 * 定位一处资源引用：在源码里找该相对路径，选中它并滚动到中间。
 *
 * 源码视图的位置就是 markdown 偏移，所以这里可以直接用 indexOf 的偏移。
 */
function revealReference(rawPath: string): boolean {
  const textModel = model()
  if (!editor || !textModel || !rawPath) return false
  const index = textModel.getValue().indexOf(rawPath)
  if (index < 0) return false
  const range = rangeOf(index, index + rawPath.length)
  editor.setSelection(range)
  editor.revealRangeInCenter(range)
  editor.focus()
  return true
}

/**
 * 跳到指定行（1-based）并聚焦：源码视图是「这块可视化排版不了」时的编辑入口。
 * 行号越界时夹到有效范围，返回是否真的定位成功。
 */
function revealLine(line: number): boolean {
  const textModel = model()
  if (!editor || !textModel || !Number.isFinite(line)) return false
  const lineCount = textModel.getLineCount()
  const target = Math.min(Math.max(Math.round(line), 1), lineCount)
  const position = { lineNumber: target, column: 1 }
  editor.setPosition(position)
  editor.revealLineInCenter(target)
  editor.focus()
  return true
}

function selectAll(): void {
  const textModel = model()
  if (!editor || !textModel || !shouldHandleDeskSelectAll(host.value, props.active)) return
  editor.setSelection(textModel.getFullModelRange())
  editor.focus()
}

/**
 * 命令面板的标题折叠在源码视图的落点：把命令翻译成"要折叠/展开的标题行"，
 * 再交给 Monaco 自己的 `editor.fold` / `editor.unfold`。
 *
 * 为什么带 `levels: 1, direction: 'down'`：不带这两个参数时 Monaco 的 Fold 命令在
 * "该行已经折叠"时会**向上折父级**（键盘上连续按 Fold 的语义）；我们按标题行精确操作，
 * 只动"起始于这一行的范围"，已经折过的行保持原状。
 *
 * 只作用标题：`editor.foldAll` 会把代码块也折了，那就不是「全部折叠标题」了。
 */
function applyHeadingFold(command: HeadingFoldCommand): boolean {
  const instance = editor
  const textModel = model()
  if (!instance || !textModel) return false
  const lines = headingFoldTargetLines(command, textModel.getValue())
  if (lines.length === 0) return false
  const unfold = command.startsWith('unfold')
  const action = instance.getAction(unfold ? 'editor.unfold' : 'editor.fold')
  if (!action) return false
  void action.run(
    unfold ? { selectionLines: lines } : { levels: 1, direction: 'down', selectionLines: lines }
  )
  return true
}

defineExpose({
  revealReference,
  revealLine,
  insertTextAt,
  wrapSelection,
  prefixSelection,
  setLinePrefix,
  insertTable,
  addHeadingNumbers,
  removeHeadingNumbers,
  applyHeadingFold,
  selectAll
})

/** 应用格式快捷键（与 CodeMirror 版逐一对齐，含 `Mod-\`） */
function bindKeybindings(instance: MonacoApi.editor.IStandaloneCodeEditor): void {
  const bind = (key: number, run: () => void): void => {
    instance.addCommand(key, () => {
      if (isEffectivelyReadOnly()) return
      run()
    })
  }
  bind(monaco!.KeyMod.CtrlCmd | monaco!.KeyCode.KeyB, () => wrapSelection('**', '**'))
  bind(monaco!.KeyMod.CtrlCmd | monaco!.KeyCode.KeyI, () => wrapSelection('*', '*'))
  bind(monaco!.KeyMod.CtrlCmd | monaco!.KeyCode.KeyE, () => wrapSelection('`', '`', '代码'))
  bind(monaco!.KeyMod.CtrlCmd | monaco!.KeyMod.Shift | monaco!.KeyCode.KeyX, () =>
    wrapSelection('~~', '~~')
  )
  bind(monaco!.KeyMod.CtrlCmd | monaco!.KeyMod.Shift | monaco!.KeyCode.Digit7, () =>
    setLinePrefix('1. ')
  )
  bind(monaco!.KeyMod.CtrlCmd | monaco!.KeyMod.Shift | monaco!.KeyCode.Digit8, () =>
    setLinePrefix('- ')
  )
  bind(monaco!.KeyMod.Alt | monaco!.KeyMod.CtrlCmd | monaco!.KeyCode.KeyT, () =>
    setLinePrefix('- [ ] ')
  )
  bind(monaco!.KeyMod.Alt | monaco!.KeyMod.CtrlCmd | monaco!.KeyCode.KeyU, () =>
    setLinePrefix('> ')
  )
  bind(monaco!.KeyMod.Alt | monaco!.KeyMod.CtrlCmd | monaco!.KeyCode.KeyS, () =>
    insertTextAt('\n---\n')
  )
  for (let level = 1; level <= 6; level += 1) {
    const keyCode = monaco!.KeyCode.Digit1 + (level - 1)
    bind(monaco!.KeyMod.Alt | monaco!.KeyMod.CtrlCmd | keyCode, () =>
      setLinePrefix(`${'#'.repeat(level)} `)
    )
  }
  bind(monaco!.KeyMod.Alt | monaco!.KeyMod.CtrlCmd | monaco!.KeyCode.Digit0, () =>
    setLinePrefix('')
  )
  // `Mod-\` 不在 Monaco 默认键位表里，直接在 DOM 层兜（保 readOnly 语义）
  instance.onKeyDown((event) => {
    const isMod = event.metaKey || event.ctrlKey
    if (!isMod || event.browserEvent.key !== '\\') return
    if (clearLineStyles()) event.preventDefault()
  })
}

function handlePaste(event: ClipboardEvent): void {
  const image = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .find((item): item is File => Boolean(item))
  if (!image) return
  event.preventDefault()
  emit('pasteImage', image, selectionEnd())
}

onMounted(async () => {
  const current = host.value
  if (!current) return
  try {
    monaco = await loadMonaco()
  } catch (cause) {
    // 懒加载失败（依赖预构建 hash 过期 / chunk 404 / 断网）以前会变成
    // 「Unhandled error during execution of mounted hook」+ 未处理的 promise，
    // 界面上什么都不说。这里落成可见的错误态 + 重试入口。
    mountError.value = loadFailureMessage(cause)
    return
  }
  if (disposing || !host.value) return
  createEditor(current)
})

/** 用已经加载好的 Monaco 建编辑器（首次挂载与失败重试共用）。 */
function createEditor(current: HTMLElement): void {
  if (disposing || !monaco || editor) return
  syncing = true
  editor = monaco.editor.create(current, {
    ...readOnlyEditorOptions(),
    value: props.content,
    language: 'markdown',
    theme: monacoThemeName(),
    wordWrap: props.pageWidth === 'wide' ? 'off' : 'on',
    wordBasedSuggestions: 'currentDocument',
    links: true,
    readOnly: isEffectivelyReadOnly(),
    domReadOnly: isEffectivelyReadOnly(),
    fontFamily: cssFontMono()
  })
  syncing = false
  bindKeybindings(editor)
  editor.onDidChangeModelContent(() => {
    if (syncing) return
    const textModel = model()
    if (textModel) emit('change', textModel.getValue())
  })

  pasteListener = handlePaste
  editor.getContainerDomNode().addEventListener('paste', pasteListener, true)
  window.addEventListener(DESK_SELECT_ALL_EVENT, selectAll)

  appearanceObserver = new MutationObserver(async (changes) => {
    if (!changes.some((change) => change.attributeName === 'data-theme')) return
    const api = monaco ?? (await loadMonaco())
    refreshMonacoTheme(api)
  })
  appearanceObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  })
  resizeObserver = new ResizeObserver(() => {
    if (props.active) editor?.layout()
  })
  resizeObserver.observe(current)
}

function cssFontMono(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
  return value || 'ui-monospace, SFMono-Regular, Menlo, monospace'
}

watch(
  () => props.content,
  (content) => {
    const textModel = model()
    if (!textModel || content === textModel.getValue()) return
    const selection = editor?.getSelection()
    const scrollTop = editor?.getScrollTop() ?? 0
    syncing = true
    textModel.setValue(content)
    syncing = false
    if (selection && editor) {
      const nextSelection = clampSelection(selection)
      editor.setSelection(nextSelection)
      editor.setScrollTop(scrollTop)
    }
  }
)

/** 外部内容变短时把旧选区收进新文档，避免越界 */
function clampSelection(selection: MonacoApi.Selection): MonacoApi.Selection {
  const textModel = model()
  if (!textModel) return selection
  const maxOffset = textModel.getValueLength()
  const from = Math.min(offsetOf(selection.getStartPosition()), maxOffset)
  const to = Math.min(offsetOf(selection.getEndPosition()), maxOffset)
  const range = rangeOf(from, to)
  return new monaco!.Selection(
    range.startLineNumber,
    range.startColumn,
    range.endLineNumber,
    range.endColumn
  )
}

watch(
  () => [props.mode, props.readOnly] as const,
  () => {
    const readOnly = isEffectivelyReadOnly()
    editor?.updateOptions({ readOnly, domReadOnly: readOnly })
  }
)

watch(
  () => props.pageWidth,
  (pageWidth) => {
    editor?.updateOptions({ wordWrap: pageWidth === 'wide' ? 'off' : 'on' })
    void nextTick(() => editor?.layout())
  }
)

watch(
  () => props.active,
  (active) => {
    if (active) void nextTick(() => requestAnimationFrame(() => editor?.layout()))
  }
)

onBeforeUnmount(() => {
  disposing = true
  window.removeEventListener(DESK_SELECT_ALL_EVENT, selectAll)
  if (pasteListener && editor) {
    editor.getContainerDomNode().removeEventListener('paste', pasteListener, true)
  }
  pasteListener = null
  appearanceObserver?.disconnect()
  appearanceObserver = null
  resizeObserver?.disconnect()
  resizeObserver = null
  editor?.dispose()
  editor = null
})
</script>

<template>
  <div class="markdown-source-host">
    <div
      ref="host"
      class="markdown-source-editor"
      :class="{ 'is-wide': pageWidth === 'wide' }"
      data-testid="markdown-source-editor"
    />
    <div v-if="mountError" class="markdown-source-error" role="alert">
      <p>{{ mountError }}</p>
      <div class="markdown-source-error__actions">
        <button type="button" @click="retryMount">重试</button>
        <button type="button" @click="reloadWindow">重新加载窗口</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.markdown-source-host {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.markdown-source-editor {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--editor-bg);
  color: var(--editor-text);
}

/* 懒加载失败（多为页面里的模块地址过期）：给出原因与恢复入口，而不是静默空白 */
.markdown-source-error {
  position: absolute;
  inset: 0;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  background: var(--editor-bg);
  color: var(--muted);
  font: 13px/1.7 var(--font-sans);
}

.markdown-source-error p {
  margin: 0;
  max-width: 48ch;
}

.markdown-source-error__actions {
  display: flex;
  gap: 8px;
}

.markdown-source-error__actions button {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

.markdown-source-error__actions button:hover {
  background: var(--hover);
}

/* 标准页宽：编辑器整体居中收窄（Monaco 的行号与内容一起居中，视觉与旧版一致） */
.markdown-source-editor :deep(.monaco-editor) {
  max-width: 940px;
  margin-inline: auto;
}

.markdown-source-editor.is-wide :deep(.monaco-editor) {
  max-width: none;
}

/*
 * 让行号槽与正文层跟着容器背景走（Monaco 主题背景与容器同为 `--editor-bg`，视觉一致）。
 *
 * `:not(.cslr)` 是必须的：Monaco 画选区圆角时会先向左多画 10px 的选区色块，再用
 * **带 `monaco-editor-background` 类的遮罩**（`.cslr.monaco-editor-background`，反圆角）
 * 盖掉多余部分。遮罩被写成 `background: inherit` 就变成透明，那 10px 蓝块原样露出来 ——
 * 反向跨行选择时会盖住选区起点左侧本来没选中的字（实测：遮罩计算值 rgba(0,0,0,0)，
 * 采样像素 rgb(173,214,255)，与选区色相同）。遮罩必须保留主题背景色。
 */
.markdown-source-editor :deep(.monaco-editor .margin),
.markdown-source-editor :deep(.monaco-editor .monaco-editor-background:not(.cslr)) {
  background: inherit;
}
</style>
