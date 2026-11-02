import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAskpassStore } from './askpass'

import type { AskpassPromptDto } from '../../../shared/contracts'

let emitRequest: (prompt: AskpassPromptDto) => void = () => {}
let emitDismiss: (id: string) => void = () => {}
const answerSpy = vi.fn(async () => ({ ok: true, value: undefined }))

function prompt(id: string, text = 'Username: '): AskpassPromptDto {
  return { id, prompt: text, secret: false, taskTitle: '推送更改', knowledgeBaseName: 'KB' }
}

beforeEach(() => {
  answerSpy.mockClear()
  ;(globalThis as unknown as { window: unknown }).window = {
    desk: {
      askpass: {
        answer: answerSpy,
        onRequest: (callback: (prompt: AskpassPromptDto) => void) => {
          emitRequest = callback
          return () => {}
        },
        onDismiss: (callback: (id: string) => void) => {
          emitDismiss = callback
          return () => {}
        }
      }
    }
  }
  setActivePinia(createPinia())
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('凭据询问队列', () => {
  it('按到达顺序逐个作答', async () => {
    const store = useAskpassStore()
    store.subscribe()
    emitRequest(prompt('a'))
    emitRequest(prompt('b', 'Password: '))
    expect(store.current?.id).toBe('a')
    await store.answer('alice')
    expect(answerSpy).toHaveBeenCalledWith('a', 'alice')
    expect(store.current?.id).toBe('b')
    await store.answer(null)
    expect(answerSpy).toHaveBeenLastCalledWith('b', null)
    expect(store.current).toBeNull()
  })

  it('主进程撤销询问（git 退出 / 任务取消）时关掉对应的框', () => {
    const store = useAskpassStore()
    store.subscribe()
    emitRequest(prompt('a'))
    emitDismiss('a')
    expect(store.current).toBeNull()
    expect(answerSpy).not.toHaveBeenCalled()
  })
})
