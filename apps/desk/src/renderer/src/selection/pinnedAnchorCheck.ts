/**
 * 固定上下文锚点的校验（纯函数，便于单测）。
 *
 * 两条判据分开，别混：
 * 1. **位置判据（`validateTextAnchor`）**：给"文档文本 + 位置锚"，检查同一偏移范围上
 *    还是不是同一段文字。跨视图、磁盘复核都用它 —— 只认位置，不做全文搜索，
 *    所以"A 前插入内容导致坐标变化""原 A 被删除、别处还有相同文字"都会失效，
 *    而"只改 A 后方"不会。
 * 2. **可视化判据（`validateVisualAnchor`）**：当前视图就是可视化时，用编辑器模型里的
 *    位置与**选区文本**核对（PM 位置 + `textBetween`），只有整块选中（NodeSelection）
 *    才逐字比较块源码 —— 这样同一段落里选区**后方**的修改不会误伤固定。
 */
import { blockAnchorFor } from './visualSelection'

import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { PinnedSelectionAnchor } from '../../../shared/contracts'
import type { VisualSelectionDeps } from './visualSelection'

/** 校验时需要的额外能力（由编辑器组件注入，纯函数里不直接碰 CodeMirror） */
export interface AnchorCheckDeps extends VisualSelectionDeps {
  /** 取某个块里代码编辑器当前的文档文本（拿不到就返回 null） */
  codeText?: (pos: number, node: ProseMirrorNode) => string | null
}

export interface AnchorCheck {
  valid: boolean
  reason?: string
}

/**
 * 位置判据：**每一个**位置范围上都还是不是同一段文字。
 *
 * **不做全文搜索**：所以"A 前插入内容 → 坐标变化"会失效，"原 A 被删除、别处还有相同文字"
 * 也会失效；"只改 A 后方（选区之外）"不会。
 *
 * 跨段落固定会带来多个范围：任何一段变了都要失效。
 */
export function validateTextAnchor(
  text: string,
  anchor: PinnedSelectionAnchor
): AnchorCheck | null {
  const ranges = [...(anchor.ranges ?? []), ...(anchor.textRange ? [anchor.textRange] : [])].filter(
    (range) => range.endOffset > range.startOffset
  )
  if (ranges.length === 0) return null
  for (const range of ranges) {
    const current = text.slice(range.startOffset, range.endOffset)
    if (current !== range.expected) {
      return {
        valid: false,
        reason: `固定的位置（偏移 ${range.startOffset}–${range.endOffset}）上已经不是原来那段内容（内容或坐标变了）`
      }
    }
  }
  return { valid: true }
}

/**
 * 可视化判据：位置 + 类型 + **选区文本**。
 *
 * - 只有整块选中（NodeSelection）才逐字比较块源码（那是"整块组件"的语义）；
 * - 其余情况比 `textBetween(from, to)`：同一段落里选区后方的修改不影响它，
 *   而选区内部的修改、或在前方插入内容导致位置变化，都会让它对不上。
 */
export function validateVisualAnchor(
  view: EditorView,
  anchor: PinnedSelectionAnchor,
  expected: string,
  deps: AnchorCheckDeps
): AnchorCheck | null {
  if (!view.state || anchor.kind !== 'block') return null
  const blocks = anchor.blocks ?? []
  if (blocks.length === 0) return null

  // 1) 位置与类型：块必须还在原来的位置上（坐标变化直接失效）
  for (const [index, block] of blocks.entries()) {
    const node = view.state.doc.nodeAt(block.pos)
    if (!node) {
      return {
        valid: false,
        reason: `固定的第 ${index + 1} 个相关块已经不在原来的位置了（坐标变了）`
      }
    }
    const kindNow = blockAnchorFor(view, block.pos, node, deps).kind
    if (kindNow !== block.kind) {
      return { valid: false, reason: `固定的第 ${index + 1} 个相关块类型变了` }
    }
  }

  // 2) 代码块 / 代码组面板内部：用 CodeMirror 自己的坐标（不映射、不搜索）
  const first = blocks[0]!
  const firstNode = view.state.doc.nodeAt(first.pos) as ProseMirrorNode
  if (anchor.code) {
    const doc = deps.codeText?.(first.pos, firstNode) ?? null
    if (doc == null) return null
    const current = doc.slice(anchor.code.from, anchor.code.to)
    if (current !== (anchor.code.expected ?? expected)) {
      return {
        valid: false,
        reason: '代码块里固定时选中的内容已经不在原来的位置上了（内容或坐标变了）'
      }
    }
    return { valid: true }
  }

  // 3) 整块选中（特殊组件）：逐字比较块源码
  if (anchor.nodeSelection) {
    const markdownNow = blockAnchorFor(view, first.pos, firstNode, deps).markdown
    if (markdownNow !== first.markdown) {
      return { valid: false, reason: '固定的整块组件源码已变化' }
    }
    return { valid: true }
  }

  // 4) 普通文本选区：比选区文本（同段落里选区**后方**的修改不影响它）
  if (anchor.from == null || anchor.to == null) return null
  const size = view.state.doc.content.size
  const from = Math.max(0, Math.min(anchor.from, size))
  const to = Math.max(from, Math.min(anchor.to, size))
  const rangeText = view.state.doc.textBetween(from, to, '\n', '\n')
  if (rangeText !== expected) {
    return { valid: false, reason: '固定时选中的文字已经不在原来的位置上了（内容或坐标变了）' }
  }
  return { valid: true }
}
