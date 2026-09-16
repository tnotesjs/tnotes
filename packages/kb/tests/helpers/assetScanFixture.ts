import fs from 'node:fs/promises'
import path from 'node:path'

/** 1×1 PNG. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

async function write(root: string, relPath: string, content: string | Uint8Array): Promise<void> {
  const full = path.join(root, relPath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

/** Independent P1-1a fixture covering the support matrix. Does not touch real kbs/. */
export async function writeAssetScanFixture(root: string): Promise<void> {
  await write(
    root,
    'tnotes.json',
    JSON.stringify(
      {
        title: 'asset-scan-fixture',
        icon: { src: '../assets/kb-icon.png' }
      },
      null,
      2
    ) + '\n'
  )
  await write(
    root,
    'TOC.md',
    `- [x] 0001. 普通笔记
- [ ] 0002. 脑图与 HTML
`
  )
  await write(root, 'README.md', `库说明见 [图](./assets/readme-cover.png)\n`)
  await write(
    root,
    'notes/0001. 普通笔记.md',
    `---
id: note-plain
---

# 普通笔记

![宽图](../assets/used.png) {w=400px}

![对齐](../assets/nested/deep.png "title") {align=center}

[下载](../assets/used.png?download=1#frag)

编码：[中文](../assets/%E4%B8%AD%E6%96%87%20(1).png)

根路径（兼容待核验）：![x](/assets/used.png)

远程：![x](https://example.com/x.png)

定义：

[logo]: ../assets/used.png

行内代码 \`../assets/fenced-only.png\` 不应改写。

<!-- ../assets/comment-only.png -->

\`\`\`js
![示例](../assets/fenced-only.png)
\`\`\`
`
  )
  await write(
    root,
    'notes/0002. 脑图与 HTML.md',
    `---
id: note-html
---

# 脑图与 HTML

<img src="../assets/html-src.png" />

<a href="../assets/used.png">link</a>

<img srcset="../assets/srcset.png 1x" />

<Swiper src="../assets/component.png" :extra="dyn" />

\`\`\`mindmap [图]
# root

- ![截图|400](./assets/mindmap.png)
\`\`\`
`
  )
  await write(
    root,
    'notes/0003. 未入 TOC.md',
    `---
id: note-orphan
---

# 游离

![游离](../assets/orphan-note.png)
`
  )
  await write(root, 'assets/kb-icon.png', PNG_1X1)
  await write(root, 'assets/used.png', PNG_1X1)
  await write(root, 'assets/nested/deep.png', PNG_1X1)
  await write(root, 'assets/中文 (1).png', PNG_1X1)
  await write(root, 'assets/html-src.png', PNG_1X1)
  await write(root, 'assets/srcset.png', PNG_1X1)
  await write(root, 'assets/component.png', PNG_1X1)
  await write(root, 'assets/mindmap.png', PNG_1X1)
  await write(root, 'assets/orphan-note.png', PNG_1X1)
  await write(root, 'assets/readme-cover.png', PNG_1X1)
  await write(root, 'assets/idle.png', PNG_1X1)
  await write(root, 'assets/fenced-only.png', PNG_1X1)
  await write(root, 'assets/comment-only.png', PNG_1X1)
  await write(root, 'assets/broken-target-placeholder.txt', 'not referenced as image dest\n')
  await write(root, 'assets/board.excalidraw', '{"type":"excalidraw","elements":[]}\n')
  await write(root, 'assets/page.html', '<img src="./used.png">\n')
}

/** Coverage-complete KB used by write-path tests: no dynamic Vue / unparsed scripts. */
export async function writeWritableAssetFixture(root: string): Promise<void> {
  await write(root, 'tnotes.json', '{ "title": "writable-asset-fixture" }\n')
  await write(root, 'TOC.md', '- [ ] 0001. 图\n')
  await write(
    root,
    'notes/0001. 图.md',
    `---
id: note-writable
---

# 图

![宽图](../assets/used.png) {w=400px}

[下载](../assets/used.png?download=1#frag)

![深层](../assets/nested/deep.png)

\`\`\`mindmap [图]
# root

- ![截图|400](./assets/mindmap.png)
\`\`\`
`
  )
  await write(root, 'assets/used.png', PNG_1X1)
  await write(root, 'assets/nested/deep.png', PNG_1X1)
  await write(root, 'assets/mindmap.png', PNG_1X1)
  await write(root, 'assets/idle.png', PNG_1X1)
}

