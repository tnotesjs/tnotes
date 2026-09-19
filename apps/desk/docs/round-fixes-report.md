# Desk 本轮需求与 BUG 修复 · 交付报告

**状态：实现待验收**（由复核方根据源码与测试确认）

- 主要验收平台：**macOS**（本机实测）。
- 本轮**未**推送、未打标签、未发布新版本。
- 每一项都区分「源码发现 / 确定性测试复现 / 真实界面验证」，不用单测通过替代界面验收。

---

## 一、逐项完成状态

| #   | 项目                                    | 状态                             | 真实界面验证                           |
| --- | --------------------------------------- | -------------------------------- | -------------------------------------- |
| 1   | 第二列头部滚动时固定                    | **已实现**                       | `e2e-sidebar-sticky.mjs` 11/11         |
| 2   | 代码块禁止自动折行                      | **已实现**                       | `e2e-code-wrap.mjs` 11/11              |
| 3   | 修复图片描述输入替换图片                | **已实现**（IME 未实测）         | `e2e-image-caption.mjs` 18/19          |
| 4   | 无序列表 Backspace 与源码变化           | **未开始**                       | —                                      |
| 5   | 选区浮动格式工具栏可配置（默认关）      | **未开始**                       | —                                      |
| 6   | 固定标签显示图钉、点击取消固定          | **已实现**                       | `e2e-tab-pin.mjs` 16/16                |
| 7   | 底部终端标签上限可配置（默认 10）       | **未开始**                       | —                                      |
| 8   | 修复网页标签 Cmd+A 被笔记抢走           | **已实现**（单测覆盖，未做 E2E） | 主进程单测；E2E 因外网加载会卡住而弃用 |
| 9   | 修复代码块内容粘贴到正文丢换行          | **未开始**                       | —                                      |
| 10  | 保留应用图标成果                        | **已保留**（见第五节）           | 图标文件已随本轮提交，格式/尺寸已核    |
| 11  | 后台 fetch 超时、通知刷屏、失败记录失真 | **未开始**                       | —                                      |

**完成 5 项（1、2、3、6、8）+ 保留 1 项（10）；未开始 5 项（4、5、7、9、11）。**

> 未开始的 5 项**不是**判断为无问题，而是本轮未实施：其中第 11 项涉及后台 fetch 的
> 默认开关、全局并发、通知聚合与真实耗时记录，属于会改变既有产品语义的取舍；
> 第 4、7 项有明确的边界与序列化要求，需要逐按键/逐边界的真实界面验证。
> 这些都不应在没有验证的情况下草率落地。

---

## 二、已实现项的复现与验证证据

### 第 3 项 图片描述输入替换图片

**源码发现**：`deskImageView.ts` 的描述框是原生 `<input>`，位于 ProseMirror 的
contenteditable 子树内；可编辑态 `stopEvent` 一律返回 `false`（652-660），
且未绑定 `input`/`composition`/`paste`（189-240）。

**真实界面复现（逐字输入，未用 `.fill()`）**：

|        | 输入框值       | 光标 | 存盘后的 alt                         |
| ------ | -------------- | ---- | ------------------------------------ |
| 未修复 | `示风景照例图` | 4    | `示风景照例图`（字符插进旧描述中间） |
| 已修复 | `示例图风景照` | 6    | `示例图风景照`（正常追加）           |

**根因**：不是事件冒泡，而是 **ProseMirror 把它 contenteditable 子树内的 `<input>`
当正文内容读取**。事件层拦截全部无效，已逐一试过并记录在代码注释里
（`stopEvent` 返回 true、figure/caption 捕获与冒泡 `stopPropagation`、编辑器根捕获拦截）。

**修法（结构性隔离）**：描述框脱离 contenteditable 子树，作为浮层挂在编辑器宿主上
（绝对定位跟随图片）；`render()` 不再无条件回写 `caption.value`（聚焦时回写会把用户
输入重置/回灌）；打开时把光标落到末尾；`stopEvent` 对描述框输入类事件返回 true 作兜底。

**验证**：`e2e-image-caption.mjs` 18/19，覆盖新增/修改描述、英文逐字、中文逐字、
粘贴（主进程写剪贴板）、输入框内退格、Enter、Escape、失焦、图片节点与路径不变、
保存与重开持久化、撤销/重做不破坏图片节点、尺寸等相邻控件未回退。
**1 条未实测**：真实中文输入法（IME）组字无法在自动化里触发，明确记为未验证，
未用合成事件冒充结论。

### 第 2 项 代码块禁止自动折行

