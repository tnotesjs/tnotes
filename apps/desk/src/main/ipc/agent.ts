import { randomUUID } from 'node:crypto'

import { join } from 'node:path'

import type { BrowserWindow } from 'electron'
import { app, shell } from 'electron'
import { z } from 'zod'

import { chatImageIds, deleteAgentAttachments, readAgentAttachment, saveAgentAttachment } from '../agent/attachments'
import { deleteAgentChat, listAgentChats, saveAgentChat } from '../agent/chats'
import { runAgentChat } from '../agent/chat'
import { listCursorModels, loginCursor, runCursorTurn } from '../agent/cursorRunner'
import { listOpenAiModels } from '../agent/models'
import { withImages } from '../agent/messages'
import { deskLog } from '../log'
import { clearAgentKey, encryptionAvailable, readAgentKey, readAgentKeys, writeAgentKey } from '../agent/key'
import { loadSettings } from '../settings'
import { isCursorProvider, resolveModelRef } from '../../shared/agentModels'
import { IPC_CHANNELS } from '../../shared/contracts'
import { handle, noInputSchema, type GetWindow } from './shared'

import type {
  AgentEvent,
  AgentKeyStatus,
  AgentStoredChat,
  AgentToolCallRequest,
  AgentToolResult,
  AgentTurnRequest
} from '../../shared/contracts'

const pendingTools = new Map<string, (result: AgentToolResult) => void>()
let currentAbort: AbortController | null = null

/** Cursor Agent 的工作目录：空目录，不指向任何知识库，它自带的文件工具也已关掉。 */
function cursorSandboxDir(): string {
  return join(app.getPath('userData'), 'cursor-agent-sandbox')
}

/** 旧版单个密钥归给第一个服务商 */
function legacyProviderId(): string {
  return loadSettings().agent.providers[0]?.id ?? ''
}

function keyStatus(): AgentKeyStatus {
  const keys = readAgentKeys(legacyProviderId())
  const providers = Object.fromEntries(loadSettings().agent.providers.map((provider) => [provider.id, Boolean(keys[provider.id])]))
  return { providers, encryptionAvailable: encryptionAvailable() }
}

function send(window: BrowserWindow, channel: string, payload: unknown): void {
  if (!window.isDestroyed()) window.webContents.send(channel, payload)
}

function requestTool(
  window: BrowserWindow,
  turnId: string,
  call: { id: string; name: string; args: Record<string, unknown> },
  signal: AbortSignal
): Promise<AgentToolResult> {
  const id = call.id || randomUUID()
  return new Promise((resolve) => {
    const finish = (result: AgentToolResult): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const timer = setTimeout(() => {
      pendingTools.delete(id)
      finish({ id, ok: false, summary: '编辑器没有在 30 秒内完成这个操作', detail: '' })
    }, 30_000)
    const onAbort = (): void => {
      pendingTools.delete(id)
      finish({ id, ok: false, summary: '已停止', detail: '' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pendingTools.set(id, finish)
    const request: AgentToolCallRequest = { turnId, id, name: call.name, args: call.args }
    if (window.isDestroyed()) {
      pendingTools.delete(id)
      finish({ id, ok: false, summary: '主窗口已经关闭', detail: '' })
      return
    }
    send(window, IPC_CHANNELS.agentToolCall, request)
  })
}

const chatSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  updatedAt: z.string(),
  mode: z.enum(['agent', 'ask']),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }).passthrough())
}).passthrough()

const kbName = z.string().max(200).default('')
const noteRef = {
  knowledgeBaseId: z.string().min(1),
  knowledgeBaseName: kbName,
  noteUuid: z.string().min(1),
  noteIndex: z.string().default(''),
  title: z.string().max(400)
}