/** P1-1b matrix: srcset/poster, CSS, Vue SFC, Excalidraw, isolated cycle. */
export async function writeExtendedAssetFixture(root: string): Promise<void> {
  await write(root, 'tnotes.json', '{ "title": "p1-1b-fixture" }\n')
  await write(root, 'TOC.md', '- [ ] 0001. 扩展适配\n')
  await write(
    root,
    'LocalCard.vue',
    `<script setup>
import icon from './assets/vue-icon.png'
</script>
<template>
  <img src="./assets/vue-static.png" />
</template>
<style>
.card { background: url('./assets/vue-bg.png'); }
</style>
`
  )
  await write(
    root,
    'notes/0001. 扩展适配.md',
    `---
id: note-p11b
---

# 扩展适配

![主图](../assets/used.png)

<video poster="../assets/poster.png" src="../assets/used.png"></video>

<img srcset="../assets/srcset-1.png 1x, ../assets/srcset-2.png 2x" />

<script setup>
import LocalCard from '../LocalCard.vue'
import '../assets/note-import.css'
</script>

<LocalCard />

<div style="background: url('../assets/style-bg.png')"></div>

[页面](../assets/page.html)

![画布](../assets/board.excalidraw)
`
  )
  await write(
    root,
    'assets/theme.css',
    `/* comment url(./commented.png) */
@import "./nested.css";
.hero { background: url("./css-bg.png"); }
`
  )
  await write(root, 'assets/nested.css', `.x { background: url("./css-nested.png"); }\n`)
  await write(root, 'assets/note-import.css', `.n { color: red; }\n`)
  await write(
    root,
    'assets/page.html',
    `<link rel="stylesheet" href="./theme.css" />
<img src="./html-img.png" />
`
  )
  await write(
    root,
    'assets/board.excalidraw',
    `${JSON.stringify({
      type: 'excalidraw',
      files: {
        a: { dataURL: 'data:image/png;base64,aaaa', mimeType: 'image/png' }
      },
      elements: [{ type: 'image', fileId: 'a', extra: './excali-embed.png' }]
    })}\n`
  )
  await write(root, 'assets/island.html', '<link rel="stylesheet" href="./island.css" />\n')
  await write(root, 'assets/island.css', '.i { background: url("./island.png"); }\n')
  await write(root, 'assets/used.png', PNG_1X1)
  await write(root, 'assets/poster.png', PNG_1X1)
  await write(root, 'assets/srcset-1.png', PNG_1X1)
  await write(root, 'assets/srcset-2.png', PNG_1X1)
  await write(root, 'assets/style-bg.png', PNG_1X1)
  await write(root, 'assets/vue-icon.png', PNG_1X1)
  await write(root, 'assets/vue-static.png', PNG_1X1)
  await write(root, 'assets/vue-bg.png', PNG_1X1)
  await write(root, 'assets/css-bg.png', PNG_1X1)
  await write(root, 'assets/css-nested.png', PNG_1X1)
  await write(root, 'assets/html-img.png', PNG_1X1)
  await write(root, 'assets/excali-embed.png', PNG_1X1)
  await write(root, 'assets/island.png', PNG_1X1)
  await write(root, 'assets/idle.png', PNG_1X1)
  await write(root, 'assets/commented.png', PNG_1X1)
}

/** Asset-relevant dynamic Vue keeps coverage incomplete. */
export async function writeIncompleteCoverageFixture(root: string): Promise<void> {
  await write(root, 'tnotes.json', '{ "title": "incomplete-coverage" }\n')
  await write(root, 'TOC.md', '- [ ] 0001. 动态\n')
  await write(
    root,
    'notes/0001. 动态.md',
    `---
id: note-dyn
---

![图](../assets/used.png)

<img :src="dynamicSrc" />
`
  )
  await write(root, 'assets/used.png', PNG_1X1)
  await write(root, 'assets/idle.png', PNG_1X1)
  await write(root, 'assets/board.excalidraw', '{"type":"excalidraw","elements":[]}\n')
}
