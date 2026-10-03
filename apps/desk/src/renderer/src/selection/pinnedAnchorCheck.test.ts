// 固定上下文锚点的位置判据（跨视图 / 磁盘）：只认"同一偏移范围上还是不是同一段文字"，
// 所以"A 前插入内容 → 坐标变化"会失效、别处的相同文字不能顶替原位置。
import { describe, expect, it } from 'vitest'

import { validateTextAnchor } from './pinnedAnchorCheck'

import type { PinnedSelectionAnchor } from '../../../shared/contracts'

describe('位置判据（跨视图 / 磁盘复核）', () => {
  const anchor: PinnedSelectionAnchor = {
    view: 'visual',
    kind: 'block',
    textRange: { startOffset: 3, endOffset: 10, expected: 'AAA BBB' }
  }

  it('同一范围仍是同一段文字 → 有效', () => {
    expect(validateTextAnchor('头部：AAA BBB 尾巴', anchor)).toEqual({ valid: true })
  })

  it('前方插入内容让坐标变化 → 失效（不是全文搜到就算）', () => {
    const shifted = '插入了一段。头部：AAA BBB 尾巴'
    const result = validateTextAnchor(shifted, anchor)
    expect(result?.valid).toBe(false)
  })

  it('原位置被删除、别处仍有相同文字 → 失效', () => {
    const replaced = '头部：XXXXXX 尾巴，后面还有 AAA BBB'
    const result = validateTextAnchor(replaced, anchor)
    expect(result?.valid).toBe(false)
  })

  it('只改原位置后方 → 保留', () => {
    expect(validateTextAnchor('头部：AAA BBB 尾巴（后面加了字）', anchor)).toEqual({ valid: true })
  })

  it('没有位置锚 → 返回 null（上层应当保守失效，而不是全文搜索）', () => {
    expect(validateTextAnchor('随便什么', { view: 'visual', kind: 'block' })).toBeNull()
  })
})
