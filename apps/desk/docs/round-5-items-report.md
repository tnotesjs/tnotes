# Desk 本轮 5 项需求与问题 —— 实现与验证报告

**状态：实现待验收，未发布。** 本轮不推送远端、不打标签、不发版；复核方验收后再决定发布。

分项提交（`main` 本地）：

| #   | 需求                                | 提交      |
| --- | ----------------------------------- | --------- |
| 1   | 分割线统一输出 `---`                | `8e443d5` |
| 2   | 源码模式中文标点黄色警告框          | `f1fd714` |
| 3   | 源码模式跨行选区背景越界            | `6921e1c` |
| 4   | 源码视图标题 / 代码块折叠并接通命令 | `6965349` |
| 5   | 特殊块统一边界光标与删除行为        | `baae99f` |

门禁与验证总表见文末第 7 节。以下每项按「实现 → 验证（含**反向验证**：证明旧行为会失败）→ 未验证范围」写。

---

## 1. 分割线统一输出 `---`

### 实现

- `markdown/deskEditorConfigs.ts`：`remarkStringifyOptionsCtx` 增加 `rule: '-'`
  （`mdast-util-to-markdown` 的选项，默认 `*`）。斜杠菜单插入的 `thematicBreak` 与可视化编辑器
  序列化因此统一写 `---`。
- **只改输出**：`---` / `***` / `___` 的解析照旧（micromark 层面就都支持），没有全局字符串替换，
  也没有批量改写历史文件。
- 源码模式不受影响：未开 Prettier 时逐字保留；开 Prettier 时由 Prettier 输出（实测
  `prettier.format(src, { parser: 'markdown' })` 把 `***` / `___` 都转成 `---`，与本次改动一致）。

### 验证

- **canonical 快照**（`markdown/deskEditorCanonical.test.ts`，装配层逐字节闸门）：
  - 新增 6 个边界用例：文首、紧邻段落（无空行，最容易写成 Setext 标题）、紧邻标题、
    列表与引用容器内、代码围栏内（`***` / `---` / `___` 必须逐字保留）、frontmatter 之后。
  - 重新录制基线后**逐条复核 diff**：只有 `thematic-break-forms` 由 `***` 变 `---`，
    其余 21 个用例逐字节未变（说明没有连带漂移）。
- 关键产物（重新录制后的实际输出）：
  - `上面\n\n---\n\n下面\n`（无空行输入也补出空行，不会被解析成 Setext 标题）
  - `---\nid: thematic-after-fm\n---\n\n---\n\n# 正文\n`（不与 frontmatter 粘连）
  - `- 列表项一\n\n  ---\n\n- 列表项二\n\n> 引用\n>\n> ---\n`（容器内仍是分割线）
  - 代码围栏内：` ```md\n上面\n\n***\n\n---\n``` `（代码内容逐字保留）
- **反向验证**：未加 `rule` 时快照对该用例报 `expected '上面\n\n***…' to be '上面\n\n---…'`，
  即旧行为确实输出 `***`。
- 受影响的 E2E：`e2e-fidelity.mjs`（断言源码模式默认不重排、库级开 Prettier 后 `***` → `---`）
  在全量回归里通过。

### 未验证范围

- 可视化视图里**编辑其它块**时，未编辑的分割线块是否逐字保留由 `sourcePreservation` 决定
  （既有机制，本轮没改）。若某次保存确实重排了整篇，`***` 会变 `---` —— 与既有
  `___` → `***` 属同一类规范化，本轮把目标形态改成 `---`。

---

## 2. 源码模式中文标点黄色警告框

### 实现

- `monaco/monaco.ts` 的 `baseEditorOptions()`（源码编辑器与只读文本查看器共用）增加：
  `unicodeHighlight: { allowedLocales: { 'zh-hans': true, 'zh-hant': true } }`。
- 机理（读 Monaco 0.56 源码确认）：`allowedLocales` 默认 `{ _os, _vscode }`，两者解析后若都命中不了
  内置语言表就回退兜底表 `_default`，那里把 `（）、，；？` 等全角标点判为"与半角易混淆"；
  语言表按交集取，且表里只有 `zh-hans` / `zh-hant`（写 `zh` 命中不了）。
- 只改显示策略：不替换标点、不改文件、不新增设置项，也没有关掉整个 Unicode 高亮。

### 验证

