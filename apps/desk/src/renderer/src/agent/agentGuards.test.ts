import { describe, expect, it } from 'vitest'

import { shouldSendOnEnter } from './composerKeys'
import { eventMatchesTurn } from './turnFilter'

describe('shouldSendOnEnter', () => {
  it('does not send while an IME composition is active', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false)
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true)
  })
})

describe('eventMatchesTurn', () => {
  it('drops events from a previous turn', () => {
    expect(eventMatchesTurn('old', 'new')).toBe(false)
    expect(eventMatchesTurn('new', 'new')).toBe(true)
    expect(eventMatchesTurn('new', '')).toBe(false)
  })
})
