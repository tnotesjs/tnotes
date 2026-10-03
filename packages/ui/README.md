# @tnotesjs/ui

TNotes 内置块的 Vue 组件。消费方：`@tnotesjs/ssg`、Desk。需要 `vue` `^3.5`。样式用 `--tn-*`（`src/styles/tokens.css`）。

自由绘图尚未做成组件。磁盘真相源约定为知识库 `assets/*.excalidraw`（Desk 与 SSG 将只维护这一套数据）。配套 SVG 是历史派生，组件落地并改引用后再单独迁移删除。

```bash
pnpm add @tnotesjs/ui
```

### 代码块（`CodeBlock` / `CodeGroup`）

默认行为跟 VitePress 一致，**任何情况下都不限制高度**：

- 宽度不超出正文容器，超长单行在代码块内横向滚动，页面不会被撑宽；
- 原始换行与缩进原样保留（`white-space: pre`），不强制换行；
- 高度一律由内容撑开：**没有 `max-height`、不会出现内部纵向滚动**，哪怕上万行也照直铺开。

**折叠是页面内的视图状态**：每个代码块标题左侧都有折叠 Icon，点一下把代码内容
整体隐藏（只剩标题栏，跟折叠标题一样），再点展开。状态**只存在当前页面的内存里** ——
不写进 markdown、不写 localStorage，刷新或重新进入页面一律回到展开。
代码分组切换 tab 时，新露出来的面板若处于收起状态会自动展开。

````md
```js
console.log('每个代码块标题左侧都有折叠 Icon')
```

```ts:line-numbers {2} [multi.ts]
function add(a: number, b: number) {
  const sum = a + b
  return sum
}
```

```text [one-line.txt]
这一行很长很长……它在代码块内横向滚动，不会把页面撑宽
```

```js [long.js]
// 多少行都直接铺开：没有 max-height，也没有内部纵向滚动条
```

::: code-group

```js [a-short.js]
console.log('a')
```

```ts [b-long.ts]
// 每个 tab 的代码同样可折叠；切换 tab 会自动展开收起的面板
```

:::
````

作者不需要写任何额外标记，也不需要“声明”某个代码块可折叠。站点读者与编辑器
（Desk）行为一致。

### `BilibiliVideo`

| Prop       | Default  |
| ---------- | -------- |
| `id`       | required |
| `autoplay` | `false`  |
| `muted`    | `false`  |

```md
<BilibiliVideo id="BV1QR4y1y7GG" :autoplay="true" :muted="true" />
```

### `WordList`

| Prop              | Default                   |
| ----------------- | ------------------------- |
| `words`           | `[]`                      |
| `needSort`        | `false`                   |
| `wordsBaseUrl`    | en-words blob URL         |
| `wordsRawBaseUrl` | en-words raw URL          |
| `features`        | `WORD_LIST_FEATURES_FULL` |

```md
<WordList :words="['cancel', 'salary']" :needSort="true" />
```

`WORD_LIST_FEATURES_FULL`：卡片 + 拉取词表 + 菜单钉住 / 自动展开。`WORD_LIST_FEATURES_STATIC`：全关。

### `Mermaid`

围栏语言 `mermaid`；` ```mermaid center ` 居中。

| Prop                 | Default   |
| -------------------- | --------- |
| `source`             | `''`      |
| `graph`              | `''`      |
| `id`                 | auto      |
| `center`             | `false`   |
| `isDark`             | auto      |
| `securityLevel`      | `'loose'` |
| `enableCopy`         | `true`    |
| `enableFullscreen`   | `true`    |
| `enableCenterToggle` | `true`    |
