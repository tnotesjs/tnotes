import { describe, expect, it } from 'vitest'

import {
  appendRange,
  findNote,
  lineChangeCounts,
  locateSelection,
  locateWritten,
  notePageHeader,
  overlapsProtectedFrontmatter,
  pageNoteRefs,
  rankNotes,
  readLineSlice,
  resolveKnowledgeBase
} from './agentNoteQuery'

import type { DeskTocNode } from '../../../shared/contracts'

const note = (patch: Partial<Extract<DeskTocNode, { type: 'note' }>>): DeskTocNode => ({
  type: 'note',
  uuid: 'uuid-1',
  title: '如何让 ALEX 更好地推荐自己的产品',
  dirName: '0001. 如何让 ALEX 更好地推荐自己的产品',
  noteIndex: '0001',
  tocLineIndex: 0,
  nodeId: 'n1',
  completed: false,
  children: [],
  ...patch
})

const toc: DeskTocNode[] = [note({})]

describe('findNote', () => {
  it('matches uuid, index, path and full title', () => {
    expect(findNote(toc, 'uuid-1')?.noteIndex).toBe('0001')
    expect(findNote(toc, '0001')?.uuid).toBe('uuid-1')
    expect(findNote(toc, 'notes/0001. 如何让 ALEX 更好地推荐自己的产品.md')?.uuid).toBe('uuid-1')
    expect(findNote(toc, '如何让 ALEX 更好地推荐自己的产品')?.uuid).toBe('uuid-1')
    expect(findNote(toc, '不存在')).toBeNull()
  })
})

describe('readLineSlice', () => {
  it('slices by line and reports the range', () => {
    const content = ['一', '二', '三', '四'].join('\n')
    const slice = readLineSlice(content, 2, 2)
    expect(slice).toMatchObject({ text: '二\n三', fromLine: 2, toLine: 3, total: 4 })
    expect(readLineSlice(content, 0, 0).fromLine).toBe(1)
  })

  it('stops at the character cap and reports the real last line', () => {
    const content = Array.from({ length: 10 }, (_, index) => `${index + 1}`.padEnd(10, 'x')).join('\n')
    const slice = readLineSlice(content, 1, 400, 35)
    expect(slice.toLine).toBe(3)
    expect(slice.text.split('\n')).toHaveLength(3)
    expect(slice.total).toBe(10)
  })
})

describe('frontmatter edits', () => {
  it('rejects a range that touches the id line', () => {
    const content = '---\nid: abc\n---\n正文\n'
    expect(overlapsProtectedFrontmatter(content, 0, 4)).toBe(true)
    expect(overlapsProtectedFrontmatter(content, content.indexOf('正文'), content.length)).toBe(false)
  })
})

describe('lineChangeCounts', () => {
  it('does not count a run of blank lines as several removed lines', () => {
    expect(lineChangeCounts('\n\n\n', '一\n二\n三')).toEqual({ removed: 0, added: 3 })
    expect(lineChangeCounts('旧', '新')).toEqual({ removed: 1, added: 1 })
  })
})

describe('appendRange', () => {
  it('appends onto an empty note', () => {
    expect(appendRange('', '一行')).toEqual({ from: 0, insert: '一行\n' })
  })

  it('appends after frontmatter without touching the protected lines', () => {
    const content = '---\nid: abc\n---\n'
    const range = appendRange(content, '追加')
    expect(range).toEqual({ from: content.length, insert: '追加\n' })
    expect(overlapsProtectedFrontmatter(content, range.from, range.from)).toBe(false)
    expect(content + range.insert).toBe('---\nid: abc\n---\n追加\n')
  })

  it('adds a leading newline when the body does not end with one', () => {
    const content = '---\nid: abc\n---\n正文'
    expect(appendRange(content, '追加')).toEqual({ from: content.length, insert: '\n追加\n' })
    expect(appendRange('正文\n', '追加').insert).toBe('追加\n')
  })
})

describe('pageNoteRefs', () => {
  it('pages by offset and writes the header from the rows actually returned', () => {
    const notes = [
      { uuid: 'a', title: '甲', index: '0001', path: '0001. 甲' },
      { uuid: 'b', title: '乙', index: '0002', path: '0002. 乙' },
      { uuid: 'c', title: '丙', index: '0003', path: '0003. 丙' }
    ]
    const page = pageNoteRefs(notes, { offset: 1, limit: 1 })
    expect(page.total).toBe(3)
    expect(page.lines).toEqual(['0002\t乙\tb\t0002. 乙'])
    expect(notePageHeader(page)).toBe('第 2–2 篇 / 共 3 篇')
    const filtered = pageNoteRefs(notes, { query: '丙' })
    expect(filtered.total).toBe(1)
    expect(notePageHeader(filtered)).toBe('第 1–1 篇 / 共 1 篇')
  })
})

