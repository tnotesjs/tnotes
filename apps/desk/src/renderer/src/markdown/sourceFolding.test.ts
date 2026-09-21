import { describe, expect, it } from 'vitest'

import { headingFoldTargetLines, markdownFoldRanges } from './sourceFolding'

const lines = (...items: string[]): string => `${items.join('\n')}\n`

describe('markdownFoldRanges：标题章节', () => {
  it('多级标题：章节折到下一个同级或更高级标题之前', () => {
    const text = lines(
      '# 一', // 1
      '', // 2
      '正文', // 3
      '', // 4
      '## 一之一', // 5
      '', // 6
      '正文', // 7
      '', // 8
      '### 一之一之一', // 9
      '', // 10
      '正文', // 11
      '', // 12
      '## 一之二', // 13
      '', // 14
      '正文' // 15
    )
    expect(markdownFoldRanges(text).filter((range) => range.kind === 'heading')).toEqual([
      // # 一 折到文末（后面没有同级或更高级标题）
      { start: 1, end: 16, kind: 'heading', level: 1 },
      // ## 一之一 折到下一个 ## 之前
      { start: 5, end: 12, kind: 'heading', level: 2 },
      { start: 9, end: 12, kind: 'heading', level: 3 },
      { start: 13, end: 16, kind: 'heading', level: 2 }
    ])
  })

  it('相邻标题：空章节（下一行就是同级标题）不产出范围', () => {
    // `# 一` 的章节只有它自己和紧邻的 `# 二` 这一行 —— 空章节，折了没内容
    const empty = lines('# 一', '# 二', '正文')
    expect(markdownFoldRanges(empty).filter((range) => range.kind === 'heading')).toEqual([
      { start: 2, end: 4, kind: 'heading', level: 1 }
    ])

    // 高级别紧跟着低级别时，高级别那行的章节是"包含低级别标题"的，是可折叠内容
    const nested = lines('# 一', '## 二', '正文')
    expect(markdownFoldRanges(nested).filter((range) => range.kind === 'heading')).toEqual([
      { start: 1, end: 4, kind: 'heading', level: 1 },
      { start: 2, end: 4, kind: 'heading', level: 2 }
    ])
  })

  it('最后一个章节折到文末（含末尾空行）', () => {
    const text = lines('# 一', '正文', '## 二', '正文二', '')
    const last = markdownFoldRanges(text).find((range) => range.start === 3)
    expect(last).toMatchObject({ start: 3, end: 6 })
  })

  it('只认 ATX 且 # 后必须是空白或行尾', () => {
    const text = lines('#好标题', '# 真标题', '正文')
    expect(markdownFoldRanges(text).map((range) => range.start)).toEqual([2])
  })
})

describe('markdownFoldRanges：围栏代码块', () => {
  it('反引号与波浪线围栏都折整块，且代码里的伪标题不算章节', () => {
    const text = lines(
      '```md', // 1
      '# 这不是标题', // 2
      '正文', // 3
      '```', // 4
      '', // 5
      '~~~python', // 6
      '# 也不是标题', // 7
      '~~~', // 8
      '', // 9
      '# 真标题', // 10
      '正文' // 11
    )
    expect(markdownFoldRanges(text)).toEqual([
      { start: 1, end: 4, kind: 'code', level: null },
      { start: 6, end: 8, kind: 'code', level: null },
      // 代码块里的 # 不算章节，所以唯一的标题是第 10 行
      { start: 10, end: 12, kind: 'heading', level: 1 }
    ])
  })

  it('未闭合围栏折到文末', () => {
    const text = lines('正文', '```js', 'const a = 1', '')
    expect(markdownFoldRanges(text)).toEqual([{ start: 2, end: 5, kind: 'code', level: null }])
  })

  it('更长的围栏才闭合、缩进 ≤3 空格算围栏、info string 里的反引号不算围栏', () => {
    const text = lines(
      '   ```', // 1 缩进 2 空格：是围栏起始
      '正文', // 2
      '  `````', // 3 更长 → 闭合
      '```', // 4 新的起始
      '正文', // 5
      '后文' // 6 未闭合 → 折到文末
    )
    expect(markdownFoldRanges(text)).toEqual([
      { start: 1, end: 3, kind: 'code', level: null },
      { start: 4, end: 7, kind: 'code', level: null }
    ])

    // 反引号围栏的 info string 里带反引号 → 不是围栏，后面的 # 仍按标题处理
    const notFence = lines('```js `x`', '# 标题', '正文')
    expect(markdownFoldRanges(notFence)).toEqual([{ start: 2, end: 4, kind: 'heading', level: 1 }])
  })

  it('代码块里的标题不会切断外层章节', () => {
    const text = lines(
      '# 一', // 1
      '正文', // 2
      '```md', // 3
      '## 伪标题', // 4
      '```', // 5
      '正文', // 6
      '# 二', // 7
      '正文' // 8
    )
    const headings = markdownFoldRanges(text).filter((range) => range.kind === 'heading')
    expect(headings).toEqual([
      { start: 1, end: 6, kind: 'heading', level: 1 },
      { start: 7, end: 9, kind: 'heading', level: 1 }
    ])
  })
})

describe('headingFoldTargetLines：命令 → 标题行（0-based）', () => {
  const text = lines(
    '# 一', // 1
    '正文', // 2
    '## 一之一', // 3
    '正文', // 4
    '## 一之二', // 5
    '# 二', // 6
    '正文' // 7
  )

  it('fold-all / unfold-all 只取**有正文的**标题行', () => {
    // 第 5 行「## 一之二」的下一行就是同级标题 → 空章节，没有折叠范围，不进目标
    expect(headingFoldTargetLines('fold-all', text)).toEqual([0, 2, 5])
    expect(headingFoldTargetLines('unfold-all', text)).toEqual([0, 2, 5])
  })

  it('按级别只取该级标题', () => {
    expect(headingFoldTargetLines('fold-level-2', text)).toEqual([2])
    expect(headingFoldTargetLines('unfold-level-1', text)).toEqual([0, 5])
    expect(headingFoldTargetLines('fold-level-4', text)).toEqual([])
  })

  it('代码块行永远不在目标里（即使命令是 fold-all）', () => {
    const withCode = lines('# 一', '```js', 'const a = 1', '```', '# 二', '正文')
    expect(headingFoldTargetLines('fold-all', withCode)).toEqual([0, 4])
  })
})