- 新增 E2E `e2e-source-unicode-highlight.mjs`（按**行**断言黄框数量，深浅主题各一轮，
  并先等到"该提示的行确实提示了"再断言"不该提示的行为 0"，避免高亮未算完的假通过）：**16/16**。
  - 中文全角标点（纯中文行 / 与数字混排 / 与拉丁文混排）三种真实样例：0 个黄框。
  - 保留能力：西里尔 `а`（真混淆）1 个、`U+200E` LRM（异常不可见字符）1 个 —— 两主题一致。
  - 查看与切换主题不改文件字节、不把标签标脏。
- **反向验证**（同一套件，修复前）：混排行读到 **4** 个、拉丁混排行 **3** 个黄框（两主题均失败），
  即旧行为确实会画框。探针同时给出确证：紧邻中文词的标点本来就不会被画框
  （Monaco 的"词里没有 ASCII 就放过"规则），所以探针必须用混排行才有效。
- 截图产物：`scripts/shots/source-unicode-highlight/source-unicode-highlight-{light,dark}.png`。

### 未验证范围

- 只覆盖 Markdown 源码视图与只读文本查看器（同一份 `baseEditorOptions`）；
  Monaco 关闭 worker 后没有别的语言服务参与，不影响本项。
- 视觉观感（黄框是否真的消失）已由截图 + 按行计数覆盖，仍需人工复核一遍截图。

---

## 3. 源码模式跨行选区背景越界

### 复现与根因（用户给的候选根因成立）

复现（用户给的那段 Markdown，反向跨行选择）实测：

- `.cslr.selected-text`（选区色块）在选区起点左侧多出 **10px**，其正上方是同位置的遮罩
  `.cslr.monaco-editor-background top-left-radius bottom-left-radius`，而它的
  `background-color` 计算值是 **`rgba(0, 0, 0, 0)`（透明）** → 蓝块原样露出。
- 采样像素（浅色主题、DPR=2）：带子左边缘 `rgb(173, 214, 255)` = 选区色 `#add6ff`。
- Monaco 源码佐证：`selections.js` 用 `ROUNDED_PIECE_WIDTH = 10` 先画选区色块，再用
  `EDITOR_BACKGROUND_CLASS_NAME = 'monaco-editor-background'` 的遮罩（反圆角）盖掉多余部分；
  遮罩底色来自 `editor.css` 的 `.monaco-editor-background { background-color: var(--vscode-editor-background) }`。

Desk 侧的问题代码：`MarkdownSourceEditor.vue` 的
`.markdown-editor .margin, .monaco-editor-background { background: inherit }` —— 把遮罩也写成了透明。

### 实现

把覆盖收窄，遮罩保留主题背景色：

```css
.markdown-source-editor :deep(.monaco-editor .monaco-editor-background:not(.cslr)) {
  background: inherit;
}
```

（行号槽与正文层的既有视觉不变；`.lines-content` 仍是 `background: inherit`。）

### 验证

- 新增 E2E `e2e-source-selection-background.mjs`：**21/21**，覆盖浅/深主题、反向与正向跨行选择、
  中英混排折行长句、行尾/换行边界。断言分两类：
  - 计算样式：每个"10px 选区块 + 遮罩"对的遮罩底色不再是透明（浅 `rgb(255,255,255)`、
    深 `rgb(27,27,31)`，即主题背景）。
  - **像素**（sharp 解 Playwright 截图）：带子左边缘像素 = 编辑器背景色（不再是被盖住的选区色）；
    对照项：选区内部仍有大量选区色像素（浅色主题命中 2001 px）。
  - **运行中前后对照**：注入旧的 `background: inherit` 覆盖后，遮罩立刻变回透明、带子像素回到
    选区色 `rgb(173,214,255)` / `rgb(38,79,120)` —— 因果链在同一轮里闭合。
  - 编辑语义未受影响：`Cmd+X` 剪贴板内容严格等于实际选区（反向选择 71 字符、正向 76 字符），
    一次撤销恢复全部内容，磁盘文件逐字未变。
- 截图产物：`scripts/shots/source-selection-background/selection-{light,dark}.png`。

### 未验证范围

- 真实鼠标拖选（本套件用键盘 Shift+方向键构造选区；鼠标拖选走同一份选区渲染代码）。
- 选中行含折叠区域 / 搜索高亮叠加时的观感。
- 多光标（多处选区）场景。

---

## 4. 源码视图支持标题、代码块折叠并接通命令

### 实现

