import type { AgentChatMessage, AgentNoteContext, AgentTurnRequest } from '../../../shared/contracts'

/**
 * IPC 只能传可结构化克隆的纯数据。Vue / Pinia 的响应式代理过不去，
 * 会在 `ipcRenderer.invoke` 里抛 `An object could not be cloned`。
 */
export function agentTurnPayload(
  messages: readonly AgentChatMessage[],
  note: AgentNoteContext | null
): AgentTurnRequest {
  return {
    messages: messages.map((message) => ({ role: message.role, content: String(message.content) })),
    note: note
      ? {
          title: String(note.title),
          path: String(note.path),
          content: String(note.content),
          selection: String(note.selection)
        }
      : null
  }
}
