import type { AgentChatMessage, AgentNoteContext } from '../../shared/contracts'

const MAX_ROUNDS = 6
const MAX_NOTE_CHARS = 120_000

interface ToolCall {
  id: string
  function: { name: string; arguments: string | Record<string, unknown> }
}

interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface AgentChatInput {
  baseUrl: string
  apiKey: string
  model: string
  messages: AgentChatMessage[]
  note: AgentNoteContext | null
  signal: AbortSignal
  applyEdit: (edit: { oldString: string; newString: string }) => Promise<{ ok: boolean; message: string }>
  /** 每次真正发出请求时回调。只给地址和模型，不给密钥。 */
  onRequest?: (info: { url: string; model: string }) => void
}

function noteBlock(note: AgentNoteContext | null): string {
  if (!note) return '当前没有打开笔记。不要调用替换工具。'
  const body =
    note.content.length > MAX_NOTE_CHARS
      ? `${note.content.slice(0, MAX_NOTE_CHARS)}\n\n…（笔记过长，只给了开头）`
      : note.content
  const selection = note.selection ? note.selection : '（没有选区）'
  return [
    `标题：${note.title}`,
    `路径：${note.path}`,
    `选区：\n${selection}`,
    `全文：\n${body}`
  ].join('\n')
}

function systemPrompt(input: { model: string; baseUrl: string }, note: AgentNoteContext | null): string {
  return [
    '你是 TNotes Desk 里的写作助手，帮用户改当前打开的这篇 Markdown 笔记。',
    `这次调用的模型名是「${input.model}」，接口是 ${endpoint(input.baseUrl)}。`,
    '用户问你是什么模型时，只按上面的模型名回答，不要自称 Claude、GPT 或其他名字。',
    '笔记的磁盘内容就是 Markdown 本身。改内容时调用 replace_in_note，不要把整篇笔记贴回对话里。',
    'old_string 必须和笔记里的字符完全一致，并且在全文里只出现一次；改完用一两句话说明你改了什么。',
    '用户没让你改笔记时，只回答，不要调用工具。',
    '',
    noteBlock(note)
  ].join('\n')
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'replace_in_note',
      description: '把当前笔记里唯一的一段原文替换成新文本。',
      parameters: {
        type: 'object',
        properties: {
          old_string: { type: 'string', description: '笔记里原样存在、且只出现一次的文本' },
          new_string: { type: 'string', description: '替换后的文本，可以是空字符串（表示删除）' }
        },
        required: ['old_string', 'new_string']
      }
    }
  }
]

function readReplaceArgs(raw: string | Record<string, unknown> | undefined): {
  old_string: string
  new_string: string
} {
  let value: Record<string, unknown> = {}
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as Record<string, unknown>
    } catch {
      value = {}
    }
  } else if (raw && typeof raw === 'object') {
    value = raw
  }
  return {
    old_string: typeof value.old_string === 'string' ? value.old_string : '',
    new_string: typeof value.new_string === 'string' ? value.new_string : ''
  }
}

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return `${trimmed}/chat/completions`
}

async function complete(input: AgentChatInput, messages: ApiMessage[]): Promise<ApiMessage> {
  const url = endpoint(input.baseUrl)
  input.onRequest?.({ url, model: input.model })
  const response = await fetch(url, {
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
      temperature: 0.2
    })
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`模型接口返回 ${response.status}：${text.slice(0, 400)}`)
  }
  let parsed: { choices?: Array<{ message?: ApiMessage }> }
  try {
    parsed = JSON.parse(text) as { choices?: Array<{ message?: ApiMessage }> }
  } catch {
    throw new Error('模型接口没有返回 JSON')
  }
  const message = parsed.choices?.[0]?.message
  if (!message) throw new Error('模型接口没有返回内容')
  return message
}

export async function runAgentChat(input: AgentChatInput): Promise<{ reply: string; edits: number }> {
  const messages: ApiMessage[] = [
    { role: 'system', content: systemPrompt(input, input.note) },
    ...input.messages.map((message) => ({ role: message.role, content: message.content }))
  ]
  let edits = 0
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const message = await complete(input, messages)
    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      return { reply: message.content?.trim() || '（模型没有返回文字）', edits }
    }
    messages.push(message)
    for (const call of calls) {
      let result: { ok: boolean; message: string }
      if (call.function?.name !== 'replace_in_note') {
        result = { ok: false, message: `不认识的工具：${call.function?.name ?? '未命名'}` }
      } else if (!input.note) {
        result = { ok: false, message: '没有打开笔记，不能修改' }
      } else {
        const args = readReplaceArgs(call.function.arguments)
        result = await input.applyEdit({
          oldString: args.old_string,
          newString: args.new_string
        })
        if (result.ok) edits += 1
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.ok ? `已写入编辑器，等用户接受或撤销。${result.message}` : result.message
      })
    }
  }
  return { reply: '这轮修改步骤太多，先停在这里。请看编辑器里已经标出的改动。', edits }
}
