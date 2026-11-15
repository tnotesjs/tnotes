import type {
  KbStructureRequest,
  KbStructureResult,
  KnowledgeBaseDetail
} from '../shared/contracts'

export interface StructureNote {
  uuid: string
  index: string
  title: string
  relPath: string
}

export interface KbStructureDeps {
  createNotes(input: {
    knowledgeBaseId: string
    titles?: string[]
    title?: string
    count?: number
  }): Promise<{ knowledgeBase: KnowledgeBaseDetail; notes: StructureNote[] }>
  renameNote(input: {
    knowledgeBaseId: string
    note: string
    title: string
  }): Promise<{ knowledgeBase: KnowledgeBaseDetail; note: StructureNote }>
  deleteNotes(input: {
    knowledgeBaseId: string
    notes: string[]
  }): Promise<{ knowledgeBase: KnowledgeBaseDetail; notes: StructureNote[] }>
  moveNote(input: {
    knowledgeBaseId: string
    note: string
    placement: 'before' | 'after' | 'inside'
    target?: string
    folderPath?: string[]
  }): Promise<{ knowledgeBase: KnowledgeBaseDetail }>
  setDone(input: {
    knowledgeBaseId: string
    note: string
    done: boolean
  }): Promise<{ knowledgeBase: KnowledgeBaseDetail; note: StructureNote }>
  git(input: {
    knowledgeBaseId: string
    action: 'pull' | 'push'
  }): Promise<{ knowledgeBase: KnowledgeBaseDetail; message: string }>
}

const PLACEHOLDER_TITLE = 'new'

function cleanTitles(titles: string[] | undefined): string[] {
  return (titles ?? []).map((title) => title.trim()).filter(Boolean)
}

/** 内置 Agent 和本机 MCP 共用的知识库结构操作。具体落盘由 deps 走现有流程。 */
export async function runKbStructure(
  request: KbStructureRequest,
  deps: KbStructureDeps
): Promise<KbStructureResult> {
  if (request.op === 'create') {
    const titles = cleanTitles(request.titles)
    const count = request.count
    if (
      titles.length === 0 &&
      !(typeof count === 'number' && Number.isInteger(count) && count > 0)
    ) {
      throw new Error('新建笔记要传 titles（每篇标题），或传 count（用默认标题占位）')
    }
    const created = await deps.createNotes(
      titles.length > 0
        ? { knowledgeBaseId: request.knowledgeBaseId, titles }
        : { knowledgeBaseId: request.knowledgeBaseId, title: PLACEHOLDER_TITLE, count }
    )
    const listed = created.notes.map((note) => `${note.index} ${note.title}`).join('、')
    return {
      summary: `新建 ${created.notes.length} 篇笔记`,
      detail: listed,
      knowledgeBase: created.knowledgeBase,
      notes: created.notes
    }
  }
  if (request.op === 'rename') {
    const title = request.title.trim()
    if (!request.note.trim() || !title) throw new Error('重命名需要笔记和标题')
    const renamed = await deps.renameNote({
      knowledgeBaseId: request.knowledgeBaseId,
      note: request.note,
      title
    })
    return {
      summary: `重命名为 ${renamed.note.title}`,
      detail: `${renamed.note.index} ${renamed.note.title}`,
      knowledgeBase: renamed.knowledgeBase,
      notes: [renamed.note]
    }
  }
  if (request.op === 'delete') {
    const notes = request.notes.map((note) => note.trim()).filter(Boolean)
    if (notes.length === 0) throw new Error('没有要删除的笔记')
    const removed = await deps.deleteNotes({ knowledgeBaseId: request.knowledgeBaseId, notes })
    return {
      summary: `删除 ${removed.notes.length} 篇笔记`,
      detail: removed.notes.map((note) => `${note.index} ${note.title}`).join('、'),
      knowledgeBase: removed.knowledgeBase,
      notes: removed.notes
    }
  }
  if (request.op === 'move') {
    if (!request.note.trim()) throw new Error('没有要移动的笔记')
    if (!request.target?.trim() && !(request.folderPath && request.folderPath.length > 0)) {
      throw new Error('移动笔记需要目标笔记或分组')
    }
    const moved = await deps.moveNote({
      knowledgeBaseId: request.knowledgeBaseId,
      note: request.note,
      placement: request.placement,
      target: request.target,
      folderPath: request.folderPath
    })
    return {
      summary: '已调整目录位置',
      detail: request.note,
      knowledgeBase: moved.knowledgeBase,
      notes: []
    }
  }
  if (request.op === 'set-done') {
    if (!request.note.trim()) throw new Error('没有要切换完成状态的笔记')
    const updated = await deps.setDone({
      knowledgeBaseId: request.knowledgeBaseId,
      note: request.note,
      done: request.done
    })
    return {
      summary: updated.note.title + (request.done ? ' 已标记完成' : ' 已标记未完成'),
      detail: `${updated.note.index} ${updated.note.title}`,
      knowledgeBase: updated.knowledgeBase,
      notes: [updated.note]
    }
  }
  const synced = await deps.git({
    knowledgeBaseId: request.knowledgeBaseId,
    action: request.action
  })
  return {
    summary: request.action === 'pull' ? '已拉取' : '已推送',
    detail: synced.message,
    knowledgeBase: synced.knowledgeBase,
    notes: []
  }
}