- 新增纯函数模块 `markdown/sourceFolding.ts`：
  - **标题章节**：ATX 标题（`#`..`######` 且后面是空白或行尾）折到「下一个同级或更高级标题的上一行」，
    最后一个章节到文末；空章节（下一行就是同级标题）不产出范围。
  - **围栏代码块**：` ``` ` 与 `~~~` 都支持，折**整块**（起始围栏 → 闭合围栏；未闭合折到文末），
    更长的围栏才闭合、缩进 ≤3 空格算围栏、反引号围栏的 info string 含反引号不算围栏。
  - **围栏内的 `#` 不算标题**（单遍扫描跟踪围栏状态）。
- `monaco/monaco.ts` 注册 markdown 的 `registerFoldingRangeProvider`（一次性）；不注册时 Monaco 会退回
  按缩进折叠，代码围栏起始行只能折缩进片段。
- `MarkdownSourceEditor.vue` 暴露 `applyHeadingFold(command)`：把命令翻译成"要作用的标题行"
  （`headingFoldTargetLines`），交给 `editor.fold` / `editor.unfold`，并带
  `levels: 1, direction: 'down'` —— 不带这两个参数时 Monaco 的 Fold 在"该行已折叠"时会向上折父级
  （键盘连按语义），我们要的是按标题行精确操作。
- `NoteTabPane.vue` 的折叠 runner 改为**按当前活动视图分发**（复用既有的 `markdownEditor` 计算属性：
  源码 = Monaco，其余 = 可视化编辑器）；非活动标签不碰 runner。

### 验证

- 单测 `markdown/sourceFolding.test.ts`：**11/11**（多级标题、相邻/空章节、最后章节、反引号与波浪线
  围栏、未闭合围栏、缩进围栏、info string 反引号、代码里的伪标题不切断外层章节、
  命令 → 标题行映射（`fold-all` 不含代码块行、按级别只取该级））。
- 新增 E2E `e2e-source-folding.mjs`：**17/17**
  - **真实点行号槽的折叠箭头**：代码围栏（反引号）折掉块内伪标题、`const a = 1` 与结尾围栏，
    块后正文仍在；块里的伪标题**没有**箭头；波浪线围栏同样折整块；标题折到下一个一级标题之前。
  - **命令面板**（Cmd+Shift+P → `全部折叠标题`）：所有标题章节折叠，而代码块**没有被折**
    （`const a = 1`、`波浪线里的内容` 仍可见）—— 证明没有悄悄变成"折叠所有类型的块"。
  - `全部展开标题`、`折叠/展开 2 级标题` 只动该级。
  - 折叠是显示状态：磁盘文件逐字未变、标签不脏。
  - 切到可视化视图后同一命令折的是可视化编辑器（`.desk-heading-section--collapsed` > 0），
    展开也正常 —— 原行为不回归。
  - 换标签页后命令只作用于当前活动编辑器。
- 受影响的 E2E：`e2e-code-exit`、`e2e-block-interactions`、`e2e-list-fold`、`e2e-fidelity` 等在全量回归里通过。
- 截图产物：`scripts/shots/source-folding/fold-{code-block,heading,all-command,visual}.png`。

### 未验证范围

- 源码视图与可视化视图之间的折叠状态**不同步**（验收明确不要求）。
- setext 标题（`===` / `---` 下划线式）不作为折叠起点；本轮只认 ATX。
- 折叠状态是否随笔记切换/重开而保留由 Monaco 自己管理，本轮没有断言（也没有改）。
- 人工观感（箭头位置、折叠后滚动位置）需复核截图或实机。

---

## 5. 特殊块统一边界光标与删除行为

### 现状盘点（实施范围要求）

- 已有机制：`markdown/blockBoundaryCaret.ts`（自研 `BlockBoundaryCaret` 选型 + 块外覆盖层画的**可见光标**）
  与 `markdown/blockBoundaryNavigation.ts`（键位状态机）。
- 「停靠块」（方向键）原有集合：`code_block`、`table`、独立成段的图片段落、
  非隐藏的 `deskRawBlock`（组件 / 容器 / 图表 / 代码组 / 纯 HTML）。**callout / 引用 / 列表不算**
  （它们是可直接放光标的文本流，方向键必须能直接进）。
- 缺口：`Backspace` / 前向 `Delete` 在段落边缘**没有**走边界通道，于是落到 PM 的默认行为：
  - callout 后被 PM 的 `joinBackward` 选中成 `NodeSelection`（"不明显的块选中态"）；
  - 图片段落被直接并进/删掉；
  - 代码块后被并进代码块内部文字末尾（并触发"内容被并入其它块"的保存拦截）。

