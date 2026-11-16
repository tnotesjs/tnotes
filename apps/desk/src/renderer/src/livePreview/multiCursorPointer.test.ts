import { describe, expect, it } from 'vitest'

import { addsCursorOnPointerDown, isColumnSelectionGesture } from './multiCursorPointer'

const base = { altKey: false, shiftKey: false, button: 0 }

describe('multi-cursor pointer', () => {
  it('adds a cursor on option-click, not command-click', () => {
    expect(addsCursorOnPointerDown({ ...base, altKey: true })).toBe(true)
    expect(addsCursorOnPointerDown(base)).toBe(false)
    expect(addsCursorOnPointerDown({ ...base, altKey: true, shiftKey: true })).toBe(false)
    expect(addsCursorOnPointerDown({ ...base, altKey: true, button: 1 })).toBe(false)
  })

  it('uses the middle button or shift-option drag for a column selection', () => {
    expect(isColumnSelectionGesture({ ...base, button: 1 })).toBe(true)
    expect(isColumnSelectionGesture({ ...base, altKey: true, shiftKey: true })).toBe(true)
    expect(isColumnSelectionGesture({ ...base, altKey: true })).toBe(false)
    expect(isColumnSelectionGesture(base)).toBe(false)
  })
})
