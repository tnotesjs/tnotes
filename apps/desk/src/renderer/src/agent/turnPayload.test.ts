import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'

import { agentTurnPayload, clipSelection, defaultNoteFor, inlineNotes, SELECTION_CLIPPED, trimHistory } from './turnPayload'

import type { AgentNoteContext } from '../../../shared/contracts'

const note = (patch: Partial<AgentNoteContext>): AgentNoteContext => ({
  knowledgeBaseId: 'kb',
  knowledgeBaseName: 'test',
  noteUuid: 'n1',
  noteIndex: '0001',
  title: '两数之和',
  path: 'notes/0001.md',
  lines: 1,
  content: '正文',
  ...patch
})

describe('agentTurnPayload', () => {
  it('strips Vue proxies so Electron can clone the request', () => {
    const messages = reactive([{ role: 'user' as const, content: '你好', images: ['img-1'] }])
    const notes = reactive([note({})])
    const payload = agentTurnPayload({
      turnId: 't1',
      messages,
      mode: 'agent',
      knowledgeBaseId: 'kb',
      knowledgeBaseName: 'test',
      current: null,
      notes,
      selections: [],
      modelRef: 'deepseek/deepseek-flash',
      reasoningEffort: ''
    })
    expect(payload.messages[0]).not.toBe(messages[0])
    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload.messages).toEqual([{ role: 'user', content: '你好', images: ['img-1'] }])
    expect(payload.notes[0].content).toBe('正文')
    expect(payload.defaultNote).toEqual({ knowledgeBaseId: 'kb', noteUuid: 'n1' })
  })
})

describe('trimHistory', () => {
  it('keeps a 41-message chat sendable and starts with a user message', () => {
    const messages = Array.from({ length: 41 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `m${index}`
    }))
    const trimmed = trimHistory(messages)
    expect(trimmed.length).toBeLessThanOrEqual(30)
    expect(trimmed.length).toBeGreaterThan(0)
    expect(trimmed[0]?.role).toBe('user')
    expect(trimmed.at(-1)?.content).toBe('m40')
  })

  it('clips one oversized message', () => {
    const trimmed = trimHistory([{ role: 'user', content: 'x'.repeat(100_001) }])
    expect(trimmed[0]?.content).toHaveLength(100_000)
  })
})

describe('context limits', () => {
  it('clips a selection to the request limit and marks the cut', () => {
    const clipped = clipSelection('选'.repeat(20_001))
    expect(clipped.length).toBeLessThanOrEqual(20_000)
    expect(clipped.endsWith(SELECTION_CLIPPED)).toBe(true)
    expect(clipSelection('短')).toBe('短')
  })

  it('inlines mentioned notes until the budget runs out', () => {
    const result = inlineNotes([note({ noteUuid: 'a', content: 'x'.repeat(10) }), note({ noteUuid: 'b', content: 'y'.repeat(10) })], 15)
    expect(result.map((item) => item.content.length)).toEqual([10, 0])
  })
})

describe('defaultNoteFor', () => {
  it('only answers when everything points at one note', () => {
    const a = { knowledgeBaseId: 'kb', noteUuid: 'a' }
    const b = { knowledgeBaseId: 'kb2', noteUuid: 'b' }
    expect(defaultNoteFor([a], [a])).toEqual(a)
    expect(defaultNoteFor([], [b])).toEqual(b)
    expect(defaultNoteFor([a], [b])).toBeNull()
    expect(defaultNoteFor([], [])).toBeNull()
  })
})