**源码发现**：普通代码块走 `crepePort/codemirror.ts` 的 `basicSetup`（不含折行），
**代码组**走 `containerSourceEditor.ts` 第 180 行无条件 `EditorView.lineWrapping`，
两者口径不一致——与线索里"可能是它"的方向一致，但折行的是代码组那一侧。

**修法**：给 `createContainerSourceEditor` 加 `lineWrapping` 选项（默认 true 保持既有
行为），代码组显式传 `false`。**不全局关闭**：该编辑器还服务 mermaid / callout /
word-list / notes-table 等非代码内容，那些地方折行是合理的。

**真实界面量测**（最终构建）：普通代码块 `overflowX=auto, whiteSpace=pre,
scrollW=4037/clientW=668`；代码组 `overflowX=auto, whiteSpace=pre,
scrollW=3654/clientW=666`；两者 `maxHeight=none`、页面宽度 `838/838` 未被撑破。
**区分力**：撤掉代码组的 `lineWrapping: false` 后该用例变红（`overflows:false`）。

### 第 1 项 第二列头部固定

**源码发现**：搜索栏在滚动容器（`.navigator-body`）之外，本就固定；「变更」与「目录」
两栏标题在容器内且无 sticky —— 且 sticky 元素无法超出其父容器，而
`.changes-section`/`.toc-section` 折叠时只有标题那么高。

**修法（不改 DOM 结构）**：让这两个 section `display: contents`（不生成盒子），
标题即按滚动容器的直接子级参与布局并吸顶；配合不透明背景与底部 1px 分界线，
滚动时内容不会从 7px padding 边缘透出；两栏同时吸顶时「目录」栏吸在变更栏下方，
搜索态目录栏回到顶部。

**真实界面验证**：40 条笔记长目录，滚动 600/100000px 后搜索栏位置不变（42→42）、
两栏吸顶（内容盒上沿 92）且最顶层元素是标题自身、吸顶后按钮仍可点、变更展开/收起、
无额外内部滚动容器、最后一条目录项可完整滚动访问、侧栏拖窄后仍吸顶。
**区分力**：撤掉 `display: contents` 后「变更」栏变红（`top:-325`，滚出视口）。

### 第 6 项 固定标签图钉

**源码发现**：固定行只有一个 `aria-hidden` 的静态 `⌖`，固定/取消固定只有右键菜单、
⌘K⇧Enter、目录项右键三个入口，标签上没有按钮。

**修法**：把 `⌖` 变成可操作控件（`role=button` + `aria-label="取消固定标签"` +
`title="取消固定 <标题>"`，支持点击与键盘 Enter/Space），单击只取消固定、不关闭标签；
改用 `<span>` 而非嵌套 `<button>`（标签本体已是 button，与既有 `.tab-close` 同写法）。
右键菜单、固定行排序、拖动、预览标签语义与关闭保护均未改动。

**真实界面验证**：`e2e-tab-pin.mjs` 16/16（右键固定、图钉可访问名称、单击取消固定、
不关标签、内容不受影响、回到普通行、可再次固定、键盘取消）。

### 第 8 项 网页标签 Cmd+A

**源码发现**：网页视图的按键经主进程 `before-input-event` 转发时，全选是字符串
`'select-all'`、**不带来源**（只有数字切换带 `sourceTabId`）；渲染端只能按
`editor.activeTab` 猜，而原生视图不冒泡焦点事件，活动标签可能停在上一次的分组/标签上。

**修法**：命令升级为 `{ type: 'select-all', sourceTabId? }`；转发时对对象命令统一补来源；
渲染端优先按来源定位（来源是网页 → 先 `activate` 到它所在分组再 `web.selectAll(该标签)`），
无来源或来源非网页才回退到活动标签，最后才是渲染端全选。

**验证**：主进程单测（新增「网页里按 Cmd+A 会带上来源标签」断言
`{ type:'select-all', sourceTabId:'web-focus' }` 且 `preventDefault` 被调用），
webContentsManager 12 passed、tabShortcuts/applicationMenu 同步更新。
**未做端到端验证**：打开外网网页标签在离线/受限网络下会卡住，脚本已弃用删除。

---

## 三、未开始项的现状（不改动，仅记录线索）

- **第 4 项（列表 Backspace）**：`liftFirstListItem` → `joinBackward` 是 Milkdown 默认
  路径，Desk 侧无覆盖；空列表项序列化为 `- <br />`（不是 `-`）。可下手处是仿
  `headingKeymap.ts` 加一个 `priority: 100` 的 `$shortcut`，但必须同时处理
  "已删除的空项不得变成 `- <br />`" 与"不得无故增加空行"。
