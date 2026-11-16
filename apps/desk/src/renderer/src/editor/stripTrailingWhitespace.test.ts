import { describe, expect, it } from 'vitest'

import { stripTrailingWhitespace } from './stripTrailingWhitespace'

describe('stripTrailingWhitespace', () => {
  it('removes spaces and tabs at the end of each line and keeps the line breaks', () => {
    expect(stripTrailingWhitespace('甲  \n乙\t\n丙\n')).toBe('甲\n乙\n丙\n')
    expect(stripTrailingWhitespace('  只有空格  ')).toBe('  只有空格')
    expect(stripTrailingWhitespace('没有')).toBe('没有')
  })
})
