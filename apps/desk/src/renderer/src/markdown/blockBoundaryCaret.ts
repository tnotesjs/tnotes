/**
 * 块边界光标（块前 / 块后）。
 *
 * 「整个块不可直接放光标」的位置一共有两个：块的紧前面、块的紧后面。浏览器和
 * ProseMirror 都放不了普通光标：位置的一侧是普通段落（有合法文本位置），
 * ProseMirror 官方的 `GapCursor` 也不行 —— `GapCursor.valid()` 要求两侧都「closed」，
 * 而我们的位置永远不满足（`closedBefore` 见到段落就 false）。
 *
 * 所以这里自研一个 `Selection` 子类：
 * - `visible = false` → PM 会加 `ProseMirror-hideselection`，原生光标隐藏；
 *   同时 `prosemirror-virtual-cursor` 只为「空 TextSelection」画光标，也不会画；
 * - 可见光标由我们自己的 DOM 元素画（挂在目标块上绝对定位，不占行、不改文档）；
 * - 纯导航不产生任何事务；只有「在边界上打字 / 回车」才实体化空段落
 *   （见 `blockBoundaryNavigation.ts`）。
 */
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { Node as ProseMirrorNode, ResolvedPos } from '@milkdown/kit/prose/model'
import { Selection, Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { Slice } from '@milkdown/kit/prose/model'
import { isDeskCalloutNode } from '../editor/markdown/deskCallout'
import { isStandaloneImageParagraph } from '../editor/markdown/standaloneImageParagraph'

export type BlockBoundarySide = 'before' | 'after'

export const blockBoundaryCaretKey = new PluginKey('desk-block-boundary-caret')

/** 自带光标的类名（CSS 在 milkdownMarkdownEditor.scoped.css）。 */
export const BOUNDARY_CARET_CLASS = 'desk-block-boundary-caret'
export const BOUNDARY_CARET_LAYER_CLASS = 'desk-block-boundary-caret-layer'

export class BlockBoundaryCaret extends Selection {
  /**
   * 贴着哪一侧。位置相同但侧别不同是两种状态（表格块后 = 紧跟其后的块块前），
   * 所以侧别必须存下来，不能从位置猜。
   */
  constructor(
    $pos: ResolvedPos,
    readonly side: BlockBoundarySide
  ) {
    super($pos, $pos)
  }

  map(doc: ProseMirrorNode, mapping: Transaction['mapping']): Selection {
    const pos = mapping.map(this.head)
    if (pos < 0 || pos > doc.content.size) return Selection.near(doc.resolve(0))
    const $pos = doc.resolve(pos)
    return blockBoundaryTargetAt(doc, pos, this.side, isBoundaryDeleteBlock)
      ? new BlockBoundaryCaret($pos, this.side)
      : Selection.near($pos)
  }

  content(): Slice {
    return Slice.empty
  }

  eq(other: Selection): boolean {
    return (
      other instanceof BlockBoundaryCaret && other.head === this.head && other.side === this.side
    )
  }

  toJSON(): { type: string; pos: number; side: BlockBoundarySide } {
    return { type: 'deskBlockBoundaryCaret', pos: this.head, side: this.side }
  }

  static fromJSON(
    doc: ProseMirrorNode,
    json: { pos?: unknown; side?: unknown }
  ): BlockBoundaryCaret {
    if (typeof json.pos !== 'number') throw new RangeError('Invalid BlockBoundaryCaret JSON')
    return new BlockBoundaryCaret(doc.resolve(json.pos), json.side === 'after' ? 'after' : 'before')
  }
}

/** 隐藏原生选区，光标全部由我们画。 */
BlockBoundaryCaret.prototype.visible = false
Selection.jsonID('deskBlockBoundaryCaret', BlockBoundaryCaret)

export function isBlockBoundaryCaret(selection: Selection | null | undefined): boolean {
  return selection instanceof BlockBoundaryCaret
}

/**
 * 哪些块两侧有「块前/块后光标」：
 * - 隐藏块（frontmatter、生成目录）不算；
 * - 代码块、表格、非隐藏的 raw block（组件/容器/图表/纯 HTML）算；
 * - callout / 引用 / 列表这些「可直接放光标的文本流」不算。
 */
export function isBoundaryStopBlock(node: ProseMirrorNode | null | undefined): boolean {
  if (!node) return false
  if (node.type.name === 'code_block') return true
  if (node.type.name === 'table') return true
  // 独立成段的图片同样是「整块不可编辑」的元素（行内 atom 包在段落里）。
  if (isStandaloneImageParagraph(node as Parameters<typeof isStandaloneImageParagraph>[0])) {
    return true
  }
  return node.type.name === 'deskRawBlock' && node.attrs.hidden !== true
}

/**
 * Backspace / Delete 在段落边缘要落到的「特殊块」：停靠块之外**再算上提示块家族**
 * （callout / tip / warning 这些容器）。
 *
 * 为什么方向键那套（`isBoundaryStopBlock`）不能直接用：callout 内部的正文是可编辑文本流，
 * 方向键必须能直接进去（`deskCalloutView` 里那套标题 chrome / body 出入口都依赖这一点）。
 * 但「段首 Backspace / 段尾 Delete」落到它上面时，PM 默认的 joinBackward 会把整个 callout
 * 选中成一个不明显的块选中态 —— 验收要求这里也统一成"先落到块边界光标、再按一次才删整块"。
 */
export function isBoundaryDeleteBlock(node: ProseMirrorNode | null | undefined): boolean {
  return isBoundaryStopBlock(node) || isDeskCalloutNode(node as { type: { name: string } })
}

export type BoundaryStopPredicate = (node: ProseMirrorNode | null | undefined) => boolean

export interface BlockBoundaryTarget {
  /** 目标块在父节点里的位置。 */
  blockPos: number
  node: ProseMirrorNode
  side: BlockBoundarySide
}

/** 文档位置 `pos` 是否正好贴在某个可停靠块的前/后。 */
export function boundarySideAt(doc: ProseMirrorNode, pos: number): BlockBoundarySide | null {
  if (pos < 0 || pos > doc.content.size) return null
  const $pos = doc.resolve(pos)
  if (isBoundaryStopBlock($pos.nodeAfter)) return 'before'
  if (isBoundaryStopBlock($pos.nodeBefore)) return 'after'
  return null
}

/**
 * `pos` 处贴着某个可停靠块的边界；`side` 指定时只认那一侧（相邻两个块共用同一个
 * 文档位置时，靠它区分「前一个块的块后」和「后一个块的块前」）。
 */
export function blockBoundaryTargetAt(
  doc: ProseMirrorNode,
  pos: number,
  side?: BlockBoundarySide,
  isStop: BoundaryStopPredicate = isBoundaryStopBlock
): BlockBoundaryTarget | null {
  if (pos < 0 || pos > doc.content.size) return null
  const $pos = doc.resolve(pos)
  for (const candidate of side ? [side] : (['before', 'after'] as const)) {
    const node = candidate === 'before' ? $pos.nodeAfter : $pos.nodeBefore
    if (!node || !isStop(node)) continue
    return {
      blockPos: candidate === 'before' ? pos : pos - node.nodeSize,
      node,
      side: candidate
    }
  }
  return null
}

export function blockBoundaryCaretAt(
  doc: ProseMirrorNode,
  pos: number,
  side?: BlockBoundarySide,
  isStop: BoundaryStopPredicate = isBoundaryStopBlock
): BlockBoundaryCaret | null {
  const target = blockBoundaryTargetAt(doc, pos, side, isStop)
  return target ? new BlockBoundaryCaret(doc.resolve(pos), target.side) : null
}

/**
 * 当前 boundary caret 贴着的块（没有则 null）。
 *
 * 用**宽**集合（含提示块家族）：Backspace / Delete 会把光标停在 callout 边界上，那个状态
 * 必须能渲染出来、也必须能被键位处理认出来。方向键的落点仍由窄集合把关（见
 * `isBoundaryStopBlock` 的调用点），所以这不会让方向键在 callout 上多停一站。
 */
export function activeBlockBoundaryTarget(state: EditorState): BlockBoundaryTarget | null {
  const { selection } = state
  if (!(selection instanceof BlockBoundaryCaret)) return null
  return blockBoundaryTargetAt(state.doc, selection.head, selection.side, isBoundaryDeleteBlock)
}

/* ------------------------------------------------------------------ */
/* 可见光标：画在编辑区外的覆盖层里（不能塞进可编辑 DOM）              */
/* ------------------------------------------------------------------ */

/** 光标与块边缘的间距：整根线落在块外（写在正文容器的左右留白里）。 */
const CARET_GUTTER = 2

interface CaretElement {
  el: HTMLElement
  blockDom: HTMLElement
  side: BlockBoundarySide
}

function createCaretElement(side: BlockBoundarySide): HTMLElement {
  const el = document.createElement('span')
  el.className = `${BOUNDARY_CARET_CLASS} ${BOUNDARY_CARET_CLASS}--${side}`
  el.setAttribute('aria-hidden', 'true')
  el.dataset.side = side
  el.contentEditable = 'false'
  return el
}

/**
 * 光标元素必须挂在 ProseMirror 的**可编辑 DOM 之外**。
 *
 * 早先的实现把 <span> 直接 append 到目标块里：对代码块 / 表格 / raw block 这类
 * 自带 node view 的块没问题，但「独立成段的图片」只是一个普通 paragraph——它的
 * contentDOM 就是 <p> 本身，PM 的 DOMObserver 会把多出来的子节点当成 DOM 变更，
 * `readDOMChange` 于是重读 DOM 并把选区重置回文本光标（光标元素同时被抹掉），
 * 表现就是「按 ↓ 没反应」。
 *
 * 所以改成：块 DOM 上只读它的 getBoundingClientRect，光标画在 .milkdown 下的一层
 * 覆盖层里（position: absolute + transform），滚动 / 缩放时重算。
 */
function positionCaretElement(layer: HTMLElement, caret: CaretElement): void {
  const { el, blockDom, side } = caret
  const root = layer.offsetParent instanceof HTMLElement ? layer.offsetParent : layer.parentElement
  if (!root) return
  const blockRect = blockDom.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  // 用真实渲染尺寸（offsetHeight 在刚 append 时可能还是 0 / 旧值）。
  const own = el.getBoundingClientRect()
  const width = own.width || 2
  const height = own.height || 18
  let x = blockRect.left - rootRect.left + root.scrollLeft
  let y = blockRect.top - rootRect.top + root.scrollTop
  if (side === 'after') {
    // 块尾：块的右外侧、底边对齐（与块头左上外侧成对角线）。
    x += blockRect.width + CARET_GUTTER
    y += blockRect.height - height
  } else {
    // 块头：块的左外侧、顶边对齐。整根线落在块外，避免压住图片 / 代码内容。
    x -= width + CARET_GUTTER
  }
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
}

function positionCaret(
  view: EditorView,
  state: EditorState,
  caret: CaretElement | null,
  layer: HTMLElement
): CaretElement | null {
  const target = activeBlockBoundaryTarget(state)
  if (!target) {
    caret?.el.remove()
    return null
  }
  const dom = view.nodeDOM(target.blockPos)
  if (!(dom instanceof HTMLElement)) {
    caret?.el.remove()
    return null
  }
  if (caret && caret.blockDom === dom && caret.side === target.side) {
    if (!caret.el.isConnected) layer.append(caret.el)
    positionCaretElement(layer, caret)
    return caret
  }
  caret?.el.remove()
  const el = createCaretElement(target.side)
  // 诊断 / e2e 用：当前停靠的是哪个块。
  el.dataset.boundaryBlock = dom.className
  layer.append(el)
  const next: CaretElement = { el, blockDom: dom, side: target.side }
  positionCaretElement(layer, next)
  return next
}

export function createBlockBoundaryCaretPlugin(): MilkdownPlugin {
  return $prose(
    () =>
      new Plugin({
        key: blockBoundaryCaretKey,
        props: {
          attributes: (state): Record<string, string> => {
            const target = activeBlockBoundaryTarget(state)
            return target ? { 'data-boundary-caret': String(target.side) } : {}
          }
        },
        view: (view) => {
          const host = view.dom.parentElement ?? view.dom
          if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
          const layer = document.createElement('div')
          layer.className = BOUNDARY_CARET_LAYER_CLASS
          layer.setAttribute('aria-hidden', 'true')
          host.append(layer)

          let caret: CaretElement | null = positionCaret(view, view.state, null, layer)
          let frame = -1
          const schedule = (): void => {
            if (frame >= 0) return
            frame = requestAnimationFrame(() => {
              frame = -1
              if (caret) positionCaretElement(layer, caret)
            })
          }
          const doc = view.dom.ownerDocument
          doc.addEventListener('scroll', schedule, true)
          doc.defaultView?.addEventListener('resize', schedule)
          // 布局变化（代码块滚动条出现、图片解码后撑高）会让块矩形晚一帧才稳定。
          // 注意要盯**目标块本身**：`.milkdown` 有 min-height:100%，正文块高变化
          // 不会改变它的尺寸，只盯 host 会漏掉这类 3px 级的高度回缩。
          const resizeObserver =
            typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null
          resizeObserver?.observe(host)
          let observedBlock: HTMLElement | null = null
          const watchCaretBlock = (): void => {
            if (!resizeObserver) return
            const next = caret?.blockDom ?? null
            if (next === observedBlock) return
            if (observedBlock) resizeObserver.unobserve(observedBlock)
            observedBlock = next
            if (observedBlock) resizeObserver.observe(observedBlock)
          }
          watchCaretBlock()
          schedule()

          return {
            update: (nextView, previousState) => {
              const wasActive = previousState.selection instanceof BlockBoundaryCaret
              const isActive = nextView.state.selection instanceof BlockBoundaryCaret
              if (!isActive && !wasActive) return
              if (!isActive) {
                caret?.el.remove()
                caret = null
                watchCaretBlock()
                return
              }
              caret = positionCaret(nextView, nextView.state, caret, layer)
              watchCaretBlock()
              schedule()
            },
            destroy: () => {
              if (frame >= 0) cancelAnimationFrame(frame)
              doc.removeEventListener('scroll', schedule, true)
              doc.defaultView?.removeEventListener('resize', schedule)
              resizeObserver?.disconnect()
              caret?.el.remove()
              layer.remove()
            }
          }
        }
      })
  )
}
