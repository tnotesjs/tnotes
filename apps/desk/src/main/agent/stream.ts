/** OpenAI 兼容接口的 SSE 增量。纯函数，方便单测。 */

export interface ToolCallAcc {
  id: string
  name: string
  arguments: string
}

export interface MessageAcc {
  content: string
  reasoning: string
  toolCalls: ToolCallAcc[]
  finishReason: string
}

export function emptyMessage(): MessageAcc {
  return { content: '', reasoning: '', toolCalls: [], finishReason: '' }
}

/** 把缓冲区切成完整的 SSE 事件，留下未结束的尾巴。 */
export function consumeSse(buffer: string): { data: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  const data: string[] = []
  for (const part of parts) {
    const lines = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
    if (lines.length > 0) data.push(lines.join('\n'))
  }
  return { data, rest }
}

interface StreamDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

export function applyChoiceDelta(acc: MessageAcc, delta: StreamDelta | undefined): void {
  if (!delta) return
  if (typeof delta.content === 'string') acc.content += delta.content
  if (typeof delta.reasoning_content === 'string') acc.reasoning += delta.reasoning_content
  for (const call of delta.tool_calls ?? []) {
    const index = call.index ?? acc.toolCalls.length
    while (acc.toolCalls.length <= index) acc.toolCalls.push({ id: '', name: '', arguments: '' })
    const slot = acc.toolCalls[index]
    if (call.id) slot.id = call.id
    if (call.function?.name) slot.name += call.function.name
    if (typeof call.function?.arguments === 'string') slot.arguments += call.function.arguments
  }
}
