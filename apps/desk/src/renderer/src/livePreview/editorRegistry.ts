import type { EditorView } from '@codemirror/view'

/**
 * 已打开笔记 → 编辑器实例。内置 Agent 读写「实时内容」时从这里拿（而不是读磁盘），
 * 这样读到的包括未保存的修改，写入也走编辑器事务（可撤销、可审阅）。
 */
const views = new Map<string, Set<EditorView>>()

function key(knowledgeBaseId: string, noteUuid: string): string {
  return `${knowledgeBaseId}:${noteUuid}`
}

export function registerLiveEditor(knowledgeBaseId: string, noteUuid: string, view: EditorView): void {
  const id = key(knowledgeBaseId, noteUuid)
  const set = views.get(id) ?? new Set()
  set.add(view)
  views.set(id, set)
}

export function unregisterLiveEditor(knowledgeBaseId: string, noteUuid: string, view: EditorView): void {
  const id = key(knowledgeBaseId, noteUuid)
  const set = views.get(id)
  if (!set) return
  set.delete(view)
  if (set.size === 0) views.delete(id)
}

export function allLiveEditors(): Array<{ knowledgeBaseId: string; noteUuid: string; views: EditorView[] }> {
  return [...views].map(([id, set]) => {
    const split = id.indexOf(':')
    return { knowledgeBaseId: id.slice(0, split), noteUuid: id.slice(split + 1), views: [...set] }
  })
}

export function liveEditorsFor(knowledgeBaseId: string, noteUuid: string): EditorView[] {
  return [...(views.get(key(knowledgeBaseId, noteUuid)) ?? [])]
}

/** 同一篇笔记可能在多个分组里打开：优先返回有焦点的那个 */
export function liveEditorFor(knowledgeBaseId: string, noteUuid: string): EditorView | null {
  const list = liveEditorsFor(knowledgeBaseId, noteUuid)
  if (list.length === 0) return null
  return list.find((view) => view.hasFocus) ?? list[0]
}
