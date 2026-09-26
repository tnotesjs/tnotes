import type {
  AgentMode,
  AgentNoteContext,
  AgentOpenNote,
  AgentReasoningEffort,
  AgentSelectionContext
} from '../../shared/contracts'
import { applyChoiceDelta, consumeSse, emptyMessage, type MessageAcc, type ToolCallAcc } from './stream'

const MAX_ROUNDS = 10
const MAX_TOKENS = 8192

export interface AgentToolResult {
  ok: boolean
  summary: string
  detail: string
}

/** 发给模型的一条历史消息。imageUrls 只在本轮的用户消息上有（data URL）。 */
export interface AgentInputMessage {
  role: 'user' | 'assistant'
  content: string
  imageUrls?: string[]
}

export interface AgentChatInput {
  baseUrl: string
  apiKey: string
  model: string
  reasoningEffort?: AgentReasoningEffort | ''
  mode: AgentMode
  messages: AgentInputMessage[]
  knowledgeBaseName?: string
  current?: AgentOpenNote | null
  notes?: AgentNoteContext[]
  selections?: AgentSelectionContext[]
  defaultNote?: { knowledgeBaseId: string; noteUuid: string } | null
  signal: AbortSignal
  fetchImpl?: typeof fetch
  executeTool: (call: { id: string; name: string; args: Record<string, unknown> }) => Promise<AgentToolResult>
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onRequest?: (info: { url: string; model: string; reasoningEffort: string }) => void
}

type ApiContent = string | null | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ApiContent
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

const KB_PARAM = { type: 'string', description: '知识库 id 或名称。省略表示本轮的默认知识库' }