export function registerAgent(getWindow: GetWindow): void {
  handle(IPC_CHANNELS.agentKeyStatus, getWindow, noInputSchema, () => keyStatus())
  handle(
    IPC_CHANNELS.agentKeyUpdate,
    getWindow,
    z.object({ providerId: z.string().min(1).max(80), apiKey: z.string().max(4096).optional(), clear: z.boolean() }),
    ({ providerId, apiKey, clear }) => {
      if (clear) {
        clearAgentKey(providerId, legacyProviderId())
        return keyStatus()
      }
      const next = apiKey?.trim()
      if (next) writeAgentKey(providerId, next, legacyProviderId())
      return keyStatus()
    }
  )
  handle(IPC_CHANNELS.agentCursorLogin, getWindow, z.object({ providerId: z.string().min(1).max(80) }), async ({ providerId }) => {
    const { apiKey, email } = await loginCursor((url) => shell.openExternal(url))
    writeAgentKey(providerId, apiKey, legacyProviderId())
    return { status: keyStatus(), email }
  })
  handle(
    IPC_CHANNELS.agentListModels,
    getWindow,
    z.object({
      providerId: z.string().min(1).max(80),
      kind: z.enum(['openai', 'cursor']).optional(),
      baseUrl: z.string().max(2000).optional()
    }),
    ({ providerId, kind, baseUrl }) => {
      const saved = loadSettings().agent.providers.find((provider) => provider.id === providerId)
      const cursor = (kind ?? saved?.kind) === 'cursor'
      const apiKey = readAgentKey(providerId, legacyProviderId())?.trim()
      if (!apiKey) throw new Error(cursor ? '还没有登录 Cursor 或填写 API Key' : '还没有保存这个服务商的 API Key')
      if (cursor) return listCursorModels(apiKey)
      const url = baseUrl?.trim() || saved?.baseUrl || ''
      if (!/^https?:\/\//i.test(url)) throw new Error('先填写接口地址')
      return listOpenAiModels(url, apiKey)
    }
  )
  handle(IPC_CHANNELS.agentCancel, getWindow, noInputSchema, () => {
    currentAbort?.abort()
    currentAbort = null
  })
  const workspacePath = z.string().min(1).max(4096)
  handle(IPC_CHANNELS.agentChatsList, getWindow, z.object({ workspacePath }), (request) =>
    listAgentChats(request.workspacePath)
  )
  handle(
    IPC_CHANNELS.agentChatsSave,
    getWindow,
    z.object({ workspacePath, chat: chatSchema }),
    (request) => {
      for (const dropped of saveAgentChat(request.workspacePath, request.chat as AgentStoredChat)) {
        deleteAgentAttachments(chatImageIds(dropped))
      }
    }
  )
  handle(
    IPC_CHANNELS.agentChatsDelete,
    getWindow,
    z.object({ workspacePath, chatId: z.string().min(1) }),
    (request) => {
      const removed = deleteAgentChat(request.workspacePath, request.chatId)
      if (removed) deleteAgentAttachments(chatImageIds(removed))
    }
  )
  handle(
    IPC_CHANNELS.agentAttachmentSave,
    getWindow,
    z.object({
      data: z.instanceof(Uint8Array),
      width: z.number().positive().max(10_000),
      height: z.number().positive().max(10_000)
    }),
    ({ data, width, height }) => saveAgentAttachment(data, width, height)
  )
  handle(IPC_CHANNELS.agentAttachmentRead, getWindow, z.object({ id: z.string().min(1) }), ({ id }) => {
    const url = readAgentAttachment(id)
    if (!url) throw new Error('图片不存在')
    return url
  })
  handle(
    IPC_CHANNELS.agentToolResult,
    getWindow,
    z.object({
      id: z.string().min(1),
      ok: z.boolean(),
      summary: z.string(),
      detail: z.string()
    }),
    (result: AgentToolResult) => {
      const resolve = pendingTools.get(result.id)
      pendingTools.delete(result.id)
      resolve?.(result)
    }
  )
  handle(
    IPC_CHANNELS.agentTurn,
    getWindow,
    z.object({
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(100_000),
            images: z.array(z.string().min(1)).max(4).optional()
          })
        )
        .min(1)
        .max(40),
      mode: z.enum(['agent', 'ask']).default('agent'),
      knowledgeBaseId: z.string().min(1),
      knowledgeBaseName: kbName,
      current: z.object(noteRef).nullable().default(null),
      notes: z
        .array(
          z.object({
            ...noteRef,
            path: z.string().max(1000),
            lines: z.number().int().min(0),
            content: z.string().max(400_000)
          })
        )
        .max(12)
        .default([]),
      selections: z
        .array(
          z.object({
            ...noteRef,
            startLine: z.number().int().min(1),
            endLine: z.number().int().min(1),
            text: z.string().max(20_000)
          })
        )
        .max(8)
        .default([]),
      defaultNote: z.object({ knowledgeBaseId: z.string().min(1), noteUuid: z.string().min(1) }).nullable().default(null),
      modelRef: z.string().default(''),
      reasoningEffort: z.enum(['low', 'medium', 'high', '']).default(''),
      turnId: z.string().min(1)
    }),
    async (request: AgentTurnRequest) => {
      const window = getWindow()
      if (!window) throw new Error('Desk 主窗口不可用')
      const settings = loadSettings().agent
      const resolved = resolveModelRef(settings, request.modelRef || settings.defaultModel)
      if (!resolved) throw new Error('模型不存在，请在设置 → 内置 Agent 里检查')
      const cursor = isCursorProvider(resolved.provider)
      const override = app.isPackaged || cursor ? '' : process.env.TNOTES_AGENT_BASE_URL?.trim()
      const apiKey = override
        ? process.env.TNOTES_AGENT_API_KEY?.trim() || 'test'
        : readAgentKey(resolved.provider.id, legacyProviderId())?.trim()
      if (!apiKey) {
        throw new Error(
          cursor
            ? `还没有登录「${resolved.provider.name}」。打开设置 → 内置 Agent，点「用 Cursor 账号登录」。`
            : `还没有填写「${resolved.provider.name}」的 API Key。打开设置 → 内置 Agent。`
        )
      }
      if (!resolved.model.vision && request.messages.some((message) => message.images?.length)) {
        throw new Error('当前模型不能看图，换一个能看图的模型')
      }
      currentAbort?.abort()
      const controller = new AbortController()
      currentAbort = controller
      const turnId = request.turnId
      const emit = (event: AgentEvent): void => send(window, IPC_CHANNELS.agentEvent, event)
      const shared = {
        apiKey,
        model: resolved.model.id,
        mode: request.mode,
        messages: withImages(request.messages, (id) => {
          try {
            return readAgentAttachment(id)
          } catch {
            return null
          }
        }),
        knowledgeBaseName: request.knowledgeBaseName,
        current: request.current,
        notes: request.notes,
        selections: request.selections,
        defaultNote: request.defaultNote,
        signal: controller.signal,
        executeTool: async (call: { id: string; name: string; args: Record<string, unknown> }) => {
          emit({ type: 'tool-start', turnId, id: call.id, name: call.name, args: call.args })
          const result = await requestTool(window, turnId, call, controller.signal)
          emit({ type: 'tool-end', turnId, id: call.id, ok: result.ok, summary: result.summary })
          return result
        },
        onText: (delta: string) => emit({ type: 'text', turnId, delta }),
        onReasoning: (delta: string) => emit({ type: 'reasoning', turnId, delta })
      }
      try {
        if (cursor) {
          deskLog('agent', 'cursor turn', { model: resolved.model.id, mode: request.mode })
          return await runCursorTurn({ ...shared, sandboxDir: cursorSandboxDir() })
        }
        return await runAgentChat({
          ...shared,
          baseUrl: override || resolved.provider.baseUrl,
          reasoningEffort: resolved.model.reasoning ? request.reasoningEffort : '',
          onRequest: ({ url, model, reasoningEffort }) => {
            deskLog('agent', 'request', { url, model, reasoningEffort })
          }
        })
      } catch (error) {
        const message = controller.signal.aborted
          ? '已停止'
          : error instanceof Error
            ? error.message
            : String(error)
        emit({ type: 'error', turnId, message })
        throw new Error(message)
      } finally {
        if (currentAbort === controller) currentAbort = null
      }
    }
  )
}
