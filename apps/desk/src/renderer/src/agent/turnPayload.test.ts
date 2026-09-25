import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'

import { agentTurnPayload } from './turnPayload'

describe('agentTurnPayload', () => {
  it('strips Vue proxies so Electron can clone the request', () => {
    const messages = reactive([{ role: 'user' as const, content: '你好' }])
    const note = reactive({
      title: '两数之和',
      path: 'notes/0001.md',
      content: '正文',
      selection: ''
    })
    const payload = agentTurnPayload(messages, note)
    expect(payload.messages[0]).not.toBe(messages[0])
    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload).toEqual({
      messages: [{ role: 'user', content: '你好' }],
      note: { title: '两数之和', path: 'notes/0001.md', content: '正文', selection: '' }
    })
  })
})
