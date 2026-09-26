/**
 * 用 Cursor SDK 跑一轮对话：Cursor Agent 只负责思考和决定调用什么，
 * 笔记读写一律走 Desk 自己的工具（渲染端写回 + 审阅 + frontmatter 保护）。
 *
 * - `tools: ['mcp']` 关掉 Cursor 自带的读写文件、终端等工具，只剩自定义工具；
 * - `cwd` 是 Desk 数据目录下的空沙盒，不指向任何知识库；
 * - 每轮新建一个 Agent，多轮上下文靠历史带过去（和 OpenAI 兼容那条路一样无状态）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import { READ_TOOLS, WRITE_TOOLS, systemPrompt, type AgentChatInput } from './chat'

import type { SDKCustomTool, SDKJsonValue, SDKUserMessage } from '@cursor/sdk'

export type CursorSdk = Pick<typeof import('@cursor/sdk'), 'Agent' | 'Cursor' | 'CursorAgentError'>

export function loadCursorSdk(): Promise<CursorSdk> {
  return import('@cursor/sdk')
}

export interface CursorTurnInput
  extends Omit<AgentChatInput, 'baseUrl' | 'fetchImpl' | 'onRequest' | 'reasoningEffort'> {
  sandboxDir: string
  loadSdk?: () => Promise<CursorSdk>
}

const TOOL_RESULT_LIMIT = 16_000
const WRITE_NAMES = new Set(WRITE_TOOLS.map((tool) => tool.function.name))

function deskTools(input: CursorTurnInput, onEdit: () => void): Record<string, SDKCustomTool> {
  const definitions = input.mode === 'ask' ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS]
  return Object.fromEntries(
    definitions.map(({ function: definition }) => {
      const writes = WRITE_NAMES.has(definition.name)
      const tool: SDKCustomTool = {
        description: definition.description,
        inputSchema: JSON.parse(JSON.stringify(definition.parameters)) as Record<string, SDKJsonValue>,
        annotations: writes ? { readOnlyHint: false, destructiveHint: false } : { readOnlyHint: true },
        execute: async (args, context) => {
          const result = await input.executeTool({
            id: context.toolCallId || randomUUID(),
            name: definition.name,
            args: args as Record<string, unknown>
          })
          if (result.ok && writes) onEdit()
          const text = (result.ok ? result.detail : result.summary).slice(0, TOOL_RESULT_LIMIT)
          return {
            content: [{ type: 'text', text: text || (result.ok ? '完成' : '失败') }],
            isError: !result.ok
          }
        }
      }
      return [definition.name, tool]
    })
  )
}

/** Cursor Agent 自带编程助手的提示词，Desk 的规则放进这轮用户消息里。 */
export function cursorPrompt(input: CursorTurnInput): string {
  const history = input.messages.slice(0, -1)
  const last = input.messages[input.messages.length - 1]
  const toolNames =
    input.mode === 'ask'
      ? 'list_notes、search_notes、read_note'
      : 'list_notes、search_notes、read_note、edit_note、create_note'
  const lines = [
    systemPrompt(input),
    '',
    `笔记只能用 custom-user-tools 里的工具（${toolNames}）读写，不要用其他方式访问文件。`
  ]
  if (history.length) {
    lines.push('', '之前的对话：')
    for (const message of history) lines.push(`${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
  }
  lines.push('', '用户这一轮说：', last?.content ?? '')
  return lines.join('\n')
}

function userMessage(input: CursorTurnInput): SDKUserMessage {
  const text = cursorPrompt(input)
  const urls = input.messages[input.messages.length - 1]?.imageUrls ?? []
  const images = urls.flatMap((url) => {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
    return match ? [{ data: match[2], mimeType: match[1] }] : []
  })
  return images.length ? { text, images } : { text }
}

function startupMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const unknownModel = /Cannot use this model:\s*(.+?)\.\s+Available models/.exec(message)
  if (unknownModel) {
    return `Cursor 没有模型「${unknownModel[1]}」。打开设置 → 内置 Agent，点「读取模型」重新选。`
  }
  if (/api key|unauthori|401|authenticat/i.test(message)) {
    return `Cursor 密钥无效或已过期，请在设置 → 内置 Agent 里重新登录 Cursor。（${message}）`
  }
  return `Cursor Agent 没能启动：${message}`
}

export async function runCursorTurn(
  input: CursorTurnInput
): Promise<{ reply: string; edits: number; truncated: boolean }> {
  if (input.signal.aborted) throw new Error('已停止')
  const sdk = await (input.loadSdk ?? loadCursorSdk)()
  mkdirSync(input.sandboxDir, { recursive: true })
  let edits = 0
  let agent: Awaited<ReturnType<CursorSdk['Agent']['create']>>
  try {
    agent = await sdk.Agent.create({
      apiKey: input.apiKey,
      model: { id: input.model },
      name: 'TNotes Desk',
      tools: ['mcp'],
      local: {
        cwd: input.sandboxDir,
        settingSources: [],
        customTools: deskTools(input, () => {
          edits += 1
        })
      }
    })
  } catch (error) {
    throw new Error(startupMessage(error))
  }
  let text = ''
  try {
    let run: Awaited<ReturnType<typeof agent.send>>
    try {
      run = await agent.send(userMessage(input), {
        onDelta: ({ update }) => {
          if (update.type === 'text-delta') {
            text += update.text
            input.onText?.(update.text)
          } else if (update.type === 'thinking-delta') {
            input.onReasoning?.(update.text)
          }
        }
      })
    } catch (error) {
      if (input.signal.aborted) throw new Error('已停止')
      throw new Error(startupMessage(error))
    }
    const cancel = (): void => {
      void run.cancel().catch(() => undefined)
    }
    if (input.signal.aborted) cancel()
    else input.signal.addEventListener('abort', cancel, { once: true })
    try {
      // 文字和思考由 onDelta 推给界面；这里把流读完，run 才会结算
      for await (const message of run.stream()) void message
      const result = await run.wait()
      if (result.status === 'cancelled' || input.signal.aborted) throw new Error('已停止')
      if (result.status === 'error') {
        throw new Error(`Cursor Agent 执行失败：${result.error?.message ?? '未知错误'}`)
      }
      const reply = text.trim() || result.result?.trim() || '（模型没有返回文字）'
      return { reply, edits, truncated: false }
    } finally {
      input.signal.removeEventListener('abort', cancel)
    }
  } finally {
    await agent[Symbol.asyncDispose]().catch(() => undefined)
  }
}

export async function listCursorModels(
  apiKey: string,
  loadSdk: () => Promise<CursorSdk> = loadCursorSdk
): Promise<Array<{ id: string; displayName: string }>> {
  const sdk = await loadSdk()
  try {
    const models = await sdk.Cursor.models.list({ apiKey })
    return models.map((model) => ({ id: model.id, displayName: model.displayName || model.id }))
  } catch (error) {
    throw new Error(startupMessage(error))
  }
}

export async function loginCursor(
  openUrl: (url: string) => void | Promise<void>,
  loadSdk: () => Promise<CursorSdk> = loadCursorSdk
): Promise<{ apiKey: string; email: string }> {
  const sdk = await loadSdk()
  const result = await sdk.Cursor.auth.login({
    apiKeyName: 'TNotes Desk',
    openBrowser: openUrl,
    store: null
  })
  return { apiKey: result.apiKey, email: result.email ?? '' }
}
