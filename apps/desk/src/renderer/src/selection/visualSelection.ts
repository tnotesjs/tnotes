/**
 * 可视化视图的选区采集（编辑器状态为准）。
 *
 * 判据顺序（都不依赖 `window.getSelection().toString()`）：
 * 1. **代码块 / 代码组面板里的 CodeMirror 选区**：从 DOM 找到 CM 实例，读它自己的
 *    `state.selection`（CM 的坐标是 CM 自己的，映射不到源码 → 只给块级上下文）；
 * 2. **整块节点选中态**（ProseMirror `NodeSelection`）：特殊组件走这里 —— 能可靠定位就给出
 *    类型 + **完整组件源码**（`deskRawBlock.attrs.source` 是逐字原文，标 `raw`）；
 * 3. **普通文本选区**（含跨段落）：文字取自文档，相关块用序列化器产出并标 `reserialized`。
 *
 * 明确不做：不承诺任意图形内部节点的精确源码映射；映射不到就只给块级上下文（`mapping: 'block'`），
 * 绝不拼凑坐标。多个不连续选区（CM 多光标）明确返回不支持。
 */
import { NodeSelection } from '@milkdown/kit/prose/state'

import { serializeBlockForClipboard } from '../markdown/blockActionMenu'

import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { PinnedBlockAnchor, PinnedTextAnchor } from '../../../shared/contracts'
import type { EditorSelectionPayload } from './selectionReporter'

/** 代码块/代码组面板内部的 CodeMirror 选区（由组件从 DOM 找到后传进来） */
export interface CodeMirrorCapture {
  text: string
  /** CM 里的选区数量（>1 = 多光标，首版不支持） */
  ranges: number
  /** 所在块的文档位置（找不到时为 null） */
  blockPosition: number | null
  /** CM 自己的选区坐标（校验时按它比对，不映射成源码坐标） */
  from: number
  to: number
}

export interface VisualSelectionDeps {
  /** 把文档（或片段）序列化成 Markdown —— 用编辑器自己的 serializer */
  serializeDocument: (document: ProseMirrorNode) => string
  /**
   * 这篇笔记**源码文本**（可视化编辑器就是用它建出来的；未编辑块与磁盘字节一致）。
   * 位置锚必须落在这份文本的坐标系里 —— 跨视图与磁盘复核读的也是它。
   */
  sourceText?: string
  /** 代码编辑器里的选区（没有焦点在 CM 里时返回 null） */
  codeMirror?: () => CodeMirrorCapture | null
}

/**
 * raw block 的细分类型：容器取 `::: xxx` 的名字（code-group / swiper / tip…），
 * 围栏取语言（mindmap / mermaid / js…）。粗分类（`raw-container` / `raw-diagram`）对
 * Agent 没什么用，它要知道"这是代码组"还是"这是思维导图"。
 */
