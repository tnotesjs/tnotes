import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { AgentStoredChat } from '../../shared/contracts'

const MAX_CHATS = 50

let rootOverride: string | null = null

export function setAgentChatRootForTests(root: string | null): void {
  rootOverride = root
}

function directory(): string {
  if (rootOverride) return rootOverride
  const { app } = require('electron') as { app: { getPath: (name: string) => string } }
  return join(app.getPath('userData'), 'agent-chats')
}

/** 对话按工作区存：同一个工作区里切换知识库，对话都还在。 */
function fileFor(workspacePath: string): string {
  const digest = createHash('sha256').update(resolve(workspacePath)).digest('hex').slice(0, 16)
  return join(directory(), `workspace-${digest}.json`)
}

export function listAgentChats(workspacePath: string): AgentStoredChat[] {
  const path = fileFor(workspacePath)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentStoredChat[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 返回因为超过条数上限被挤掉的对话（调用方负责清理它们的图片）。 */
export function saveAgentChat(workspacePath: string, chat: AgentStoredChat): AgentStoredChat[] {
  const path = fileFor(workspacePath)
  mkdirSync(directory(), { recursive: true })
  const rest = listAgentChats(workspacePath).filter((item) => item.id !== chat.id)
  const sorted = [chat, ...rest].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  writeFileSync(path, JSON.stringify(sorted.slice(0, MAX_CHATS)))
  return sorted.slice(MAX_CHATS)
}

/** 返回被删掉的对话，没有就是 null。 */
export function deleteAgentChat(workspacePath: string, chatId: string): AgentStoredChat | null {
  const path = fileFor(workspacePath)
  if (!existsSync(path)) return null
  const all = listAgentChats(workspacePath)
  const removed = all.find((item) => item.id === chatId) ?? null
  writeFileSync(path, JSON.stringify(all.filter((item) => item.id !== chatId)))
  return removed
}
