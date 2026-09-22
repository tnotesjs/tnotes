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

import { nthFenceBodyRange, scanSourceBlocks } from './sourceBlocks'

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
  /**
   * 该 CM 在所属 raw block 里的**面板序号**（按 DOM 结构数，不用文字匹配）。
   * 代码组面板的正文坐标要落回源码，就只能靠这个序号去数第几个围栏。
   */
  panelIndex?: number
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
 * 焦点被命令面板 / 右键菜单抢走时，还敢不敢用"最后一次有非空选区的 CM"：
 * 只有当前选区**确实落在它那个块里**时才认 —— 否则上一次的代码选区会把段落选区盖掉。
 */
export function selectionCoversBlock(
  selection: { from: number; to: number } | null | undefined,
  block: { position: number | null; size: number }
): boolean {
  if (!selection || block.position == null) return false
  return selection.from >= block.position && selection.to <= block.position + block.size
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
 * 位置锚（可视化）：把**选区**落回笔记源码文本里的若干范围。
 *
 * 关键：**块身份由结构决定，不由文字决定**。
 * - 先用 `scanSourceBlocks` 把源码切成顶层块（带偏移），再把**可视化文档的顶层节点按序号**
 *   一一对上；序号对不上（结构不一致）就返回 null —— 调用方据此**拒绝固定**；
 * - 所以"两个一模一样的段落，选中第二个"不会指到第一段：它按序号取第 2 个源码块；
 * - 块内再把选区那一段落回源码：
 *   - 普通块：用 PM 的**块内纯文本偏移**作为搜索起点（行内标记只会让源码偏移更大），
 *     在这个块自己的源码里找那一段；
 *   - 普通代码块：源码里"第一个围栏的正文" + CodeMirror 自己的 `from`；
 *   - 代码组面板：源码里"**第 panelIndex 个**围栏的正文" + CodeMirror 自己的 `from`
 *     （按结构数围栏，所以不同面板里的同样代码也不会串）。
 * - 任何一步对不上（结构不一致、文字对不上）都返回 null：宁可拒绝固定，
 *   也不生成一个"看起来有效、其实指错位置"的范围。
 */
function sourceRangesForSelection(
  view: EditorView,
  blocks: { pos: number; node: ProseMirrorNode }[],
  deps: VisualSelectionDeps,
  range: { from: number; to: number },
  code?: CodeMirrorCapture
): PinnedTextAnchor[] | null {
  const text = deps.sourceText
  if (!text) return null

  // 1) 顶层结构：可视化文档节点 ↔ 源码块，按**序号**对应
  const topLevel: { pos: number; node: ProseMirrorNode }[] = []
  view.state.doc.forEach((node, pos) => {
    // 空文本块在源码扫描里也会被跳过（空行），两边口径要一致
    if (node.isTextblock && node.content.size === 0) return
    topLevel.push({ pos, node })
  })
  const sourceBlocks = scanSourceBlocks(text)
  if (topLevel.length !== sourceBlocks.length) return null
  const sourceIndexOf = new Map<number, number>()
  topLevel.forEach((item, index) => sourceIndexOf.set(item.pos, index))

  const ranges: PinnedTextAnchor[] = []
  for (const [blockIndex, block] of blocks.entries()) {
    const sourceIndex = sourceIndexOf.get(block.pos)
    if (sourceIndex == null) return null
    const source = sourceBlocks[sourceIndex]
    if (!source) return null
    const markdown = blockMarkdown(view, block.pos, block.node, deps).markdown
    // 块身份一致性：这一段源码必须就是这个块（对不上就拒绝，不靠搜索兜底）。
    // 代码编辑器选区另有更强的身份证据：结构化围栏正文里的那一段必须逐字等于 CM 的选区，
    // 所以只在没有 `code` 时才做这层整块比较（片段的序列化形态可能与源码不同）。
    if (!code && markdown.trim() && source.markdown.trim() !== markdown.trim()) return null

    const isFirst = blockIndex === 0
    const isLast = blockIndex === blocks.length - 1
    const innerStart = isFirst ? Math.max(0, range.from - (block.pos + 1)) : 0
    const innerEnd = isLast
      ? Math.min(block.node.nodeSize - 1, Math.max(innerStart, range.to - (block.pos + 1)))
      : block.node.nodeSize - 1

    let inner: { start: number; length: number } | null = null
    if (code && blocks.length === 1) {
      // 代码编辑器：用 CM 自己的坐标 + 结构化的围栏序号
      const body =
        code.panelIndex == null
          ? (() => {
              const newline = source.markdown.indexOf('\n')
              return newline < 0
                ? null
                : { startOffset: newline + 1, endOffset: source.markdown.length }
            })()
          : nthFenceBodyRange(source.markdown, code.panelIndex)
      if (!body) return null
      const bodyText = source.markdown.slice(body.startOffset, body.endOffset)
      if (bodyText.slice(code.from, code.to) !== code.text) return null
      inner = { start: body.startOffset + code.from, length: code.text.length }
    } else {
      const plain = view.state.doc.textBetween(
        block.pos + 1 + innerStart,
        block.pos + 1 + innerEnd,
        '\n',
        '\n'
      )
      if (!plain) continue
      // 块内定位：从"纯文本偏移"起找（行内标记只会让源码偏移更大，所以起点不会越过正确位置）
      const at = source.markdown.indexOf(plain, innerStart)
      if (at < 0) return null
      inner = { start: at, length: plain.length }
    }

    const startOffset = source.startOffset + inner.start
    const expected = text.slice(startOffset, startOffset + inner.length)
    if (!expected) return null
    ranges.push({ startOffset, endOffset: startOffset + inner.length, expected })
  }
  return ranges.length > 0 ? ranges : null
}

function payloadFromBlocks(
  view: EditorView,
  blocks: { pos: number; node: ProseMirrorNode }[],
  deps: VisualSelectionDeps,
  selectedText: string,
  range: { from: number; to: number; nodeSelection?: boolean },
  code?: CodeMirrorCapture
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
      // 校验用 CM 自己的坐标（同视图内精确；跨视图按结构化围栏序号落回源码）
      cm
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
