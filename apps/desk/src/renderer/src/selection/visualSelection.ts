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
import type { EditorSelectionPayload } from './selectionReporter'

/** 代码块/代码组面板内部的 CodeMirror 选区（由组件从 DOM 找到后传进来） */
export interface CodeMirrorCapture {
  text: string
  /** CM 里的选区数量（>1 = 多光标，首版不支持） */
  ranges: number
  /** 所在块的文档位置（找不到时为 null） */
  blockPosition: number | null
}

export interface VisualSelectionDeps {
  /** 把文档（或片段）序列化成 Markdown —— 用编辑器自己的 serializer */
  serializeDocument: (document: ProseMirrorNode) => string
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

function payloadFromBlocks(
  view: EditorView,
  blocks: { pos: number; node: ProseMirrorNode }[],
  deps: VisualSelectionDeps,
  selectedText: string
): EditorSelectionPayload {
  return {
    empty: false,
    selectedText,
    blocks: blocks.map(({ pos, node }) => {
      const { markdown, source } = blockMarkdown(view, pos, node, deps)
      return { kind: visualBlockKind(node), markdown, source }
    })
  }
}

/** 采集可视化视图的当前选区（无选区返回 empty，不抛异常） */
export function captureVisualSelection(
  view: EditorView,
  deps: VisualSelectionDeps
): EditorSelectionPayload {
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
    return {
      empty: false,
      selectedText: cm.text,
      blocks:
        node && cm.blockPosition != null
          ? [
              {
                kind: visualBlockKind(node),
                // 代码编辑器里的选区坐标是 CM 自己的，映射不到源码 → 只给块级上下文
                markdown: blockMarkdown(view, cm.blockPosition, node, deps).markdown,
                // raw block 的源码是逐字原文，普通代码块是序列化结果
                source: node.type.name === 'deskRawBlock' ? 'raw' : 'reserialized'
              }
            ]
          : []
    }
  }

  const selection = view.state.selection

  // 2) 整块节点选中态（特殊组件）
  if (selection instanceof NodeSelection) {
    const node = selection.node
    return payloadFromBlocks(view, [{ pos: selection.from, node }], deps, node.textContent || '')
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
  return payloadFromBlocks(view, blocks, deps, selectedText)
}
