import { describe, expect, it } from 'vitest'

import {
  MAX_EXPAND_LEVEL,
  MIN_EXPAND_LEVEL,
  acceptsExpandLevelEdit,
  normalizeExpandLevel,
  resolvedExpandLevel,
  stepExpandLevel
} from './expandLevel'

/**
 * The level field holds at most two digits, so the clamp is part of the contract:
 * the input, the arrow-key stepping and the fence parser all lean on it.
 */
describe('normalizeExpandLevel', () => {
  it('keeps everything in 1–99 as-is', () => {
    for (const level of [1, 2, 9, 10, 37, 98, 99]) {
      expect(normalizeExpandLevel(level)).toBe(level)
    }
  })

  it('clamps to the two-digit range', () => {
    expect(normalizeExpandLevel(0)).toBe(1)
    expect(normalizeExpandLevel(-3)).toBe(1)
    expect(normalizeExpandLevel(100)).toBe(99)
    expect(normalizeExpandLevel(4200)).toBe(99)
    expect(normalizeExpandLevel(Number.NaN)).toBe(1)
    expect(normalizeExpandLevel(2.7)).toBe(2)
  })

  it('exposes the bounds the field is built from', () => {
    expect(MIN_EXPAND_LEVEL).toBe(1)
    expect(MAX_EXPAND_LEVEL).toBe(99)
  })
})

describe('level field editing rules', () => {
  it('accepts one or two digits with no leading zero', () => {
    for (const text of ['', '1', '9', '10', '42', '99']) {
      expect(acceptsExpandLevelEdit(text), text).toBe(true)
    }
  })

  it('refuses everything else', () => {
    // A leading zero is below the range / not how a level is written; a third
    // digit is out of range; letters and symbols are never numbers.
    for (const text of ['0', '07', '00', '100', '123', 'a', '1a', '-1', '1.5']) {
      expect(acceptsExpandLevelEdit(text), text).toBe(false)
    }
  })

  it('steps within 1–99 only', () => {
    expect(stepExpandLevel(5, 1)).toBe(6)
    expect(stepExpandLevel(5, -1)).toBe(4)
    expect(stepExpandLevel(MAX_EXPAND_LEVEL, 1)).toBe(99)
    expect(stepExpandLevel(MIN_EXPAND_LEVEL, -1)).toBe(1)
  })

  it('drops the previous value back when editing ends empty', () => {
    expect(resolvedExpandLevel('', 37)).toBe(37)
    expect(resolvedExpandLevel('7', 37)).toBe(7)
    expect(resolvedExpandLevel('0', 37)).toBe(1)
  })
})
