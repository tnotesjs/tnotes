import { describe, expect, it } from 'vitest'

import { renumberHeadings, stripHeadingNumbers } from './headingNumbering'

describe('renumberHeadings', () => {
  it('基本层级编号（默认上限 2）', () => {
    const input = '# A\n## B\n## C\n# D\n## E\n### F\n'
    const output = renumberHeadings(input)
    expect(output.text).toBe('# 1. A\n## 1.1. B\n## 1.2. C\n# 2. D\n## 2.1. E\n### F\n')
  })

  it('上限 6 时全层级编号', () => {
    const input = '# A\n## B\n### C\n'
    expect(renumberHeadings(input, 6).text).toBe('# 1. A\n## 1.1. B\n### 1.1.1. C\n')
  })

  it('上限 1 时只有顶级标题带编号', () => {
    const input = '# A\n## B\n# C\n'
    expect(renumberHeadings(input, 1).text).toBe('# 1. A\n## B\n# 2. C\n')
  })

  it('跳级：H1 直下 H6 也只有两段', () => {
    const input = '# A\n###### x\n###### y\n## B\n'
    expect(renumberHeadings(input, 6).text).toBe(
      '# 1. A\n###### 1.1. x\n###### 1.2. y\n## 1.3. B\n'
    )
  })

  it('跳级超过上限：真实深度 3 的标题不加前缀', () => {
    const input = '# A\n### B\n###### x\n'
    expect(renumberHeadings(input, 2).text).toBe('# 1. A\n### 1.1. B\n###### x\n')
  })

  it('首个标题不是 H1 也从单段开始', () => {
    expect(renumberHeadings('### A\n### B\n', 2).text).toBe('### 1. A\n### 2. B\n')
  })

  it('回升后子级计数重置', () => {
    const input = '# A\n## B\n# C\n## D\n'
    expect(renumberHeadings(input, 2).text).toBe('# 1. A\n## 1.1. B\n# 2. C\n## 2.1. D\n')
  })

  it('保留行首缩进与原有空白', () => {
    expect(renumberHeadings('  ## A\n', 2).text).toBe('  ## 1. A\n')
    expect(renumberHeadings('#  A\n', 2).text).toBe('#  1. A\n')
  })

  it('容器内标题不占编号，后面的标题接着外层往下排', () => {
    const input = '# A\n::: tip\n## 容器标题\n:::\n## B\n'
    expect(renumberHeadings(input, 2).text).toBe('# 1. A\n::: tip\n## 容器标题\n:::\n## 1.1. B\n')
  })

  it('容器里已有的编号前缀保持原样', () => {
    const input = '# A\n::: warning\n## 9. 留着\n:::\n## B\n'
    expect(renumberHeadings(input, 2).text).toBe(
      '# 1. A\n::: warning\n## 9. 留着\n:::\n## 1.1. B\n'
    )
  })

  it('围栏里的 ::: 不会把容器提前关掉', () => {
    const input = [
      '# A',
      '::: tip',
      '```md',
      ':::',
      '## 示例',
      '```',
      '## 容器里',
      ':::',
      '## B',
      ''
    ].join('\n')
    expect(renumberHeadings(input, 2).text).toBe(
      [
        '# 1. A',
        '::: tip',
        '```md',
        ':::',
        '## 示例',
        '```',
        '## 容器里',
        ':::',
        '## 1.1. B',
        ''
      ].join('\n')
    )
  })

  it('frontmatter 与代码块原样保留', () => {
    const input = '---\ntitle: x\n---\n# A\n```md\n# 不动\n```\n## B\n'
    expect(renumberHeadings(input, 2).text).toBe(
      '---\ntitle: x\n---\n# 1. A\n```md\n# 不动\n```\n## 1.1. B\n'
    )
  })

  it('重排语义：剥掉残留前缀再重编', () => {
    const input = '# 9. A\n## 3.3. B\n## 无编号\n'
    expect(renumberHeadings(input, 2).text).toBe('# 1. A\n## 1.1. B\n## 1.2. 无编号\n')
  })

  it('重排会清掉超过上限的旧前缀', () => {
    const input = '# 1. A\n## 1.1. B\n### 1.1.1. C\n'
    expect(renumberHeadings(input, 2).text).toBe('# 1. A\n## 1.1. B\n### C\n')
  })

  it('无尾点前缀不剥也不误判', () => {
    const input = '# 1.5 倍速\n'
    expect(renumberHeadings(input, 2).text).toBe('# 1. 1.5 倍速\n')
  })

  it('maxDepth 越界时钳制到 1-6', () => {
    expect(renumberHeadings('# A\n## B\n', 0).text).toBe('# 1. A\n## B\n')
    expect(renumberHeadings('# A\n## B\n### C\n', 99).text).toBe(
      '# 1. A\n## 1.1. B\n### 1.1.1. C\n'
    )
  })

  it('无标题时 changed 为 false', () => {
    const output = renumberHeadings('只有正文\n')
    expect(output.changed).toBe(false)
    expect(output.text).toBe('只有正文\n')
  })

  it('编号已正确时 changed 为 false', () => {
    const output = renumberHeadings('# 1. A\n## 1.1. B\n', 2)
    expect(output.changed).toBe(false)
  })
})

describe('stripHeadingNumbers', () => {
  it('剥掉所有层级的编号前缀，未编号标题不动', () => {
    const input = '# 1. A\n## 1.1. B\n### 1.1.1. C\n## 普通\n# 2. D\n'
    const output = stripHeadingNumbers(input)
    expect(output.text).toBe('# A\n## B\n### C\n## 普通\n# D\n')
  })

  it('代码块内的编号样式不剥', () => {
    const input = '# 1. A\n```\n# 9. 代码\n```\n'
    expect(stripHeadingNumbers(input).text).toBe('# A\n```\n# 9. 代码\n```\n')
  })

  it('frontmatter 不动', () => {
    const input = '---\ntitle: 1. x\n---\n# 1. A\n'
    expect(stripHeadingNumbers(input).text).toBe('---\ntitle: 1. x\n---\n# A\n')
  })

  it('无编号时 changed 为 false', () => {
    expect(stripHeadingNumbers('# A\n').changed).toBe(false)
  })
})
