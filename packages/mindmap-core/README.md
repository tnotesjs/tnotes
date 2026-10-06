# @tnotesjs/mindmap-core

`*.tn-mindmap.md` 引擎：解析 / 序列化、会话、布局、Canvas。无 Vue 依赖。合法文件恰好一个 H1，其后是无序列表；非法源码原样保留。

```ts
import { MindmapSession, parseMarkdown, serializeMarkdown } from '@tnotesjs/mindmap-core'

const result = parseMarkdown('# Notes\n\n- Topic')
if (result.ok) {
  const session = new MindmapSession({
    markdown: '# Notes\n\n- Topic',
    fileName: 'notes.tn-mindmap.md'
  })
  console.log(serializeMarkdown(session.document))
}
```

只读画布：`CanvasViewer`（导航 / 折叠 / 平移缩放，不改文档）。

链接引用定义：围栏外的 `[1]: url` 由宿主传入 `definitions`（`MindmapSession({ definitions })` / `parseMarkdown(md, name, { definitions })`），节点里的 `[文字][1]` / `[文字][]` / `[文字]` 显示为链接，编辑后仍写回引用写法。行内代码里不当链接。