### 实现

- 新增纯函数 `edgeBoundaryTargetForDelete(state, 'Backspace' | 'Delete')`：
  - 只在**段落**（`paragraph`）且**紧邻**特殊块时接管（标题行首 Backspace 的既定语义
    「一次直接回正文」优先，代码块内部不接管）；
  - `Backspace` 要求光标在该段落**内容起点**，落点是前一个块的 `after` 侧；`Delete` 要求光标在
    **内容末尾**，落点是后一个块的 `before` 侧；
  - 只算落点，不改文档、不插占位字符。
- 边界集合分两层（这是本项最容易踩的地方）：
  - `isBoundaryStopBlock`（窄，方向键用）**不变** —— 否则方向键会在 callout 外多停一站，
    `deskCalloutView` 里"从上方 ↓ 进标题 / 从下方 ↑ 进正文"的既有路径会被挡掉；
  - 新增 `isBoundaryDeleteBlock`（宽 = 窄集合 ∪ 提示块家族），只用于「本规则落点 + 光标状态识别
    - 可见光标渲染」。`activeBlockBoundaryTarget` 与 `BlockBoundaryCaret.map` 用宽集合，
      这样停在 callout 边界的可见光标能渲染、也能被键位识别。
- 光标停在 callout 边界时的方向键也有出口（否则会落到 PM 的 gapcursor 分支）：
  右下角 `↑/←` 回正文末尾（复用 `enterCalloutFromBelow`）、左上角 `↓/→` 进标题 chrome
  （复用 `focusCalloutTitleInput`）。
- 长按重复事件不额外拦截：`event.repeat` 不参与判断，连按就是"落点 → 删块 → 继续删"。
- 第二个键由既有 `handleAtBoundary` 处理（`after` + Backspace / `before` + Delete = 删整块），
  删除后 `placeAfterDelete` 保证光标落到有效位置。

### 验证

- 单测（`markdown/blockBoundaryCaret.test.ts` 新增 9 条，文件共 17/17）：代码块两方向、
  独立图片、callout、代码组、**长按 `repeat: true`**、段中/相邻普通段落的反例（不接管）、
  callout 边界上的方向键出口。
- 新增 E2E `e2e-boundary-delete.mjs`：**21/21**，真实按键 + 编辑器自带的 PM state 探针
  （`window.__deskNavProbe()` 读选区类型 / 贴哪一侧 / 贴着哪类块）+ DOM 里的可见光标元素
  - 顶层块清单：
  * 提示块后 / 图片后 / 代码块后（段首 Backspace）与代码组前（段尾 Delete）：
    第一下 `selection: 'BlockBoundaryCaret'` + 可见光标（`data-side`）+ **块清单逐项未变**；
    第二下**只**少掉光标贴着的那一块；一次撤销完整恢复。
  * 文档末尾：尾随**空段落**紧跟在代码块之后，同样两下删块、空段落保留、撤销恢复。
  * 反例：段内还有字时先正常删字（不落到块边界）。
- **反向验证**：临时关掉新逻辑后同一套件 **9/18 失败**，并复现了原始症状 ——
  callout 第一下变 `NodeSelection`；图片段落第一下就被删（块清单少一项）；
  代码块第一下把光标带进代码内部（`cm: {line:1, head:11}`）并触发
  `[desk] 保存被拦截：检测到原文内容被并入其它块`。
- 受影响的 E2E（全量回归里通过）：`e2e-block-boundary-navigation`（53/53）、`e2e-block-interactions`、
  `e2e-empty-break-deletion`、`e2e-code-exit`、`e2e-block-clear-line-styles`、`e2e-markdown-input`
  （标题行首 Backspace 直接回正文这条断言曾因本项回归，已修：本规则只认段落）、
  `e2e-image-caption`、`e2e-image-copy-plain-text`（图片描述输入 / 复制粘贴不回归）。
- 截图产物：`scripts/shots/boundary-delete/boundary-{before,after}.png`。

### 其余特殊块是否适用（明确结论）

