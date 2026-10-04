import { RectangleMarker, layer, type EditorView, type LayerMarker } from '@codemirror/view'

/**
 * 选区背景只盖住选中的字：`drawSelection` 会把跨行选区的行尾一直铺到内容区右缘，
 * 这里按 DOM 里实际选中的文字（和不可编辑的部件）逐个取矩形，同一视觉行内相邻的并成一块。
 * 选中的空行只画一小格，表示这一行也在选区里。
 * 画在文字上面：代码块的行有不透明底色，画在下面会被挡住；高亮色是半透明的，词法颜色仍然透得出来。
 */
export const glyphSelectionLayer = layer({
  above: true,
  class: 'cm-lp-selection-layer',
  update: (update) =>
    update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged,
  markers: (view) => {
    const markers: LayerMarker[] = []
    for (const range of view.state.selection.ranges) {
      if (range.empty) continue
      markers.push(...markersForRange(view, range.from, range.to))
    }
    return markers
  }
})

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

const EMPTY_LINE_WIDTH = 6

function markersForRange(view: EditorView, rangeFrom: number, rangeTo: number): LayerMarker[] {
  const from = Math.max(rangeFrom, view.viewport.from)
  const to = Math.min(rangeTo, view.viewport.to)
  if (from >= to) return []
  const boxes = collectBoxes(view, from, to)
  const scrollRect = view.scrollDOM.getBoundingClientRect()
  const baseLeft = scrollRect.left - view.scrollDOM.scrollLeft * view.scaleX
  const baseTop = scrollRect.top - view.scrollDOM.scrollTop * view.scaleY
  return mergeRows(boxes).map(
    (box) =>
      new RectangleMarker(
        'cm-lp-selection',
        box.left - baseLeft,
        box.top - baseTop,
        Math.max(0, box.right - box.left),
        box.bottom - box.top
      )
  )
}

function collectBoxes(view: EditorView, from: number, to: number): Box[] {
  const boxes: Box[] = []
  let domRange: Range
  try {
    const start = view.domAtPos(from)
    const end = view.domAtPos(to)
    domRange = document.createRange()
    domRange.setStart(start.node, start.offset)
    domRange.setEnd(end.node, end.offset)
  } catch {
    return boxes
  }
  const root = view.contentDOM
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!domRange.intersectsNode(node)) return NodeFilter.FILTER_REJECT
      // 标题和列表左侧的折叠箭头是操作按钮，不参与选区底色。
      if (node instanceof HTMLElement && node.closest('.cm-lp-heading-toggle, .cm-lp-list-toggle')) {
        return NodeFilter.FILTER_REJECT
      }
      if (node instanceof HTMLElement && node.contentEditable === 'false') {
        return NodeFilter.FILTER_ACCEPT
      }
      return node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    }
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLElement) {
      if (!fullyInside(domRange, node)) continue
      pushRects(boxes, node.getClientRects())
      continue
    }
    const text = node as Text
    if (!text.data.length || text.parentElement?.closest('[contenteditable="false"]')) continue
    const piece = document.createRange()
    piece.selectNodeContents(text)
    if (text === domRange.startContainer) piece.setStart(text, domRange.startOffset)
    if (text === domRange.endContainer) piece.setEnd(text, domRange.endOffset)
    if (piece.collapsed) continue
    pushRects(boxes, piece.getClientRects())
  }
  addEmptyLines(view, from, to, boxes)
  return boxes
}

function fullyInside(range: Range, node: Node): boolean {
  const probe = document.createRange()
  probe.selectNode(node)
  return (
    range.compareBoundaryPoints(Range.START_TO_START, probe) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, probe) >= 0
  )
}

function pushRects(boxes: Box[], rects: DOMRectList): void {
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue
    boxes.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  }
}

/** 选区完整跨过的空行没有字可盖，在行首画一小格。 */
function addEmptyLines(view: EditorView, from: number, to: number, boxes: Box[]): void {
  const doc = view.state.doc
  for (let pos = from; pos <= to;) {
    const line = doc.lineAt(pos)
    if (line.length === 0 && line.from >= from && line.from < to) {
      const coords = view.coordsAtPos(line.from, 1)
      if (coords) {
        boxes.push({
          left: coords.left,
          right: coords.left + EMPTY_LINE_WIDTH,
          top: coords.top,
          bottom: coords.bottom
        })
      }
    }
    if (line.to >= to) break
    pos = line.to + 1
  }
}

/** 同一视觉行（竖向大体重叠）里水平相接的矩形并成一块，避免逐个文字节点之间露出细缝。 */
function mergeRows(boxes: Box[]): Box[] {
  const center = (box: Box): number => Math.round((box.top + box.bottom) / 2)
  const sorted = [...boxes].sort((a, b) => center(a) - center(b) || a.left - b.left)
  const merged: Box[] = []
  for (const box of sorted) {
    const row = merged.find(
      (other) =>
        Math.min(other.bottom, box.bottom) - Math.max(other.top, box.top) >
          0.5 * Math.min(other.bottom - other.top, box.bottom - box.top) &&
        box.left <= other.right + 2 &&
        box.right >= other.left - 2
    )
    if (row) {
      row.left = Math.min(row.left, box.left)
      row.right = Math.max(row.right, box.right)
      row.top = Math.min(row.top, box.top)
      row.bottom = Math.max(row.bottom, box.bottom)
    } else {
      merged.push({ ...box })
    }
  }
  return merged
}
