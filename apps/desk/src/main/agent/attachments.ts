/**
 * 内置 Agent 对话里的图片：存在 userData/agent-attachments/ 下，不写进知识库。
 * 对话记录只存 id；发请求时再读成 data URL。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AgentImageRef, AgentStoredChat } from '../../shared/contracts'

const MAX_BYTES = 8 * 1024 * 1024
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let rootOverride: string | null = null

export function setAgentAttachmentRootForTests(root: string | null): void {
  rootOverride = root
}

function root(): string {
  if (rootOverride) return rootOverride
  const { app } = require('electron') as { app: { getPath: (name: string) => string } }
  return join(app.getPath('userData'), 'agent-attachments')
}

function fileFor(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error('图片 id 无效')
  return join(root(), `${id}.jpg`)
}

export function saveAgentAttachment(data: Uint8Array, width: number, height: number): AgentImageRef {
  if (data.byteLength === 0 || data.byteLength > MAX_BYTES) throw new Error('图片太大（最多 8MB）')
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('只接受 JPEG 图片')
  const id = randomUUID()
  mkdirSync(root(), { recursive: true })
  writeFileSync(fileFor(id), data)
  return { id, width: Math.round(width), height: Math.round(height) }
}

export function readAgentAttachment(id: string): string | null {
  const path = fileFor(id)
  if (!existsSync(path)) return null
  return `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`
}

export function deleteAgentAttachments(ids: readonly string[]): void {
  for (const id of ids) {
    if (!ID_PATTERN.test(id)) continue
    rmSync(fileFor(id), { force: true })
  }
}

export function chatImageIds(chat: AgentStoredChat): string[] {
  return chat.messages.flatMap((message) => (message.images ?? []).map((image) => image.id))
}
