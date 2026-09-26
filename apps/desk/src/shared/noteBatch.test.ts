import { describe, expect, it } from 'vitest'

import { batchNoteCountError, maxBatchNoteCount, remainingNoteSlots } from './noteBatch'

describe('批量新建笔记数量', () => {
  it('剩余名额是 9999 减去当前篇数', () => {
    expect(remainingNoteSlots(0)).toBe(9999)
    expect(remainingNoteSlots(12)).toBe(9987)
    expect(remainingNoteSlots(9999)).toBe(0)
    expect(remainingNoteSlots(10000)).toBe(0)
  })

  it('一次最多 999，剩余更少时用剩余名额', () => {
    expect(maxBatchNoteCount(0)).toBe(999)
    expect(maxBatchNoteCount(3817)).toBe(999)
    expect(maxBatchNoteCount(9000)).toBe(999)
    expect(maxBatchNoteCount(9001)).toBe(998)
    expect(maxBatchNoteCount(9998)).toBe(1)
    expect(maxBatchNoteCount(9999)).toBe(0)
  })

  it('默认 1 合法，超出动态上限或不是整数则拒绝', () => {
    expect(batchNoteCountError('1', 12)).toBeNull()
    expect(batchNoteCountError('999', 12)).toBeNull()
    expect(batchNoteCountError('1000', 12)).toBe('请输入 1 到 999 的整数')
    expect(batchNoteCountError('499', 9500)).toBeNull()
    expect(batchNoteCountError('500', 9500)).toBe('请输入 1 到 499 的整数')
    expect(batchNoteCountError('0', 12)).toBe('请输入 1 到 999 的整数')
    expect(batchNoteCountError(0, 12)).toBe('请输入 1 到 999 的整数')
    expect(batchNoteCountError('1.5', 12)).toBe('请输入 1 到 999 的整数')
    expect(batchNoteCountError(1.5, 12)).toBe('请输入 1 到 999 的整数')
    expect(batchNoteCountError(2, 12)).toBeNull()
    expect(batchNoteCountError('', 12)).toBe('请输入 1 到 999 的整数')
    expect(batchNoteCountError('1', 9999)).toBe('笔记数量已达 9999，无法继续新建')
  })
})