export function rawBlockSubtype(source: string): string | null {
  const trimmed = source.trimStart()
  const container = /^:{3,}\s*([A-Za-z][\w-]*)/.exec(trimmed)
  if (container?.[1]) return container[1].toLowerCase()
  const fence = /^(?:`{3,}|~{3,})\s*([A-Za-z][\w+#.-]*)/.exec(trimmed)
  if (fence?.[1]) return fence[1].toLowerCase()
  return null
}

/** 块类型名（给 Agent 看的粗分类；raw block 带上可识别的细分类型） */
export function visualBlockKind(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case 'paragraph':
      return node.childCount > 0 && node.child(0).type.name === 'image' ? 'image' : 'paragraph'
    case 'heading':
      return `heading:${String(node.attrs.level ?? '')}`
    case 'code_block':
      return 'code'
    case 'table':
      return 'table'
    case 'blockquote':
      return 'blockquote'
    case 'bullet_list':
    case 'ordered_list':
      return 'list'
    case 'deskCallout':
      return 'container:callout'
    case 'deskRawBlock': {
      const subtype = rawBlockSubtype(String(node.attrs.source ?? ''))
      return `raw-block:${subtype ?? String(node.attrs.kind ?? '')}`
    }
    default:
      return node.type.name
  }
}

/**
 * 块 Markdown：raw block 用逐字原文（`raw`），其余用序列化结果（`reserialized`）。
 * 复用块菜单的 `serializeBlockForClipboard`：它已经处理好列表项（不能直接序列化到文档根）
 * 与折叠章节。
 */
function blockMarkdown(
  view: EditorView,
  position: number,
  node: ProseMirrorNode,
  deps: VisualSelectionDeps
): { markdown: string; source: 'raw' | 'reserialized' } {
  if (node.type.name === 'deskRawBlock') {
    return { markdown: String(node.attrs.source ?? ''), source: 'raw' }
  }
  const markdown = serializeBlockForClipboard(view.state, position, deps.serializeDocument)
  return { markdown: markdown ?? '', source: 'reserialized' }
}

/**
 * 单个块的锚点：位置 + 类型 + Markdown（raw 块是逐字原文）。
 *
 * 固定上下文（以及它的校验）用它做"内容或坐标是否变了"的判据 ——
 * 这是可视化视图里可靠的位置与内容信息，不是伪造的源码坐标。
 */
export function blockAnchorFor(
  view: EditorView,
  pos: number,
  node: ProseMirrorNode,
  deps: VisualSelectionDeps
): PinnedBlockAnchor {
  return {
    pos,
    kind: visualBlockKind(node),
    markdown: blockMarkdown(view, pos, node, deps).markdown
  }
}

/** 与 [from, to] 相交的文档级块 */
function blocksIntersecting(
  view: EditorView,
  from: number,
  to: number
): { pos: number; node: ProseMirrorNode }[] {
  const blocks: { pos: number; node: ProseMirrorNode }[] = []
  view.state.doc.forEach((node, offset) => {
    const end = offset + node.nodeSize
    if (from <= end && to >= offset) blocks.push({ pos: offset, node })
  })
  return blocks
}

/**
 * 位置锚（可视化）：把**选区**投影成笔记源码文本里的若干范围。
 *
 * 为什么按块逐段：可视化视图的可靠信息是"块的位置 + 块文本 + 选区的纯文本偏移"，
 * 而源码文本里既有块间分隔符、也可能有行内标记，纯文本偏移不等于源码偏移。
 * 做法是从上到下**顺序**定位每个涉及的块（下一块只从上一块结束处往后找），
 * 再在每个块里定位选区那一段 —— 是"按结构顺序的位置推导"，不是全文搜索：
 * - 任何一块移动 / 内容变化 → 对应范围对不上 → 失效（跨段落时每一段都覆盖）；
 * - 同一块里**选区之外**的改动（例如只固定 AAA，后面 BBB 改成 CCC）→ 该范围不变 → 保留。
 *
 * 定位不出来（块文本在源码里对不上）就返回 null：调用方据此**拒绝固定**，
 * 而不是固定一份只能靠搜索猜位置的上下文。
 */
function sourceRangesForSelection(
  view: EditorView,
  blocks: { pos: number; node: ProseMirrorNode }[],
  deps: VisualSelectionDeps,
  range: { from: number; to: number },
  code?: { from: number; to: number; expected: string }
): PinnedTextAnchor[] | null {
  const text = deps.sourceText
  if (!text) return null
  const located: { start: number; end: number; markdown: string }[] = []
  let cursor = 0
  for (const { pos, node } of blocks) {
    const markdown = blockMarkdown(view, pos, node, deps).markdown
    if (!markdown) return null
    const at = text.indexOf(markdown, cursor)
    if (at < 0) return null
    located.push({ start: at, end: at + markdown.length, markdown })
    cursor = at + markdown.length
  }

  const ranges: PinnedTextAnchor[] = []
  for (const [index] of located.entries()) {
    const { pos, node } = blocks[index]!
    const block = located[index]!
    // 该块里被选中的那一段纯文本（首块可能只选中前半段，末块只选中后半段）
    const innerStart = index === 0 ? Math.max(0, range.from - (pos + 1)) : 0
    const innerEnd =
      index === located.length - 1
        ? Math.min(node.nodeSize - 1, Math.max(innerStart, range.to - (pos + 1)))
        : node.nodeSize - 1
    // 代码块 / 代码组面板内部：选区是 CodeMirror 自己的坐标，直接用它的选中文字
    const plain =
      code && blocks.length === 1
        ? code.expected
        : view.state.doc.textBetween(pos + 1 + innerStart, pos + 1 + innerEnd, '\n', '\n')
    if (!plain) continue
    // 在**这个块**的源码里定位这一段（从纯文本偏移附近起找，容忍行内标记带来的位移）
    let inner = block.markdown.indexOf(plain, code ? 0 : Math.max(0, innerStart))
    if (inner < 0) inner = block.markdown.indexOf(plain)
    if (inner < 0) return null
    const startOffset = block.start + inner
    const expected = text.slice(startOffset, startOffset + plain.length)
    if (!expected) return null
    ranges.push({ startOffset, endOffset: startOffset + plain.length, expected })
  }
  return ranges.length > 0 ? ranges : null
}

function payloadFromBlocks(
  view: EditorView,
  blocks: { pos: number; node: ProseMirrorNode }[],
  deps: VisualSelectionDeps,
  selectedText: string,
  range: { from: number; to: number; nodeSelection?: boolean },
  code?: { from: number; to: number; expected: string }
): EditorSelectionPayload {
  const blockAnchors = blocks.map(({ pos, node }) => blockAnchorFor(view, pos, node, deps))
  const ranges = sourceRangesForSelection(view, blocks, deps, range, code)
  return {
    empty: false,
    selectedText,
    blocks: blocks.map(({ pos, node }) => {
      const { markdown, source } = blockMarkdown(view, pos, node, deps)
      return { kind: visualBlockKind(node), markdown, source }
    }),
    // 校验锚点：位置（PM 位置 + 序列化偏移）+ 内容（块 Markdown / 代码编辑器坐标），
    // 不伪造源码坐标
    anchor: {
      view: 'visual',
      kind: 'block',
      ...(ranges ? { ranges } : {}),
      blocks: blockAnchors,
      from: range.from,
      to: range.to,
      ...(range.nodeSelection ? { nodeSelection: true } : {}),
      ...(code ? { code } : {})
    }
  }
}

/** 采集可视化视图的当前选区（无选区返回 empty，不抛异常） */
export function captureVisualSelection(
  view: EditorView,
  deps: VisualSelectionDeps
): EditorSelectionPayload {
  // 编辑器正在创建 / 销毁（切笔记、切视图的瞬间）时 `state` 可能已经没了：
  // 这不是"用户没选东西"，但也不能去读一个死掉的视图 —— 当作没有选区处理。
  if (!view.state) return { empty: true, selectedText: '', blocks: [] }

  // 1) 代码块 / 代码组面板里的 CodeMirror 选区
  const cm = deps.codeMirror?.() ?? null
  if (cm && cm.text.length > 0) {
    if (cm.ranges > 1) {
      return {
        empty: false,
        selectedText: '',
        blocks: [],
        unsupportedReason: `首版不支持多个不连续选区（代码编辑器里有 ${cm.ranges} 处）`
      }
    }
    const node = cm.blockPosition == null ? null : view.state.doc.nodeAt(cm.blockPosition)
    if (!node || cm.blockPosition == null) {
      return { empty: false, selectedText: cm.text, blocks: [] }
    }
    return payloadFromBlocks(
      view,
      [{ pos: cm.blockPosition, node }],
      deps,
      cm.text,
      // 代码编辑器里的选区坐标是 CM 自己的：恢复选区时用整块范围
      { from: cm.blockPosition, to: cm.blockPosition + node.nodeSize },
      // 校验用 CM 自己的坐标（同视图内精确；跨视图走块位置锚）
      { from: cm.from, to: cm.to, expected: cm.text }
    )
  }

  const selection = view.state.selection

  // 2) 整块节点选中态（特殊组件）
  if (selection instanceof NodeSelection) {
    const node = selection.node
    return payloadFromBlocks(view, [{ pos: selection.from, node }], deps, node.textContent || '', {
      from: selection.from,
      to: selection.from + node.nodeSize,
      nodeSelection: true
    })
  }

  // 3) 普通文本选区（含跨段落）
  if (selection.empty) return { empty: true, selectedText: '', blocks: [] }
  const from = selection.from
  const to = selection.to
  const selectedText = view.state.doc.textBetween(from, to, '\n', '\n')
  const blocks = blocksIntersecting(view, from, to)
  if (blocks.length === 0) {
    // 选到了块之间（例如 gap cursor 一类）：不编造坐标
    return {
      empty: false,
      selectedText,
      blocks: [],
      unsupportedReason: '选区没有落在可识别的块上（首版只给块级上下文）'
    }
  }
  return payloadFromBlocks(view, blocks, deps, selectedText, { from, to })
}
