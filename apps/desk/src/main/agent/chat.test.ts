import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { deleteAgentChat, listAgentChats, saveAgentChat, setAgentChatRootForTests } from './chats'
import { runAgentChat } from './chat'

import type { AgentStoredChat } from '../../shared/contracts'

const chat: AgentStoredChat = {
  id: 'c1',
  title: '第一句',
  updatedAt: '2026-09-25T00:00:00.000Z',
  mode: 'agent',
  messages: [{ role: 'user', content: '你好' }]
}

describe('agent chats', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-chats-'))
  afterEach(() => setAgentChatRootForTests(null))

  it('saves, lists and deletes a chat per workspace without touching the knowledge bases', () => {
    setAgentChatRootForTests(root)
    saveAgentChat('/work/kbs', chat)
    expect(listAgentChats('/work/kbs').map((item) => item.id)).toEqual(['c1'])
    expect(listAgentChats('/work/other')).toEqual([])
    expect(deleteAgentChat('/work/kbs', 'c1')?.id).toBe('c1')
    expect(listAgentChats('/work/kbs')).toEqual([])
  })
})

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    })
  )
}

const base = {
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'test',
  model: 'mock',
  knowledgeBaseName: 'test'
}

describe('agent loop', () => {
  it('streams text, runs one tool, then returns the final reply', async () => {
    const bodies: string[] = []
    const calls: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      if (bodies.length === 1) {
        return sse([
          'data: {"choices":[{"delta":{"content":"我来改"}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"edit_note","arguments":"{\\"old_string\\":\\"a\\",\\"new_string\\":\\"b\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n'
        ])
      }
      return sse(['data: {"choices":[{"delta":{"content":"改好了"}}]}\n\n', 'data: [DONE]\n\n'])
    }) as typeof fetch
    const result = await runAgentChat({
      ...base,
      mode: 'agent',
      messages: [{ role: 'user', content: '把 a 改成 b' }],
      notes: [
        {
          knowledgeBaseId: 'kb',
          knowledgeBaseName: 'test',
          noteUuid: 'note-a',
          noteIndex: '0001',
          title: '笔记',
          path: 'notes/a.md',
          lines: 1,
          content: 'a'
        }
      ],
      defaultNote: { knowledgeBaseId: 'kb', noteUuid: 'note-a' },
      signal: new AbortController().signal,
      fetchImpl,
      executeTool: async (call) => {
        calls.push(call.name)
        return { ok: true, summary: '已改', detail: 'done' }
      }
    })
    expect(calls).toEqual(['edit_note'])
    expect(result).toEqual({ reply: '改好了', edits: 1, truncated: false })
    const system = JSON.parse(bodies[0]).messages[0].content as string
    expect(system).toContain('点名的笔记：test · 0001 笔记')
    expect(system).toContain('edit_note 省略 note 时改 uuid 为 note-a')
    expect(JSON.parse(bodies[0]).reasoning_effort).toBeUndefined()
  })

  it('sends images on the current message and reasoning_effort when asked', async () => {
    const bodies: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return sse(['data: {"choices":[{"delta":{"content":"看到了"}}]}\n\n', 'data: [DONE]\n\n'])
    }) as typeof fetch
    await runAgentChat({
      ...base,
      mode: 'ask',
      reasoningEffort: 'high',
      messages: [
        { role: 'user', content: '旧消息\n[图片]' },
        { role: 'assistant', content: '好' },
        { role: 'user', content: '这是什么', imageUrls: ['data:image/jpeg;base64,AAAA'] }
      ],
      signal: new AbortController().signal,
      fetchImpl,
      executeTool: async () => ({ ok: false, summary: '', detail: '' })
    })
    const body = JSON.parse(bodies[0])
    expect(body.reasoning_effort).toBe('high')
    expect(body.messages[1].content).toBe('旧消息\n[图片]')
    expect(body.messages[3].content).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
    ])
  })

  it('keeps the text when the model hits the length limit', async () => {
    const fetchImpl = (async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"写到一半"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n'
      ])) as typeof fetch
    const result = await runAgentChat({
      ...base,
      mode: 'agent',
      messages: [{ role: 'user', content: '写长一点' }],
      signal: new AbortController().signal,
      fetchImpl,
      executeTool: async () => ({ ok: false, summary: '', detail: '' })
    })
    expect(result.truncated).toBe(true)
    expect(result.reply).toContain('写到一半')
    expect(result.reply).toContain('继续')
  })

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController()
    const fetchImpl = (() => {
      controller.abort()
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    }) as typeof fetch
    await expect(
      runAgentChat({
        ...base,
        mode: 'ask',
        messages: [{ role: 'user', content: '只看看' }],
        signal: controller.signal,
        fetchImpl,
        executeTool: async () => ({ ok: false, summary: '', detail: '' })
      })
    ).rejects.toThrow(/aborted|AbortError/)
  })
})
