import type {
  DeskResult,
  DeskTocNode,
  KnowledgeBaseDetail,
  NoteCreateRequest,
  NoteDocumentDto,
  TocEntryRefDto,
  WorkspaceOverview
} from '../../../../shared/contracts'

export interface DocumentSession {
  document: NoteDocumentDto
  content: string
  dirty: boolean
  externalConflict: boolean
  saving: boolean
  /**
   * 编辑器里有**尚未 emit 出去**的修改（保存被拦下时会出现）。
   *
   * 这类修改只在编辑器内存里，`content` 里没有。它对用户来说是「我刚写的东西」，
   * 所以必须：① 计入「有未保存的修改」；② 关闭标签/窗口时要提示；
   * ③ 切换视图不能把编辑器销毁掉。
   */
  unsavedDraft: boolean
}

/**
 * 「文档有没有未保存内容」的唯一口径：**内容与磁盘不同，或存在未提交的草稿**。
 *
 * 关闭守卫（`ClosingResource.dirty`）只看这个布尔值，所以任何一处漏算草稿，
 * 都会让「关闭 → 保存/丢弃」绕过编辑器里那份还没写回的内容。
 */
export function documentDirty(
  content: string,
  diskContent: string,
  unsavedDraft: boolean
): boolean {
  return content !== diskContent || unsavedDraft
}

export interface GitAttention {
  knowledgeBaseId: string
  knowledgeBaseName: string
  kind: 'behind' | 'conflict'
  message: string
}

export function resultValue<T>(result: DeskResult<T>): T {
  if (result.ok) return result.value
  const error = new Error(result.error.message) as Error & { code?: string }
  error.code = result.error.code
  throw error
}

export function ipcPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function documentKey(knowledgeBaseId: string, noteUuid: string): string {
  return `${knowledgeBaseId}:${noteUuid}`
}

export function tocEntry(node: DeskTocNode): TocEntryRefDto {
  return node.type === 'note'
    ? { type: 'note', noteUuid: node.uuid }
    : { type: 'folder', folderPath: [...node.folderPath] }
}

export function notePlacement(
  placement: NoteCreateRequest['placement']
): NoteCreateRequest['placement'] {
  if (!placement || placement.type === 'root') {
    return { type: 'root', placement: placement?.placement ?? 'end' }
  }
  if (placement.type === 'note') {
    return {
      type: 'note',
      targetNoteUuid: placement.targetNoteUuid,
      placement: placement.placement
    }
  }
  return {
    type: 'folder',
    folderPath: [...placement.folderPath],
    placement: placement.placement
  }
}

export function replaceDescriptor(
  overview: WorkspaceOverview,
  detail: KnowledgeBaseDetail
): WorkspaceOverview {
  const update = (
    items: WorkspaceOverview['knowledgeBases']
  ): WorkspaceOverview['knowledgeBases'] =>
    items.map((item) => (item.id === detail.id ? detail : item))
  return {
    ...overview,
    knowledgeBases: update(overview.knowledgeBases),
    allKnowledgeBases: update(overview.allKnowledgeBases)
  }
}
