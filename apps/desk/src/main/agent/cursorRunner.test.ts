import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { cursorPrompt, runCursorTurn, type CursorSdk, type CursorTurnInput } from './cursorRunner'

type Options = {
  apiKey?: string
  model?: { id: string }
  tools?: string[]
  local?: {
    cwd?: string
    settingSources?: string[]
    customTools?: Record<string, { execute: (args: Record<string, unknown>, context: { toolCallId?: string }) => Promise<unknown> }>
  }
}

type Delta = { update: { type: string; text?: string } }

function fakeSdk(script: {
  onSend?: (options: Options, onDelta: (delta: Delta) => void) => Promise<void>
  status?: 'finished' | 'error' | 'cancelled'
  createError?: Error
  hang?: boolean
}) {
  const created: Options[] = []
  const dispose = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  let release: (() => void) | null = null
  const sdk = {
    Agent: {
      create: vi.fn(async (options: Options) => {
        if (script.createError) throw script.createError
        created.push(options)
        return {
          [Symbol.asyncDispose]: dispose,
          send: vi.fn(async (_message: unknown, sendOptions: { onDelta: (delta: Delta) => void }) => {
            await script.onSend?.(options, sendOptions.onDelta)
            let cancelled = false
            cancel.mockImplementation(async () => {
              cancelled = true
              release?.()
            })
            return {
              cancel,
              stream: async function* () {
                if (script.hang) await new Promise<void>((resolve) => (release = resolve))
              },
              wait: async () => ({ id: 'run-1', status: cancelled ? 'cancelled' : (script.status ?? 'finished'), error: { message: '模型出错' } })
            }
          })
        }
      })
    }
  }
  return { sdk: sdk as unknown as CursorSdk, created, dispose, cancel }
}

function input(overrides: Partial<CursorTurnInput> = {}): CursorTurnInput {
  return {
    apiKey: 'key',
    model: 'composer-2.5',
    mode: 'agent',
    messages: [
      { role: 'user', content: '之前的问题' },
      { role: 'assistant', content: '之前的回答' },
      { role: 'user', content: '把第一句改掉' }
    ],
    knowledgeBaseName: 'test',
    current: null,
    signal: new AbortController().signal,
    sandboxDir: mkdtempSync(join(tmpdir(), 'cursor-runner-')),
    executeTool: vi.fn(async () => ({ ok: true, summary: '已修改', detail: '已修改 1 处' })),
    ...overrides
  }
}

describe('runCursorTurn', () => {
  it('只给 Desk 的笔记工具，关掉自带工具，在空沙盒里跑，并把文字和思考推给界面', async () => {
    const fake = fakeSdk({
      onSend: async (options, onDelta) => {
        onDelta({ update: { type: 'thinking-delta', text: '想一下' } })
        await options.local!.customTools!.edit_note.execute({ note: '0001', old_string: 'a', new_string: 'b' }, { toolCallId: 'call-1' })
        onDelta({ update: { type: 'text-delta', text: '改好了' } })
      }
    })
    const onText = vi.fn()
    const onReasoning = vi.fn()
    const turn = input({ onText, onReasoning })
    const result = await runCursorTurn({ ...turn, loadSdk: async () => fake.sdk })

    const options = fake.created[0]
    expect(options.tools).toEqual(['mcp'])
    expect(options.model).toEqual({ id: 'composer-2.5' })
    expect(options.local?.cwd).toBe(turn.sandboxDir)
    expect(options.local?.settingSources).toEqual([])
    expect(Object.keys(options.local?.customTools ?? {})).toEqual([
      'list_notes',
      'search_notes',
      'read_note',
      'edit_note',
      'create_note'
    ])
    expect(turn.executeTool).toHaveBeenCalledWith({
      id: 'call-1',
      name: 'edit_note',
      args: { note: '0001', old_string: 'a', new_string: 'b' }
    })
    expect(onReasoning).toHaveBeenCalledWith('想一下')
    expect(onText).toHaveBeenCalledWith('改好了')
    expect(result).toEqual({ reply: '改好了', edits: 1, truncated: false })
    expect(fake.dispose).toHaveBeenCalledOnce()
    expect(readdirSync(turn.sandboxDir)).toEqual([])
  })

  it('问答模式只给读工具', async () => {
    const fake = fakeSdk({})
    await runCursorTurn({ ...input({ mode: 'ask' }), loadSdk: async () => fake.sdk })
    expect(Object.keys(fake.created[0].local?.customTools ?? {})).toEqual(['list_notes', 'search_notes', 'read_note'])
  })

  it('停止时取消这一轮并释放 Agent', async () => {
    const fake = fakeSdk({ hang: true })
    const controller = new AbortController()
    const running = runCursorTurn({ ...input({ signal: controller.signal }), loadSdk: async () => fake.sdk })
    await vi.waitFor(() => expect(fake.created).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(running).rejects.toThrow('已停止')
    expect(fake.cancel).toHaveBeenCalled()
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('密钥无效时提示重新登录，执行失败时带上原因', async () => {
    const auth = fakeSdk({ createError: new Error('Invalid User API Key') })
    await expect(runCursorTurn({ ...input(), loadSdk: async () => auth.sdk })).rejects.toThrow('重新登录 Cursor')
    const unknown = fakeSdk({
      createError: new Error('Cannot use this model: no-such-model. Available models: default, composer-2.5, gpt-5.5. Use Cursor.models.list() to discover valid selections.')
    })
    const unknownError = await runCursorTurn({ ...input(), loadSdk: async () => unknown.sdk }).catch((error: Error) => error.message)
    expect(unknownError).toBe('Cursor 没有模型「no-such-model」。打开设置 → 内置 Agent，点「读取模型」重新选。')
    const dotted = fakeSdk({ createError: new Error('Cannot use this model: gpt-9.9. Available models: default.') })
    expect(await runCursorTurn({ ...input(), loadSdk: async () => dotted.sdk }).catch((error: Error) => error.message)).toContain('「gpt-9.9」')
    const failed = fakeSdk({ status: 'error' })
    await expect(runCursorTurn({ ...input(), loadSdk: async () => failed.sdk })).rejects.toThrow('Cursor Agent 执行失败：模型出错')
    expect(failed.dispose).toHaveBeenCalledOnce()
  })

  it('提示词带上 Desk 规则、之前的对话和这一轮的话', () => {
    const prompt = cursorPrompt(input())
    expect(prompt).toContain('TNotes Desk')
    expect(prompt).toContain('custom-user-tools')
    expect(prompt).toContain('用户：之前的问题')
    expect(prompt).toContain('助手：之前的回答')
    expect(prompt.trim().endsWith('把第一句改掉')).toBe(true)
  })
})