describe('locateSelection', () => {
  const content = '标题\n\n第一段\n第二段\n第三段\n'

  it('uses the stored offsets while the text is still there', () => {
    const from = content.indexOf('第二段')
    expect(locateSelection(content, { from, to: from + 3, text: '第二段' })).toEqual({ from, to: from + 3 })
  })

  it('finds the text again after lines were inserted above it', () => {
    const moved = `新插入一行\n新插入二行\n${content}`
    const oldFrom = content.indexOf('第二段')
    const found = locateSelection(moved, { from: oldFrom, to: oldFrom + 3, startLine: 4, endLine: 4, text: '第二段' })
    expect(found).toEqual({ from: moved.indexOf('第二段'), to: moved.indexOf('第二段') + 3 })
  })

  it('picks the occurrence nearest to the old position', () => {
    const repeated = 'A\nX\nA\nX\n'
    expect(locateSelection(repeated, { from: 5, to: 6, text: 'X' })?.from).toBe(6)
  })

  it('falls back to selecting the whole original lines when the text is gone', () => {
    expect(locateSelection(content, { from: 99, to: 120, startLine: 3, endLine: 4, text: '已经被改掉的原文' })).toEqual({
      from: content.indexOf('第一段'),
      to: content.indexOf('第二段') + 3
    })
    expect(locateSelection(content, { text: '不存在' })).toBeNull()
  })
})

describe('locateWritten', () => {
  it('selects the whole written text while it is unchanged', () => {
    const content = '前文\n新写的一段\n后文'
    expect(locateWritten(content, '新写的一段\n')).toEqual({ from: 3, to: 8 })
  })

  it('still finds the lines after the save numbered the heading', () => {
    const written = '## 导读：核心大纲\n\n- **背景**：合并为 Alexa for Shopping\n- 五层工作模型\n'
    const content = '---\nid: x\n---\n\n# 1. 导读：核心大纲\n\n- **背景**：合并为 Alexa for Shopping\n- 五层工作模型\n\n# 2. 正文'
    const range = locateWritten(content, written)
    expect(content.slice(range!.from, range!.to)).toBe('# 1. 导读：核心大纲\n\n- **背景**：合并为 Alexa for Shopping\n- 五层工作模型')
  })

  it('returns null when nothing of it is left', () => {
    expect(locateWritten('完全不同的内容', '## 已经删掉的标题')).toBeNull()
  })
})

describe('rankNotes', () => {
  const notes = [
    { index: '0001', title: '如何让 ALEX 更好地推荐自己的产品' },
    { index: '0002', title: '111' },
    { index: '0010', title: '两数之和 0001 版' },
    { index: '0003', title: 'code-block 测试' }
  ]

  it('puts an index prefix match before a title match', () => {
    expect(rankNotes(notes, '0001').map((note) => note.index)).toEqual(['0001', '0010'])
  })

  it('falls back to characters in order and needs every keyword', () => {
    expect(rankNotes(notes, 'cbk').map((note) => note.index)).toEqual(['0003'])
    expect(rankNotes(notes, 'alex 产品').map((note) => note.index)).toEqual(['0001'])
    expect(rankNotes(notes, 'alex 不存在')).toEqual([])
  })

  it('keeps toc order when the query is empty', () => {
    expect(rankNotes(notes, '', 2).map((note) => note.index)).toEqual(['0001', '0002'])
  })
})

describe('resolveKnowledgeBase', () => {
  const list = [
    { id: 'fd76a97911', name: 'test', displayName: 'test' },
    { id: '7d3ab66a25', name: 'TNotes.algorithms', displayName: 'algorithms' }
  ]

  it('resolves by id, display name or folder name and falls back to the turn default', () => {
    expect(resolveKnowledgeBase(list, '7d3ab66a25', 'fd76a97911')).toEqual({ kb: list[1] })
    expect(resolveKnowledgeBase(list, 'Algorithms', 'fd76a97911')).toEqual({ kb: list[1] })
    expect(resolveKnowledgeBase(list, 'TNotes.algorithms', 'fd76a97911')).toEqual({ kb: list[1] })
    expect(resolveKnowledgeBase(list, undefined, 'fd76a97911')).toEqual({ kb: list[0] })
  })

  it('lists the available names when nothing matches', () => {
    const result = resolveKnowledgeBase(list, '不存在', 'fd76a97911')
    expect('error' in result && result.error).toContain('test、algorithms')
  })
})
