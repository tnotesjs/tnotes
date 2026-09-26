import type { DeskTocNode } from './contracts'

export const TOC_DRAG_TYPE = 'application/x-tnotes-toc'

export function isTocDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer?.types.includes(TOC_DRAG_TYPE))
}

/** 只有笔记能放进置顶组。分组拖拽仍然只改目录顺序。 */
export function noteFromTocDrag(
  dataTransfer: DataTransfer | null
): Extract<DeskTocNode, { type: 'note' }> | null {
  const raw = dataTransfer?.getData(TOC_DRAG_TYPE)
  if (!raw) return null
  try {
    const node = JSON.parse(raw) as DeskTocNode
    if (node?.type !== 'note' || typeof node.uuid !== 'string' || !node.uuid) return null
    return node
  } catch {
    return null
  }
}