| 块类型                                                          | 是否适用本规则       | 说明                                   |
| --------------------------------------------------------------- | -------------------- | -------------------------------------- |
| 普通代码块 `code_block`                                         | 适用                 | 窄集合里，方向键与删除都停靠           |
| 代码组 / 组件 / 容器 / 图表 / 纯 HTML（`deskRawBlock`，非隐藏） | 适用                 | 同上                                   |
| 提示块家族（callout / tip / warning…）                          | 适用（**仅删边界**） | 方向键仍可直进正文，见上面的两层集合   |
| 独立成段的图片段落                                              | 适用                 | 行内 atom 包在段落里，按整块处理       |
| 表格 `table`                                                    | 适用（按同一规则）   | 在窄集合里；本轮 E2E 未单列表格用例    |
| 引用 / 列表                                                     | **不适用**           | 它们是可直接放光标的文本流，走 PM 默认 |
| 隐藏块（frontmatter / 生成目录）                                | 不适用               | 既有 `hidden` 判据                     |

### 未验证范围

- 表格的段首/段尾删除用例（规则上适用，E2E 未单列）。
- 嵌套容器（例如 callout 正文里的段落紧跟一个代码块）只在单测层面隐式覆盖，E2E 未单列。
- **真实 OS 长按自动重复**：单测用 `repeat: true` 的合成事件、E2E 用两次连续按键覆盖；
  没有按硬件重复速率验证。
- macOS 上 `fn+Backspace`（前向删除）在真机键盘上的按键映射未单独验证；
  E2E 用的是 Playwright 的 `Delete`（即前向删除）。
- 重做（`Cmd+Shift+Z`）未单独断言（撤销已断言）。
- 图片"有无描述"两种情况：本项 E2E 用的图片没有描述；有描述的图片由 `e2e-image-caption` 覆盖
  （边界导航不接管描述输入框的按键）。

---

## 6. 本轮新增/改动的 E2E 套件与注册表

| 套件                                  | 覆盖    | 注册表                                               |
| ------------------------------------- | ------- | ---------------------------------------------------- |
| `e2e-source-unicode-highlight.mjs`    | 第 2 项 | 新增，`area: editor`，`serial: false`                |
| `e2e-source-selection-background.mjs` | 第 3 项 | 新增，`locks: ['clipboard']`（读剪贴板验证剪切内容） |
| `e2e-source-folding.mjs`              | 第 4 项 | 新增，`area: editor`                                 |
| `e2e-boundary-delete.mjs`             | 第 5 项 | 新增，`area: editor`                                 |

注册表单测（`scripts/e2e-registry.test.mjs`）同步更新：**18/18**。

---

## 7. 门禁与验证结果（本轮最终状态）

| 项目   | 命令                                 | 结果                                               |
| ------ | ------------------------------------ | -------------------------------------------------- |
| lint   | `pnpm --filter desk lint`            | 0 error / 41 warning（与改动前同一批既有 warning） |
| 单测   | `pnpm --filter desk test`            | 见下方「最后一次全量」                             |
| 类型   | `pnpm --filter desk typecheck`       | 通过                                               |
| 构建   | `pnpm --filter desk build`           | 通过                                               |
| 格式化 | 根目录 `pnpm format:check`           | 通过（必须用根目录，见 `apps/desk/AGENTS.md`）     |
| E2E    | `node apps/desk/scripts/run-e2e.mjs` | 见下方「最后一次全量」                             |

最后一次全量结果（本轮收尾时执行）：

- 单测：`181 文件 / 1640 条` 全部通过（20.8s）
- E2E（regression 全量）：`43/43 套件通过`（157.1s，regression 全量）

分项执行过的定向 E2E（均通过）：`e2e-source-unicode-highlight` 16/16、
`e2e-source-selection-background` 21/21、`e2e-source-folding` 17/17、
`e2e-boundary-delete` 21/21、`e2e-block-boundary-navigation` 53/53、
`e2e-markdown-input`、`e2e-block-interactions`、`e2e-empty-break-deletion`、`e2e-code-exit`、
`e2e-clear-line-styles`、`e2e-fidelity`。

---

## 8. 剩余问题与已知限制（不是"遗留项"式的模糊说法）

1. **第 1 项**：可视化视图保存时若发生整篇重排，文件里的 `***` 会变成 `---`（`___` 本来就变 `***`，
   同一类规范化）。未编辑块的逐字保留仍由既有 `sourcePreservation` 负责，本轮没动它。
2. **第 4 项**：setext 标题不参与折叠；源码与可视化的折叠状态不同步（验收不要求）。
3. **第 5 项**：表格、嵌套容器、真实长按重复速率、`fn+Backspace` 真机映射、重做未单独验证
   （见 5 节「未验证范围」）。
4. 三项与观感有关的验证（黄框消失、选区几何、折叠箭头）都提供了**截图 + 像素/几何断言**，
   但仍建议复核方在隔离 fixture 之外用真实笔记扫一眼。
