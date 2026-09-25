import { describe, expect, it } from 'vitest'

import { locateUniqueReplace } from '../../shared/agentReplace'

describe('locateUniqueReplace', () => {
  const note = '闭包是函数和其词法环境的组合。\n函数可以再出现一次。'

  it('定位唯一原文', () => {
    expect(locateUniqueReplace(note, '词法环境')).toEqual({ from: 7, to: 11 })
  })

  it('原文不存在时拒绝', () => {
    expect(locateUniqueReplace(note, '作用域')).toEqual({ error: '笔记里没有这段原文' })
  })

  it('重复原文拒绝，避免改错位置', () => {
    const result = locateUniqueReplace(note, '函数')
    expect(result).toEqual({
      error: '这段原文出现了多次，需要带上更多上下文，让它只匹配一处'
    })
  })
})
