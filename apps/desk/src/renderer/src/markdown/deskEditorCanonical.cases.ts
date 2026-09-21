/**
 * canonical 快照用例（迁移 `@milkdown/crepe` → 自组 `@milkdown/kit` 的等价性闸门）。
 *
 * 目的：编辑器换装配层时，**序列化出来的 markdown 必须逐字节不变** —— 忠实性判定、
 * sourcePreservation、写盘形态全都建立在 canonical 之上，任何静默漂移都会让真实笔记
 * 被判成「不忠实」而降级。这里挑的是投影边界上最容易漂的构造。
 *
 * 用例用「行数组 join」而不是模板字符串：正文里有代码围栏（反引号），模板字符串写不了。
 */
export interface DeskCanonicalCase {
  name: string
  source: string
}

export const DESK_CANONICAL_CASES: DeskCanonicalCase[] = [
  {
    name: 'paragraph-and-inline-marks',
    source: [
      '# 标题',
      '',
      '普通段落，**粗体**、*斜体*、~~删除线~~、`行内代码`、[链接](https://example.com)。',
      '',
      '## 二级标题',
      '',
      '1. 有序',
      '2. 列表',
      ''
    ].join('\n')
  },
  {
    name: 'bullet-markers',
    source: [
      '* 星号项',
      '* 第二项',
      '',
      '+ 加号项',
      '',
      '- 减号项',
      '  - 嵌套一项',
      '  - 嵌套二项',
      '',
      '正文收尾。',
      ''
    ].join('\n')
  },
  {
    name: 'ordered-markers',
    source: ['1. 第一', '2. 第二', '', '1) 括号式', '2) 第二项', ''].join('\n')
  },
  {
    name: 'task-list',
    source: ['- [ ] 未完成', '- [x] 已完成', '- [ ] 第三项', ''].join('\n')
  },
  {
    name: 'table-shapes',
    source: [
      '| 左 | 中 | 右 |',
      '| :--- | :---: | ---: |',
      '| `代码` | **粗体** | ~~删除线~~ |',
      '| 普通 | 单元格<br>换行 | ![单元格图](../assets/a.png) |',
      ''
    ].join('\n')
  },
  {
    name: 'fenced-code-with-meta',
    source: [
      '```js title="a.js" {1,3}',
      'const a  =  1',
      "const s = 'x'",
      '```',
      '',
      '```txt',
      '普通文本块',
      '```',
      ''
    ].join('\n')
  },
  {
    // 注意：公式**放进表格单元格**会让 happy-dom 的表组件卡死，所以此处只覆盖段落内行内公式；
    // 表格内公式的等价性由 e2e-fidelity（元素目录笔记 §22 的 $x^2$ 单元格）与真实笔记覆盖。
    name: 'math-inline',
    source: ['行内公式 $x^2$ 与 $a+b$ 混排。', ''].join('\n')
  },
  {
    name: 'math-block',
    source: ['$$', 'E = mc^2', '$$', '', '公式之后。', ''].join('\n')
  },
  {
    name: 'thematic-break-forms',
    source: ['上面', '', '***', '', '中间', '', '___', '', '下面', '', '---', ''].join('\n')
  },
  {
    name: 'blank-line-runs',
    source: ['第一段', '', '', '', '第二段', '', ''].join('\n')
  },
  {
    name: 'standalone-break',
    source: ['第一段', '', '<br />', '', '第二段', ''].join('\n')
  },
  {
    name: 'inline-hard-break-forms',
    source: ['行尾两空格  ', '下一行', '', '反斜杠硬换行\\', '下一行', '', '行内<br>换行', ''].join(
      '\n'
    )
  },
  {
    name: 'callout-container',
    source: ['::: tip 提示标题', '', '提示正文', '', ':::', '', '收尾段落。', ''].join('\n')
  },
  {
    name: 'nested-callout-container',
    source: [
      '::: tip 外层',
      '',
      '外层正文',
      '',
      '::: info 内层',
      '',
      '内层正文',
      '',
      ':::',
      '',
      ':::',
      ''
    ].join('\n')
  },
  {
    name: 'component-tag',
    source: ['<BVideo bvid="BV1xx" title="示例" />', '', '组件之后。', ''].join('\n')
  },
  {
    name: 'raw-html-block',
    source: ['<div align="center">', '', '居中文本', '', '</div>', ''].join('\n')
  },
  {
    name: 'frontmatter',
    source: ['---', 'id: canonical-1', 'description: 快照用例', '---', '', '# 正文', ''].join('\n')
  },
  {
    name: 'link-reference-definition',
    source: [
      '参考式图片：',
      '',
      '![参考式图片][ref-img]',
      '',
      '参考式链接：[站点][site]',
      '',
      '[ref-img]: ../assets/a.png',
      '[site]: https://tnotesjs.github.io/TNotes.docs/',
      ''
    ].join('\n')
  },
  {
    name: 'image-forms',
    source: [
      '带 title 的图片：',
      '',
      '![带标题](../assets/b.png "图片 title")',
      '',
      '独占一行的图片：',
      '',
      '![](../assets/c.png)',
      '',
      '链接图片：[![链接图](../assets/d.png)](https://example.com)',
      ''
    ].join('\n')
  },
  {
    name: 'escapes',
    source: ['\\*不是斜体\\* 与 \\_不是强调\\_ 与 \\`不是代码\\`。', ''].join('\n')
  },
  {
    name: 'blockquote',
    source: ['> 引用第一行', '> 引用第二行', '>', '> 引用第三段', ''].join('\n')
  },
  {
    name: 'setext-heading',
    source: ['Setext 标题', '===', '', '小标题', '---', ''].join('\n')
  },
  // ── 分割线输出统一为 `---` 的边界（item 1）────────────────────────────────
  // 三种写法解析都要兼容，输出只留一种；下面这些用例把「换成 `-` 之后会不会写成
  // Setext 标题 / 贴到 frontmatter 上 / 被容器或代码围栏改坏」钉在快照里。
  {
    name: 'thematic-break-at-start',
    source: ['***', '', '分割线在文档最前面。', ''].join('\n')
  },
  {
    name: 'thematic-break-adjacent-paragraphs',
    // 没有空行：树是 [段, 分割线, 段]，序列化必须自己补出空行（否则 `---` 会变成 Setext 标题）
    source: ['上面', '***', '下面', ''].join('\n')
  },
  {
    name: 'thematic-break-before-heading',
    source: ['上面', '', '***', '# 紧跟的标题', '', '正文', ''].join('\n')
  },
  {
    name: 'thematic-break-in-containers',
    source: ['- 列表项一', '', '  ***', '', '- 列表项二', '', '> 引用', '>', '> ___', ''].join('\n')
  },
  {
    name: 'thematic-break-in-code-fence',
    source: ['```md', '上面', '', '***', '', '---', '```', '', '```text', '___', '```', ''].join(
      '\n'
    )
  },
  {
    name: 'thematic-break-after-frontmatter',
    source: ['---', 'id: thematic-after-fm', '---', '', '***', '', '# 正文', ''].join('\n')
  }
]