export const READ_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_notes',
      description: '列出一个知识库的笔记（编号、标题、uuid）。offset 从 0 起，limit 默认 200。query 按编号或标题过滤。',
      parameters: {
        type: 'object',
        properties: {
          kb: KB_PARAM,
          offset: { type: 'number' },
          limit: { type: 'number' },
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: '在一个知识库里搜索笔记，最多 10 条。',
      parameters: {
        type: 'object',
        properties: {
          kb: KB_PARAM,
          query: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: '按行读取一篇笔记。note 可以是 uuid、编号、相对路径或标题。offset 是起始行（从 1 开始），limit 是行数，默认 400，最多 800。',
      parameters: {
        type: 'object',
        properties: {
          kb: KB_PARAM,
          note: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' }
        },
        required: ['note']
      }
    }
  }
]

export const WRITE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'edit_note',
      description:
        '修改一篇笔记。默认用 old_string 替换唯一的一段原文。要追加到正文末尾时传 position:"end" 和 new_string，不要传 old_string。改动会直接保存到磁盘（笔记里用户没保存的编辑也会一起保存），并标出来等用户保留或撤销。',
      parameters: {
        type: 'object',
        properties: {
          kb: KB_PARAM,
          note: { type: 'string', description: 'uuid、编号、路径或标题' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          position: { type: 'string', enum: ['end'], description: 'end 表示追加到正文末尾' }
        },
        required: ['new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: '在一个知识库里新建一篇笔记并保存。正文会标出来等用户保留或撤销。',
      parameters: {
        type: 'object',
        properties: {
          kb: KB_PARAM,
          title: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['title', 'content']
      }
    }
  }
]

function endpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
}

function noteName(note: { knowledgeBaseName: string; noteIndex: string; title: string }): string {
  return `${note.knowledgeBaseName} · ${note.noteIndex ? `${note.noteIndex} ` : ''}${note.title}`
}

function contextBlock(input: Pick<AgentChatInput, 'current' | 'notes' | 'selections'>): string {
  const lines: string[] = []
  const current = input.current
  lines.push(
    current
      ? `用户当前打开：${noteName(current)}（知识库 id ${current.knowledgeBaseId}，uuid ${current.noteUuid}）。用户说「这篇」通常指它，需要时用 read_note 读。`
      : '用户当前没有打开笔记。'
  )
  for (const note of input.notes ?? []) {
    lines.push(
      '',
      `点名的笔记：${noteName(note)}`,
      `知识库 id：${note.knowledgeBaseId}，uuid：${note.noteUuid}，路径：${note.path}，共 ${note.lines} 行`,
      note.content ? `全文：\n${note.content}` : '这篇较长，没有附上全文。需要时用 read_note 按行分段读取。'
    )
  }
  for (const selection of input.selections ?? []) {
    lines.push(
      '',
      `选区（${noteName(selection)}，第 ${selection.startLine}–${selection.endLine} 行；知识库 id ${selection.knowledgeBaseId}，uuid ${selection.noteUuid}）。用户说「选中的内容」就是这一段；改写时 old_string 用这段原文，不要再读全文：`,
      selection.text
    )
  }
  return lines.join('\n')
}

export function systemPrompt(
  input: Pick<AgentChatInput, 'model' | 'mode' | 'knowledgeBaseName' | 'current' | 'notes' | 'selections' | 'defaultNote'>
): string {
  const kbName = input.knowledgeBaseName || '当前知识库'
  const defaultNote = input.defaultNote
    ? `edit_note 省略 note 时改 uuid 为 ${input.defaultNote.noteUuid} 的那篇（知识库 id ${input.defaultNote.knowledgeBaseId}）。`
    : 'edit_note 必须写明 note。'
  return [
    '你是 TNotes Desk 里的写作助手。笔记是 Markdown，磁盘文件就是真相。',
    `模型名是「${input.model}」。用户问你是什么模型时，只按这个名字回答。`,
    `工作区里有多个知识库。工具都有可选参数 kb（知识库 id 或名称），省略时是「${kbName}」。读写其他知识库的笔记时必须写 kb。`,
    input.mode === 'ask'
      ? '现在是只读模式：只能列目录、搜索和阅读，不要调用 edit_note 或 create_note。'
      : `需要改笔记时调用工具。old_string 必须和原文完全一致且只出现一次。追加到末尾用 position:"end"，只传 new_string。${defaultNote}没让你改时只回答。`,
    '不要把整篇笔记贴回对话。改完用一两句话说明改了什么。',
    '',
    contextBlock(input)
  ].join('\n')
}

function toApiMessage(message: AgentInputMessage): ApiMessage {
  if (message.role !== 'user' || !message.imageUrls?.length) return { role: message.role, content: message.content }
  return {
    role: 'user',
    content: [
      { type: 'text', text: message.content },
      ...message.imageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
    ]
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function readStream(
  response: Response,
  signal: AbortSignal,
  onText?: (delta: string) => void,
  onReasoning?: (delta: string) => void
): Promise<MessageAcc> {
  const acc = emptyMessage()
  const reader = response.body?.getReader()
  if (!reader) throw new Error('模型接口没有返回流')
  const decoder = new TextDecoder()
  let rest = ''
  while (!signal.aborted) {
    const chunk = await reader.read()
    if (chunk.done) break
    rest += decoder.decode(chunk.value, { stream: true })
    const consumed = consumeSse(rest)
    rest = consumed.rest
    for (const data of consumed.data) {
      if (data.trim() === '[DONE]') return acc
      const parsed = JSON.parse(data) as {
        choices?: Array<{ finish_reason?: string | null; delta?: Parameters<typeof applyChoiceDelta>[1] }>
      }
      const choice = parsed.choices?.[0]
      if (choice?.finish_reason) acc.finishReason = choice.finish_reason
      const before = acc.content.length
      const reasonBefore = acc.reasoning.length
      applyChoiceDelta(acc, choice?.delta)
      if (acc.content.length > before) onText?.(acc.content.slice(before))
      if (acc.reasoning.length > reasonBefore) onReasoning?.(acc.reasoning.slice(reasonBefore))
    }
  }
  return acc
}

export async function runAgentChat(input: AgentChatInput): Promise<{ reply: string; edits: number; truncated: boolean }> {
  const url = endpoint(input.baseUrl)
  const tools = input.mode === 'ask' ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS]
  const messages: ApiMessage[] = [{ role: 'system', content: systemPrompt(input) }, ...input.messages.map(toApiMessage)]
  let edits = 0
  const fetchImpl = input.fetchImpl ?? fetch
  const effort = input.reasoningEffort || ''
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    input.onRequest?.({ url, model: input.model, reasoningEffort: effort })
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify({
        model: input.model,
        messages,
        tools,
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        stream: true,
        ...(effort ? { reasoning_effort: effort } : {})
      })
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`模型接口返回 ${response.status}：${text.slice(0, 400)}`)
    }
    const message = await readStream(response, input.signal, input.onText, input.onReasoning)
    const calls = message.toolCalls.filter((call) => call.name)
    if (calls.length === 0) {
      const truncated = message.finishReason === 'length'
      const reply = message.content.trim()
      if (truncated) {
        return {
          reply: reply ? `${reply}\n\n回复被截断，可以说「继续」。` : '回复被截断，可以说「继续」。',
          edits,
          truncated: true
        }
      }
      return { reply: reply || '（模型没有返回文字）', edits, truncated: false }
    }
    messages.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: calls.map((call) => ({
        id: call.id || call.name,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' }
      }))
    })
    for (const call of calls) {
      const result = await input.executeTool({
        id: call.id || call.name,
        name: call.name,
        args: parseArgs(call.arguments)
      })
      if (result.ok && (call.name === 'edit_note' || call.name === 'create_note')) edits += 1
      messages.push({
        role: 'tool',
        tool_call_id: call.id || call.name,
        content: (result.ok ? result.detail : result.summary).slice(0, 16_000)
      })
    }
  }
  return { reply: '这轮步骤太多，先停在这里。请看已经标出的改动。', edits, truncated: false }
}

export type { ToolCallAcc }
