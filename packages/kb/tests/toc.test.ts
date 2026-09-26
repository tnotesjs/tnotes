import { describe, expect, it } from 'vitest'

import {
  buildNoteLine,
  collectSubtreeNoteIndexes,
  findGroupLineIndex,
  findNoteLineIndex,
  flattenTocLines,
  getSubtreeRange,
  moveSubtree,
  normalizeTocBlankLines,
  parseTocLine,
  removeSelectedNoteLines,
  parseTocToTree,
  serializeTocTree,
  setNoteDoneLine,
  setNoteTitleLine
} from '../src/toc'

const SAMPLE = [
  '- 学习资料',
  '  - [x] 0017. vite 菜鸟教程',
  '  - [ ] 0011. 深入浅出 Vite',
  '- AI 生成',
  '  - Vite 基础认知',
  '    - [ ] 0019. Vite 是什么',
  '    - [x] 0020. 核心特性',
  '- pending',
  '  - [ ] 0014. vite 思维导图'
]

describe('parseTocLine', () => {
  it('parses group lines', () => {
    const parsed = parseTocLine('  - 学习资料')
    expect(parsed.kind).toBe('group')
    expect(parsed.title).toBe('学习资料')
    expect(parsed.indentLevel).toBe(1)
  })

  it('parses note lines with done state and title', () => {
    const parsed = parseTocLine('- [x] 0001. 从 0 到 1')
    expect(parsed.kind).toBe('note')
    expect(parsed.noteIndex).toBe('0001')
    expect(parsed.title).toBe('从 0 到 1')
    expect(parsed.done).toBe(true)
    expect(parsed.indentLevel).toBe(0)
  })

  it('parses note lines without title', () => {
    const parsed = parseTocLine('- [ ] 0243')
    expect(parsed.kind).toBe('note')
    expect(parsed.noteIndex).toBe('0243')
    expect(parsed.title).toBeNull()
    expect(parsed.done).toBe(false)
  })

  it('treats unrelated lines as unknown', () => {
    expect(parseTocLine('# 标题').kind).toBe('unknown')
    expect(parseTocLine('').kind).toBe('unknown')
    expect(parseTocLine('- [x] 不是笔记').kind).toBe('unknown')
    expect(parseTocLine('- [x] [0001. 标题](/notes/0001.%20标题/README)').kind).toBe('unknown')
  })
})

describe('tree', () => {
  it('builds a nested tree with group paths', () => {
    const tree = parseTocToTree(SAMPLE)
    expect(tree).toHaveLength(3)
    const ai = tree[1]
    expect(ai.kind).toBe('group')
    if (ai.kind !== 'group') throw new Error('unreachable')
    expect(ai.title).toBe('AI 生成')
    expect(ai.children[0]).toMatchObject({ kind: 'group', title: 'Vite 基础认知' })
    const sub = ai.children[0]
    if (sub.kind !== 'group') throw new Error('unreachable')
    expect(sub.children.map((c) => (c.kind === 'note' ? c.index : ''))).toEqual(['0019', '0020'])
  })

  it('tracks groupPath in flat entries', () => {
    const flat = flattenTocLines(SAMPLE)
    const note = flat.find((e) => e.noteIndex === '0019')
    expect(note?.groupPath).toEqual(['AI 生成', 'Vite 基础认知'])
  })

  it('serializes back to canonical lines', () => {
    const tree = parseTocToTree(SAMPLE)
    const titles = new Map([
      ['0017', 'vite 菜鸟教程'],
      ['0011', '深入浅出 Vite'],
      ['0019', 'Vite 是什么'],
      ['0020', '核心特性'],
      ['0014', 'vite 思维导图']
    ])
    expect(serializeTocTree(tree, titles)).toEqual(SAMPLE)
  })
})

describe('line ops', () => {
  it('finds notes and groups', () => {
    expect(findNoteLineIndex(SAMPLE, '0011')).toBe(2)
    expect(findGroupLineIndex(SAMPLE, ['AI 生成', 'Vite 基础认知'])).toBe(4)
  })

  it('computes subtree ranges', () => {
    expect(getSubtreeRange(SAMPLE, 3)).toEqual({ start: 3, end: 7 })
    expect(getSubtreeRange(SAMPLE, 5)).toEqual({ start: 5, end: 6 })
  })

  it('collects note indexes in a subtree', () => {
    expect(collectSubtreeNoteIndexes(SAMPLE, 3)).toEqual(['0019', '0020'])
  })

  it('sets done state', () => {
    const next = setNoteDoneLine(SAMPLE, '0014', true)
    expect(next[8]).toBe('  - [x] 0014. vite 思维导图')
  })

  it('rewrites note titles', () => {
    const next = setNoteTitleLine(SAMPLE, '0017', '新标题')
    expect(next[1]).toBe('  - [x] 0017. 新标题')
  })

  it('moves a note after another note', () => {
    const next = moveSubtree(SAMPLE, 8, 1, 'after')
    expect(next).toEqual([
      '- 学习资料',
      '  - [x] 0017. vite 菜鸟教程',
      '  - [ ] 0014. vite 思维导图',
      '  - [ ] 0011. 深入浅出 Vite',
      '- AI 生成',
      '  - Vite 基础认知',
      '    - [ ] 0019. Vite 是什么',
      '    - [x] 0020. 核心特性',
      '- pending'
    ])
  })

  it('moves a group inside another group with re-indent', () => {
    const next = moveSubtree(SAMPLE, 0, 3, 'inside')
    expect(next).toEqual([
      '- AI 生成',
      '  - Vite 基础认知',
      '    - [ ] 0019. Vite 是什么',
      '    - [x] 0020. 核心特性',
      '  - 学习资料',
      '    - [x] 0017. vite 菜鸟教程',
      '    - [ ] 0011. 深入浅出 Vite',
      '- pending',
      '  - [ ] 0014. vite 思维导图'
    ])
  })

  it('refuses to move an entry into itself', () => {
    expect(() => moveSubtree(SAMPLE, 3, 4, 'inside')).toThrow('自身')
  })

  it('normalizes blank lines between content lines', () => {
    const lines = ['- a', '', '', '  - [ ] 0001. t', '', '- b']
    // A blank directly between two content lines is dropped; a run of blanks
    // collapses to one.
    expect(normalizeTocBlankLines(lines)).toEqual(['- a', '', '  - [ ] 0001. t', '- b'])
  })

  it('removes selected notes and promotes the children that stay', () => {
    const lines = [
      '- 分组 A',
      '  - [ ] 0001. 父',
      '    - [ ] 0002. 子',
      '    - 内组',
      '      - [x] 0003. 孙',
      '  - [ ] 0004. 邻',
      '- [ ] 0005. 外'
    ]
    expect(removeSelectedNoteLines(lines, new Set(['0001', '0004']))).toEqual([
      '- 分组 A',
      '  - [ ] 0002. 子',
      '  - 内组',
      '    - [x] 0003. 孙',
      '- [ ] 0005. 外'
    ])
  })

  it('promotes a child out from under a removed parent and child', () => {
    const lines = [
      '- [ ] 0001. 父',
      '  - [ ] 0002. 子',
      '    - [ ] 0003. 孙'
    ]
    expect(removeSelectedNoteLines(lines, new Set(['0001', '0002']))).toEqual(['- [ ] 0003. 孙'])
  })

  it('buildNoteLine omits the dot when title is empty', () => {
    expect(buildNoteLine('0001', '', false, 0)).toBe('- [ ] 0001')
    expect(buildNoteLine('0001', '标题', true, 1)).toBe('  - [x] 0001. 标题')
  })
})
