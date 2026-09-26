/** 与知识库编号上限一致：笔记总数不超过 9999，一次新建不超过 999。 */
export const NOTE_COUNT_LIMIT = 9999
export const NOTE_BATCH_LIMIT = 999

/** 剩余可新建篇数 = 9999 - 当前笔记数量。 */
export function remainingNoteSlots(noteCount: number): number {
  const count = Number.isFinite(noteCount) ? Math.max(0, Math.floor(noteCount)) : 0
  return Math.max(0, NOTE_COUNT_LIMIT - count)
}

/**
 * 这次对话框允许的最大篇数。
 * 剩余名额够大时停在 999，否则停在剩余名额。
 */
export function maxBatchNoteCount(noteCount: number): number {
  return Math.min(NOTE_BATCH_LIMIT, remainingNoteSlots(noteCount))
}

export function batchNoteCountError(raw: string | number, noteCount: number): string | null {
  const max = maxBatchNoteCount(noteCount)
  if (max < 1) return `笔记数量已达 ${NOTE_COUNT_LIMIT}，无法继续新建`
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) return `请输入 1 到 ${max} 的整数`
  const value = Number(text)
  if (value < 1 || value > max) return `请输入 1 到 ${max} 的整数`
  return null
}