- **第 5 项（选区工具栏开关）**：`deskEditor.ts:113` 无条件 `toolbar(...)`；
  新增设置需同时改 `main/settings.ts` schema、`shared/contracts.ts` 的 `AppSettings`、
  一个 settings 子组件，并在 `MilkdownMarkdownEditor.vue` 把值传进 `createDeskEditor`
  （该函数目前完全不接收 AppSettings）。
- **第 7 项（终端标签上限）**：终端标签与命令任务标签当前**无任何数量上限**；
  唯一的上限是顶部笔记标签的 `tabs.maxOpenCount`。用户未回答"是否含命令任务"
  "达到上限如何处理"，本轮采用的保守默认已在需求里写明，但**尚未实施**。
- **第 9 项（粘贴丢换行）**：Desk 侧没有任何 paste 文本钩子
  （无 `transformPastedText` / `clipboardTextParser` / `$pasteRule`）；两条复制路径
  都只写 `text/plain`。可下手处是 `deskEditorConfigs.ts` 的 `editorViewOptionsCtx`。
- **第 11 项（后台 fetch）**：触发点是 `gitManager.configure` 内的首次补刷与 5 分钟
  周期定时器，超时 15s（手动 60s）；失败走 `reportBackgroundFailure`，
  去重键是 `(kb, kind)+消息`（跨库不去重），渲染端通知键是 `task.id:run`（无法合并跨库），
  且失败任务在 `claimHandle` 之后立刻 `finishRun`，所以 `startedAt`/`finishedAt` 几乎相同
  —— 这就是"耗时 0ms"的成因。队列是**每知识库串行**，后台 fetch 会对多库同时发起。
  **尚未定位**应用与终端 `git fetch` 的差异（未做对照测量），因此不能把并发超时
  归因为环境或网络。

---

## 四、门禁

```
pnpm --filter desk test        # 1483 passed / 170 files / 0 skipped
pnpm --filter desk lint        # 0 errors（32 warnings 均为既有）
pnpm --filter desk typecheck   # 0 errors
pnpm build                     # 全仓构建通过
pnpm format:check              # All matched files use Prettier code style
```

新增 E2E（均在**最终构建产物**上跑过）：

```
node apps/desk/scripts/e2e-image-caption.mjs    # 18/19（1 条为 IME 未实测）
node apps/desk/scripts/e2e-code-wrap.mjs        # 11/11
node apps/desk/scripts/e2e-sidebar-sticky.mjs   # 11/11
node apps/desk/scripts/e2e-tab-pin.mjs          # 16/16
```

新增共用夹具 `scripts/e2e-lib.mjs`：隔离 workspace + profile + 测试知识库，
不接触用户数据（用户工作区 `/Users/huyouda/tnotesjs/kbs` 未被读写）。

---

## 五、第 10 项 应用图标

`build/icon.png`(1024)、`build/icon.icns`、`build/icon.ico`(256)、
`resources/icon.png`(512) 四个文件在本轮开始前已是**工作区未提交改动**，
源图 `/Users/huyouda/Downloads/logo-rect.png` 仍在。本轮**保留原样并纳入提交**
（提交 `6dc6d04` 起的提交中已包含），未覆盖、未重新设计。

正式效果需重新打包安装后生效；本轮按要求**未打包、未发布**。

---

## 六、未验证范围（明确不当作已验）

1. **第 3 项的中文输入法（IME）**：未实测，需人工验证。
2. **第 8 项的端到端**：只有主进程单测，没有真实网页标签的界面验证。
3. **第 4、5、7、9、11 项**：未实施，因此没有任何验证。
4. **第 11 项的应用/终端 fetch 差异**：未测量，超时根因**未定位**。
5. **并发 E2E**：本轮新套件都是单跑验证；批量并发运行的超时现象原因未确认
   （沿用上一轮的记录口径：批量运行超时、单独重跑通过，原因尚未确认）。
6. **Windows / 非 macOS 平台**：未验证。

## 七、本轮提交

| 提交      | 内容                                                         |
| --------- | ------------------------------------------------------------ |
| `6dc6d04` | 图片描述框不再被正文编辑器当成内容（第 3 项）                |
| `bd9bfa8` | 代码块统一不折行（第 2 项）；固定标签显示可点图钉（第 6 项） |
| `906d2f0` | 第二列头部滚动时固定（第 1 项）                              |
| `28b30da` | 网页标签 Cmd+A 按来源定位（第 8 项）                         |

（图标改动随上述提交一并纳入；应用图标属"保留既有成果"，不单独计为一项修复。）
