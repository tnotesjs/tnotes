import { describe, expect, it } from 'vitest'

import { nthFenceBodyRange, scanSourceBlocks, sourceBlocksForOffsets } from './sourceBlocks'

describe('源码视图相关块扫描', () => {
  const text = [
    '# 标题', // 1
    '', // 2
    '第一段。', // 3
    '还是第一段。', // 4
    '', // 5
    '- 列表项一', // 6
    '  列表续行', // 7
    '- 列表项二', // 8
    '', // 9
    '> 引用第一行', // 10
    '> 引用第二行', // 11
    '', // 12
    '```js', // 13
    'const a = 1', // 14
    '```', // 15
    '', // 16
    '::: tip 提示', // 17
    '提示正文', // 18
    ':::', // 19
    '', // 20
    '尾段', // 21
    ''
  ].join('\n')

  it('按类型切块，围栏与容器整块算一块', () => {
    expect(
      scanSourceBlocks(text).map((block) => [block.kind, block.startLine, block.endLine])
    ).toEqual([
      ['heading', 1, 1],
      ['paragraph', 3, 4],
      ['list', 6, 8],
      ['blockquote', 10, 11],
      ['code', 13, 15],
      ['container', 17, 19],
      ['paragraph', 21, 21]
    ])
  })

  it('块的 Markdown 是原文切片（逐字，不重新序列化）', () => {
    const blocks = scanSourceBlocks(text)
    const code = blocks.find((block) => block.kind === 'code')!
    expect(code.markdown).toBe('```js\nconst a = 1\n```')
    const list = blocks.find((block) => block.kind === 'list')!
    expect(list.markdown).toBe('- 列表项一\n  列表续行\n- 列表项二')
  })

  it('只返回与选区相交的块', () => {
    const paragraphOffset = text.indexOf('还是第一段。')
    const selected = sourceBlocksForOffsets(text, paragraphOffset, paragraphOffset + 3)
    expect(selected.map((block) => block.kind)).toEqual(['paragraph'])
    expect(selected[0].markdown).toContain('还是第一段。')
  })

  it('跨段选择返回多个块；未选中时不返回块', () => {
    const from = text.indexOf('第一段。')
    const to = text.indexOf('- 列表项二') + 3
    expect(sourceBlocksForOffsets(text, from, to).map((block) => block.kind)).toEqual([
      'paragraph',
      'list'
    ])
    const emptyAt = text.indexOf('尾段')
    expect(sourceBlocksForOffsets(text, emptyAt, emptyAt)).toHaveLength(1)
  })

  it('第 n 个围栏正文：按结构数围栏（两份一模一样的代码也不会串到第一个）', () => {
    const group = [
      '::: code-group',
      '```js',
      'const same = 1',
      '```',
      '```js',
      'const same = 1',
      '```',
      ':::',
      ''
    ].join('\n')
    const first = nthFenceBodyRange(group, 0)
    const second = nthFenceBodyRange(group, 1)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(group.slice(first!.startOffset, first!.endOffset)).toBe('const same = 1\n')
    expect(group.slice(second!.startOffset, second!.endOffset)).toBe('const same = 1\n')
    // 两处正文的偏移不同（不是同一个位置）
    expect(first!.startOffset).not.toBe(second!.startOffset)
    // 越界 / 负数：拿不到就返回 null（调用方据此拒绝固定）
    expect(nthFenceBodyRange(group, 2)).toBeNull()
    expect(nthFenceBodyRange(group, -1)).toBeNull()
  })

  it('第 n 个围栏正文：未闭合的围栏正文一直到文档末尾', () => {
    const open = ['```js', 'const a = 1', 'const b = 2', ''].join('\n')
    const body = nthFenceBodyRange(open, 0)
    expect(open.slice(body!.startOffset, body!.endOffset)).toBe('const a = 1\nconst b = 2\n')
  })

  it('未闭合围栏折到文末（块不会吞掉后续块之外的内容）', () => {
    const open = ['# 标题', '', '```js', 'const a = 1', ''].join('\n')
    const blocks = scanSourceBlocks(open)
    expect(blocks.map((block) => [block.kind, block.startLine, block.endLine])).toEqual([
      ['heading', 1, 1],
      ['code', 3, 5]
    ])
  })
})
