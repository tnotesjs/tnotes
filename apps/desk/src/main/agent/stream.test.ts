import { describe, expect, it } from 'vitest'

import { applyChoiceDelta, consumeSse, emptyMessage } from './stream'

describe('agent stream', () => {
  it('splits complete SSE events and keeps the tail', () => {
    const first = consumeSse('data: {"a":1}\n\ndata: {"b":')
    expect(first.data).toEqual(['{"a":1}'])
    expect(first.rest).toBe('data: {"b":')
    const second = consumeSse(`${first.rest}2}\n\n`)
    expect(second.data).toEqual(['{"b":2}'])
  })

  it('accumulates text and tool call fragments by index', () => {
    const acc = emptyMessage()
    applyChoiceDelta(acc, { content: '你' })
    applyChoiceDelta(acc, {
      tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_', arguments: '{"note":' } }]
    })
    applyChoiceDelta(acc, {
      content: '好',
      tool_calls: [{ index: 0, function: { name: 'note', arguments: '"0001"}' } }]
    })
    expect(acc.content).toBe('你好')
    expect(acc.toolCalls[0]).toEqual({
      id: 'call-1',
      name: 'read_note',
      arguments: '{"note":"0001"}'
    })
  })
})
