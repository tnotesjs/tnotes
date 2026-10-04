import { describe, expect, it } from 'vitest'

import { horizontalStop, verticalStopLine } from './commands'

const allVisible = () => true

describe('verticalStopLine', () => {
  it('keeps a wrap that stays on the same source line', () => {
    expect(verticalStopLine(5, 5, true, 40, allVisible)).toBeNull()
  })

  it('keeps a move that already lands on the next source line', () => {
    expect(verticalStopLine(12, 13, true, 40, allVisible)).toBeNull()
    expect(verticalStopLine(14, 13, false, 40, allVisible)).toBeNull()
  })

  it('stops on the skipped heading instead of the card after it', () => {
    expect(verticalStopLine(12, 14, true, 40, allVisible)).toBe(13)
    expect(verticalStopLine(24, 36, true, 40, allVisible)).toBe(25)
  })

  it('walks back onto the line that downward motion skipped', () => {
    expect(verticalStopLine(36, 24, false, 40, allVisible)).toBe(35)
    expect(verticalStopLine(14, 12, false, 40, allVisible)).toBe(13)
  })

  it('crosses a hidden run and lands on the next visible line', () => {
    const hidden = new Set([27, 28, 29, 30, 31, 32, 33, 34, 35])
    expect(verticalStopLine(26, 36, true, 40, (line) => !hidden.has(line))).toBeNull()
    expect(verticalStopLine(26, 40, true, 40, (line) => !hidden.has(line))).toBe(36)
  })

  it('steps into a visible card instead of jumping past it', () => {
    const card = new Set([15, 16, 17, 18, 19])
    expect(verticalStopLine(14, 20, true, 40, (line) => !card.has(line) || line === 15)).toBe(15)
  })

  it('lets a visible character move through, and skips a hidden fence', () => {
    const hidden = new Set([10, 11, 12])
    const restable = (pos: number) => !hidden.has(pos)
    expect(horizontalStop([4], restable)).toBe('default')
    expect(horizontalStop([12, 11, 10, 9], restable)).toBe(9)
    expect(horizontalStop([12, 11], restable)).toBe('stay')
  })

  it('skips a zero-height fence and does not follow a backward jump', () => {
    const fence = new Set([7, 10])
    const visible = (line: number) => !fence.has(line)
    expect(verticalStopLine(6, 8, true, 40, visible)).toBeNull()
    expect(verticalStopLine(7, 1, true, 40, visible)).toBe(8)
    expect(verticalStopLine(10, 1, false, 40, visible)).toBe(9)
  })
})
