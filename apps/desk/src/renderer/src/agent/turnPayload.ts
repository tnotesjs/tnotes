import type {
  AgentChatMessage,
  AgentMode,
  AgentNoteContext,
  AgentOpenNote,
  AgentReasoningEffort,
  AgentSelectionContext,
  AgentTurnRequest
} from '../../../shared/contracts'

export const HISTORY_LIMIT = 30
export const MESSAGE_CHAR_LIMIT = 100_000
export const SELECTION_LIMIT = 20_000
export const CONTENT_LIMIT = 400_000
/** 点名的笔记一共最多附上这么多字的全文，超出的只附元信息 */
export const INLINE_BUDGET = 24_000
export const SELECTION_CLIPPED = '（选区过长，已截断）'

/** 只保留最近若干条，并保证第一条是用户消息。单条超长会截断。 */
export function trimHistory<T extends { role: string; content: string }>(messages: readonly T[], limit = HISTORY_LIMIT): T[] {
  const clipped = messages.map((message) =>
    message.content.length > MESSAGE_CHAR_LIMIT ? { ...message, content: message.content.slice(0, MESSAGE_CHAR_LIMIT) } : message
  )
  let start = Math.max(0, clipped.length - limit)
  while (start < clipped.length && clipped[start]?.role !== 'user') start += 1
  return clipped.slice(start)
}

export function clipSelection(text: string): string {
  if (text.length <= SELECTION_LIMIT) return text
  const room = SELECTION_LIMIT - SELECTION_CLIPPED.length
  return `${text.slice(0, Math.max(0, room))}${SELECTION_CLIPPED}`
}

/** 按顺序附上全文，直到总字数超过预算；超长的笔记只附元信息。 */
export function inlineNotes(notes: readonly AgentNoteContext[], budget = INLINE_BUDGET): AgentNoteContext[] {
  let used = 0
  return notes.map((note) => {
    const fits = note.content.length <= CONTENT_LIMIT && used + note.content.length <= budget
    if (fits) used += note.content.length
    return { ...note, content: fits ? note.content : '' }
  })
}

/** edit_note 省略 note 时改哪篇：只点名一篇，或选区都来自同一篇时才有答案。 */
export function defaultNoteFor(
  notes: ReadonlyArray<{ knowledgeBaseId: string; noteUuid: string }>,
  selections: ReadonlyArray<{ knowledgeBaseId: string; noteUuid: string }>
): { knowledgeBaseId: string; noteUuid: string } | null {
  const keys = new Map<string, { knowledgeBaseId: string; noteUuid: string }>()
  for (const item of [...notes, ...selections]) {
    keys.set(`${item.knowledgeBaseId}:${item.noteUuid}`, { knowledgeBaseId: item.knowledgeBaseId, noteUuid: item.noteUuid })
  }
  return keys.size === 1 ? [...keys.values()][0] : null
}

export interface TurnInput {
  turnId: string
  messages: readonly AgentChatMessage[]
  mode: AgentMode
  knowledgeBaseId: string
  knowledgeBaseName: string
  current: AgentOpenNote | null
  notes: readonly AgentNoteContext[]
  selections: readonly AgentSelectionContext[]
  modelRef: string
  reasoningEffort: AgentReasoningEffort | ''
}

/** 组装请求并去掉 Vue 代理，Electron 才能结构化克隆。 */
export function agentTurnPayload(input: TurnInput): AgentTurnRequest {
  const notes = inlineNotes(input.notes)
  const selections = input.selections.map((item) => ({ ...item, text: clipSelection(item.text) }))
  return JSON.parse(
    JSON.stringify({
      turnId: input.turnId,
      messages: trimHistory(input.messages).map((message) => ({
        role: message.role,
        content: String(message.content),
        ...(message.images?.length ? { images: [...message.images] } : {})
      })),
      mode: input.mode,
      knowledgeBaseId: input.knowledgeBaseId,
      knowledgeBaseName: input.knowledgeBaseName,
      current: input.current,
      notes,
      selections,
      defaultNote: defaultNoteFor(input.notes, input.selections),
      modelRef: input.modelRef,
      reasoningEffort: input.reasoningEffort
    })
  ) as AgentTurnRequest
}
