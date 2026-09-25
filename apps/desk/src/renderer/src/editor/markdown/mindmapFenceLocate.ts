/**
 * 在笔记正文里用打开时记下的整段围栏原文定位：
 * 恰好一份 → 可替换；零份或多份 → 失效，不再写入。
 */
export type FenceLocateResult =
  | { status: 'ok'; from: number; to: number }
  | { status: 'missing' }
  | { status: 'ambiguous' }

/** 按出现顺序收集 mindmap 围栏（不含围栏后的换行）。 */
export function listMindmapFences(content: string): string[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const fences: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^(?: {0,3})(`{3,})mindmap(?:\s|\[|$)/.exec(lines[index] ?? '')
    if (!open) continue
    const marker = open[1]
    let end = index + 1
    const close = new RegExp(`^ {0,3}${marker}+[ \\t]*$`)
    for (; end < lines.length; end += 1) {
      if (close.test(lines[end] ?? '')) break
    }
    if (end >= lines.length) continue
    fences.push(lines.slice(index, end + 1).join('\n'))
    index = end
  }
  return fences
}

/**
 * 卡片上的围栏原文在笔记里是第几段 mindmap（从 0 起）。
 * 卡片切片和围栏正文允许差一个收尾换行。
 */
export function mindmapFenceOrdinal(content: string, clickedSource: string): number | null {
  const needle = clickedSource.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!needle) return null
  const fences = listMindmapFences(content)
  let best = -1
  let bestGap = Number.POSITIVE_INFINITY
  for (let index = 0; index < fences.length; index += 1) {
    const fence = fences[index]
    if (!needle.includes(fence) && !fence.includes(needle)) continue
    const gap = Math.abs(fence.length - needle.length)
    if (gap < bestGap) {
      best = index
      bestGap = gap
    }
  }
  return best >= 0 ? best : null
}

export function locateUniqueFence(content: string, fenceSource: string): FenceLocateResult {
  if (!fenceSource) return { status: 'missing' }
  let from = -1
  let count = 0
  let searchFrom = 0
  while (searchFrom <= content.length) {
    const index = content.indexOf(fenceSource, searchFrom)
    if (index < 0) break
    count += 1
    from = index
    searchFrom = index + Math.max(1, fenceSource.length)
    if (count > 1) return { status: 'ambiguous' }
  }
  if (count === 0) return { status: 'missing' }
  return { status: 'ok', from, to: from + fenceSource.length }
}
