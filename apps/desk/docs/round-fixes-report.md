# Desk 本轮需求与 BUG 修复 · 交付报告

**状态：本轮范围已实现，待验收**（第二至第五轮验收意见 + 0.10.1 回归修复，见第八至十二节）

- 已完成并有真实界面验证：第 1、2、4、5、6、7、9、11 项。
- 已实现并有界面验证，但**有一项检查未执行**：第 3 项（IME 未实测）、第 8 项（本地页 E2E）。
- 已保留成果：第 10 项。
- **未实施：无。**
- 本报告不把「已实现」等同于「已验收」：每一项都注明验证手段与实际通过数，
  未执行/未实施的检查**单独列出**，不并入通过数。

- 主要验收平台：**macOS**（本机实测）。
- 本轮**未**推送、未打标签、未发布新版本。
- 每一项都区分「源码发现 / 确定性测试复现 / 真实界面验证」，不用单测通过替代界面验收。

---

## 一、逐项完成状态

| #   | 项目                                    | 状态                   | 真实界面验证                                      |
| --- | --------------------------------------- | ---------------------- | ------------------------------------------------- |
| 1   | 第二列头部滚动时固定                    | **已实现**             | `e2e-sidebar-sticky.mjs` 11/11                    |
| 2   | 代码块禁止自动折行                      | **已实现**             | `e2e-code-wrap.mjs` 11/11                         |
| 3   | 修复图片描述输入替换图片                | **已实现，界面待验证** | `e2e-image-caption.mjs` 26/26；**IME 未执行**     |
| 4   | 无序列表 Backspace 与源码变化           | **已实现**             | `e2e-list-backspace.mjs` 13/13                    |
| 5   | 选区浮动格式工具栏可配置（默认关）      | **已实现**             | `e2e-selection-toolbar.mjs` 12/12                 |
| 6   | 固定标签显示图钉、点击取消固定          | **已实现**             | `e2e-tab-pin.mjs` 16/16                           |
| 7   | 底部终端标签上限可配置（默认 10）       | **已实现**             | `e2e-bottom-panel-capacity.mjs` 28/28             |
| 8   | 修复网页标签 Cmd+A 被笔记抢走           | **已实现，界面待验证** | 本地页 E2E `e2e-web-select-all.mjs` 14/14；见下注 |
| 9   | 修复代码块内容粘贴到正文丢换行          | **已实现**             | `e2e-paste-newlines.mjs` 11/11                    |
| 10  | 保留应用图标成果                        | **已保留**（见第五节） | 图标文件已随本轮提交，格式/尺寸已核               |
| 11  | 后台 fetch 超时、通知刷屏、失败记录失真 | **已实现**（见第三节） | `e2e-git-background-fetch.mjs` 17/17              |

**已实现 11 项（1-9、11）+ 保留 1 项（10）。**

> 「已实现，界面待验证」的口径：
>
> - 第 3 项：产品修复已完成并有 26 条界面断言通过，但**中文输入法（IME）实测未执行**，
>   因此不列入「真实界面验证完成」；详见第二节与第六节。
> - 第 8 项：验证用的是**本地可控 HTTP 页面**（不是外网），已在真实应用里驱动
>   `before-input-event`；外网加载失败与本次结论无关。

> 第 3 项的 IME、第 11 项的 ssh agent 差异属**未执行/未验证**，单列在第六节；
> 它们不是失败，也不被算作通过。

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

**验证**：`e2e-image-caption.mjs` **26/26 通过**，且这 26 条全部是**已执行并断言通过**的
检查（新增/修改描述、英文逐字、中文逐字、粘贴（主进程写剪贴板）、输入框内退格、Enter、
Escape、失焦、图片节点与路径不变、保存与重开持久化、打开时光标落末尾、浮层跟随滚动、
开关标签页后无残留浮层、撤销/重做不破坏图片节点、尺寸等相邻控件未回退）。

**另有 1 条检查未执行**（不计入上表的 26，也不计入失败）：**真实中文输入法（IME）组字**。
自动化环境无法触发真正的 IME 组字，脚本里以 `NOTE 中文输入法（IME）实测 —— 未执行`
显式标注并保留，**没有**用合成 `compositionstart/compositionend` 事件冒充结论。
也就是说：26/26 是「已执行的检查全过」，**不是**「26 项覆盖了这个场景的全部风险」。

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

**验证（本地可控页面，不是外网）**：`e2e-web-select-all.mjs` **14/14**。
外网加载失败不构成本项放弃 E2E 的理由，所以改用脚本内起的本地 `node:http` 服务
（`/body`、`/input` 两个页面），在真实应用里通过地址栏进入网页标签，再用
`globalThis.__deskWebContentsManager.debugWebContents(tabId)` 驱动真实的
`before-input-event` 通道。覆盖面：网页正文全选、网页输入框全选、网页 + 笔记分屏、
**切换分组之后**再按 Cmd+A。脚本自行过滤 `favicon.ico` 触发的 CSP 噪音，
并只在 `DESK_E2E_EXPOSE_INTERNALS=1` 时暴露上述调试入口（生产构建无此入口）。

主进程单测另有「网页里按 Cmd+A 会带上来源标签」断言
`{ type:'select-all', sourceTabId:'web-focus' }` 且 `preventDefault` 被调用。

---

## 三、已实现项的复现与验证证据（续）

> 第 3、2、1、6、8 项的详细证据见第二节。

### 第 4 项 列表 Backspace 与源码变化

**源码发现 / 复现**：Milkdown 默认把空 `list_item` 的 Backspace 交给
`liftFirstListItem` → `joinBackward`；**再按一次又冒出空项**，存盘序列化成 `- <br />`。

**根因**：实测先试 `joinBackward` 会返回 true、在文本上合并，却**留下结构性空 `list_item`**；守卫不能要求「本项只有一个块」（该场景实测 `childCount` 为 3），
守卫过严会放行到默认行为。

**修法**：新增 `listBackspaceKeymap`（priority 100，与 `headingKeymap` 同一手法），
只处理「空选区的空 `list_item` 且该空块是本项最后一个块」，直接用 `liftListItem`
（schema-list 的标准原语）删除/退出，不经过 `joinBackward`。

**真实界面验证**：`e2e-list-backspace.mjs` **13/13**：逐次按键断言、顶层/嵌套空项、
源码对照无 `- <br />`、无多余空行、有序列表与任务列表回归、松散列表的有意空行保留。

### 第 5 项 选区浮动工具条开关

**修法**：`createDeskEditor` 新增开关参数（默认 `() => false`），**不读 store**、
保持纯装配函数；`crepePort/toolbar/index.ts` 的 `shouldShow` 在关闭时直接返回 false；
设置走 `main/settings.ts` 的 zod 分组 + `shared/contracts.ts` 的 `AppSettings`，
老配置缺字段时由 `.default()` 补 `false`。

**验证现状**：单测覆盖「老配置缺字段补默认 false / 组内缺字段与非法值回退 /
显式开关持久化」；`e2e-selection-toolbar.mjs` 已写好但**尚未在构建产物上跑完**，
所以本项列为「已实现，界面待验证」，**不列入**已验证项。

### 第 9 项 粘贴丢换行

**源码发现 / 复现**：Milkdown 的 clipboard 插件对「只有 text/plain、没有 text/html」
的粘贴走 `markdown 解析 → DOM 序列化 → 再解析`，而 markdown 里**单换行是软换行**
（渲染成空格），行边界在这一步被吃掉。复现证据：剪贴板里是
`const a = 1\n\nconst b = 2\n    indented\nconst c = 3`，粘进正文变成
`const a = 1\n\nconst b = 2 indented const c = 3`。

**修法**：新增 `clipboardNewline` 插件并注册在 clipboard **之前**（ProseMirror 只认
第一个返回 true 的 `handlePaste`）。只接管「无 text/html、无 vscode-editor-data」的
纯文本粘贴：把文本按「段落 / 硬换行」转成 DOM 后交给 ProseMirror 自己的解析器
（`preserveWhitespace: 'full'` 保住行首缩进）。代码块内、富文本、编辑器来源一律放行。

**真实界面验证**：`e2e-paste-newlines.mjs` **11/11**，逐条覆盖
**Cmd+C / 标题栏复制按钮 / 代码组 / 纯文本 / 带 HTML 的剪贴板**；
并核对保存后磁盘换行边界与行首缩进、以及**重开后正文与粘贴结果逐字一致**。

> **落盘格式说明（不是缺陷）**：段落里的换行按 Markdown 硬换行写成**行尾 `\`**，
> 行首的 4 空格缩进按 mdast 的转义写法写成 **`&#x20;   indented`**（空格实体 +
> 3 个字面空格）。两者都来自**既有的序列化路径**（`htmlBreak.ts` 的 `breakMarkdown` +
> mdast 的安全转义），不是粘贴引入的；语义等价由「重开后逐字一致」这条断言证明。

### 第 7 项 底部面板标签上限

**修法**：容量判定收敛成**一份纯规则 + 一个主进程执行入口**——
`shared/bottomPanelTabs.ts`（`planBottomPanelCapacity()` / `pickBottomPanelRecycleVictim()` /
`clampBottomPanelMaxTabs()`）与 `main/bottomPanelTabs.ts` 的 `ensureBottomPanelCapacity()`。
调用点只有 `TerminalManager.create()` 与 `CommandTaskManager.claimHandle()`，都在真正
spawn / 进入保存与 Git 之前，所以被拦时不会留下半成品。

**行为**（按已批准规则）：终端会话与命令任务**合并计数**；默认上限 **10**、区间 1-30；
正好到上限时回收最老的「已结束任务 / 已退出终端」；全部在运行时阻止并给中文原因；
复用已有会话不占新名额；**调低上限只拦新建、不 kill 正在运行的进程**。

**真实界面验证**：`e2e-bottom-panel-capacity.mjs` **28/28**（临时工作区，上限设为 3；
真实进程用本地 `node -e "setTimeout(()=>{},120000)"`，不联网）：开到上限、再开被拦且有
中文提示、被拦后数量不变、已退出终端自动回收并同步移除界面标签、**运行中的进程 pid 仍存活**、
手动关掉已结束的再开成功、命令任务与终端合并计数、复用不占名额、上限 3→1 后进程仍活且
不能再新建、非法值（0 / 31）被拒且配置文件不被改坏。单测另有 14 + 10 条。

### 第 11 项 后台 fetch 差异定位、开关与通知治理

**差异定位（本项核心，未靠关闭自动抓取绕过）**：用临时仓库 + 本地 bare remote / 本地
HTTP 做了 6 组对照（`scripts/diagnose-git-fetch.mjs`，8/8 符合预期，只读 `--dry-run`，
输出无凭据/无 token）。复现出**两处确定差异**，都由应用侧执行姿势造成，不是网络问题：

|     | 结论                                                                                                                    | 证据                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| (a) | 后台超时 **15s**（手动 60s），终端 git 无超时 → 慢于 15s 的远端在后台必定失败，且旧失败路径只写日志、不抛错、不设 error | 远端首包延迟 17s：应用后台 **15008ms 被 SIGKILL、stderr 为空**；同一远端终端 **17086ms 成功**                      |
| (b) | 非交互式凭据：`stdio:['ignore','pipe','pipe']` + `GIT_TERMINAL_PROMPT=0`，需要凭据时不能弹提示                          | 认证远端报 `could not read Username ... terminal prompts disabled`；同一远端加可用 `GIT_ASKPASS` 后 **393ms 成功** |

**未复现（已记录对照）**：`file://` 与本地 HTTP 传输（E1/E2）、PATH（E5：本机两种 PATH
都解析到 `/usr/bin/git` 2.50.1）、代理（E6：`http_proxy` 是共享 env，应用与终端结果一致）。
**ssh agent / `SSH_AUTH_SOCK` 未验证**（无 sshd / ssh 夹具），只做了机制分析，见第六节。

**修法**：新增持久化开关 `settings.git.autoFetch`，**默认关闭**（zod 分组默认 +
`saveSettings` 逐字段合并 + 手写 `AppSettings` 同步；老配置缺分组自动补 false）。
关闭时初次刷新与 5 分钟定时都不抓取；**手动 fetch / pull 完全不走这个开关**。
设置面板新增「Git 与远端」分组并显示上次成功远端检查时间（无则「从未」）。
治理部分：全局并发上限 3 + 同目标去重 + 指数退避 5→60 分钟封顶（成功清零，
`backgroundFetchScheduler.ts`，9 条单测，per-KB 串行语义未动）；后台任务改为**开始时认领、
结束时按真实结果结算**（超时按 code 124 分类，`finishedAt` 单调不回退），**旧「claim 后立刻
finish」的假 0ms 路径已删除**；通知聚合在主进程按 `(库,种)+message` 去抖保留明细，
渲染端 `planFailureNotices` 把 2s 窗口内同种失败合成一条并列出各库。

**真实界面验证**：`e2e-git-background-fetch.mjs` **17/17**（临时工作区 + 本地 bare remote；
A 库有效远端、B/C 库坏远端）：默认关闭时后台任务数 0、手动 fetch 仍成功、时间显示非「从未」、
开开关后产生 3 条后台任务、**多库同时失败只弹 1 条聚合通知**且含 B/C 名、开关落盘为 true、
时间前进、关掉后不再新增、无页面错误。单测 36 条（scheduler 9 + 后台 8 + 失败任务 8 +
settings 4 + 聚合 7），实测失败任务 `ms=81/79`、`bytes=270`（有真实输出与真实时长）。

---

## 四、门禁

全部 11 项落地、工作区无残留改动后，在**同一个提交树**上重跑：

```
pnpm --filter desk test        # 177 files / 1557 passed
pnpm --filter desk typecheck   # node + vue-tsc 均 0 errors
pnpm --filter desk exec electron-vite build   # exit 0
pnpm --filter desk lint        # 0 errors（warnings 均为既有）
pnpm exec prettier --check ... # 改动文件均符合格式
```

新增 E2E（均在**构建产物 `out/`** 上跑过）：

```
node apps/desk/scripts/e2e-image-caption.mjs    # 26/26（IME 一条为未执行，不计入）
node apps/desk/scripts/e2e-code-wrap.mjs        # 11/11
node apps/desk/scripts/e2e-sidebar-sticky.mjs   # 11/11
node apps/desk/scripts/e2e-tab-pin.mjs          # 16/16
node apps/desk/scripts/e2e-list-backspace.mjs   # 13/13
node apps/desk/scripts/e2e-paste-newlines.mjs   # 11/11
node apps/desk/scripts/e2e-web-select-all.mjs   # 14/14（本地 HTTP 页面）
node apps/desk/scripts/e2e-image-chrome.mjs     # 全绿（描述框与图片对齐/浮层定位）
node apps/desk/scripts/e2e-selection-toolbar.mjs    # 12/12
node apps/desk/scripts/e2e-bottom-panel-capacity.mjs # 28/28
node apps/desk/scripts/e2e-git-background-fetch.mjs  # 17/17
node apps/desk/scripts/diagnose-git-fetch.mjs        # 8/8（应用/终端 fetch 差异对照）
```

新增共用夹具 `scripts/e2e-lib.mjs`：隔离 workspace + profile + 测试知识库，
不启动用户已安装的应用、不接触用户数据
（用户工作区 `/Users/huyouda/tnotesjs/kbs` 未被读写）。

**本轮新增的单测**：`clipboardNewline.test.ts`（纯文本 → 段落/硬换行/缩进/CRLF/
HTML 转义，6 条）、`main/settings.test.ts` 的默认值与分组合并用例。

---

## 五、第 10 项 应用图标

四个文件在**本轮开始前**已是工作区里的未提交改动：

| 文件                           | 尺寸                  | 首次随本轮提交 |
| ------------------------------ | --------------------- | -------------- |
| `apps/desk/build/icon.png`     | 1024×1024             | `6dc6d04`      |
| `apps/desk/build/icon.icns`    | macOS 图标集          | `6dc6d04`      |
| `apps/desk/build/icon.ico`     | 含 7 档、最大 256×256 | `6dc6d04`      |
| `apps/desk/resources/icon.png` | 512×512               | `6dc6d04`      |

**确切提交记录**：这四个文件在**本轮第一次提交 `6dc6d04`**（第 3 项图片描述修复）
里被一起纳入；此前它们只存在于工作区（`git log --follow` 显示上一版来自更早的
`022f40a` / `793f0f1`），`bd9bfa8`、`df7f29d` 及其后提交**没有**再次改动它们。
源图 `/Users/huyouda/Downloads/logo-rect.png`（1124×1124）仍在。
本轮**未覆盖、未重新设计**，只是保留并纳入提交。

正式效果需重新打包安装后生效；本轮按要求**未打包、未发布**。

---

## 六、未验证范围（明确不当作已验）

1. **第 3 项的中文输入法（IME）**：脚本里保留 `NOTE ... 未执行`，**未实测**，需人工验证；
   这是**未执行**，不是失败。26/26 只代表「已执行的检查全过」。
2. **第 11 项的 ssh agent 差异**：无本地 sshd / ssh remote 夹具，**未验证**，只做了机制分析
   （`SSH_AUTH_SOCK` 在非交互式环境下是否可用）。
3. **第 11 项的已知缺口**：底部面板容量打满时，后台失败退化为「仅日志、无可见任务/通知」；
   后台 fetch 与手动 fetch 共用同一 `(库,kind)` 任务标签（后台重试会给手动那条 `run+1`）。
4. **第 11 项的 PATH 差异**：本机两种 PATH 都解析到同一个 `/usr/bin/git`，**未复现**；
   Homebrew git 的机器上是否不同**未验证**。
5. **第 11 项的现场根因**：可控环境里复现的是**机制差异**（后台 15s 超时、非交互式凭据），
   **不能**证明用户当时那批超时就是由它们引起；现场的远端类型、网络/代理状态与 stderr
   都没有拿到，**实际根因仍未确认**。
6. **并发 E2E**：新增套件都是单跑验证；批量并发运行的超时现象原因未确认
   （沿用上一轮口径：批量运行超时、单独重跑通过，原因尚未确认）。
7. **Windows / 非 macOS 平台**：未验证。
8. **真实的用户知识库**：本轮所有 E2E 与诊断都在临时工作区 / 临时仓库里跑，
   **没有**在用户真实知识库上做任何写操作。

---

---

## 七、本轮提交

| 提交      | 内容                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| `6dc6d04` | 图片描述框不再被正文编辑器当成内容（第 3 项）；**同时纳入四个应用图标文件**                      |
| `bd9bfa8` | 代码块统一不折行（第 2 项）；固定标签显示可点图钉（第 6 项）                                     |
| `906d2f0` | 第二列头部滚动时固定（第 1 项）                                                                  |
| `28b30da` | 网页标签 Cmd+A 按来源定位（第 8 项）                                                             |
| `5a54ebd` | 本轮交付报告（实现待验收）                                                                       |
| `df7f29d` | 空列表项 Backspace 不留空项（第 4 项）；网页全选界面验证（第 8 项）；描述浮层跟随滚动（第 3 项） |
| `2f10a8e` | 纯文本粘贴保留换行与缩进（第 9 项）；描述浮层的滚动/重开恢复 E2E                                 |
| `62a2f0b` | 选区浮动工具条加开关、默认关闭并持久化（第 5 项）                                                |
| `a9bd449` | 关闭选区工具条开关时立即收起已显示的浮条（第 5 项）                                              |
| `24fe883` | 图片描述浮层的宽度与归属定位（第 3 项收尾）                                                      |
| `e1ec179` | 底部面板标签上限可配置（第 7 项）                                                                |
| `c48a528` | Git 后台抓取差异定位、开关与通知治理（第 11 项）                                                 |
| `20cd408` | 补齐底部面板上限的收尾改动（第 7 项）                                                            |

> 第 7 项与第 11 项是**并行实施**的，改动落在同一批文件（`settings.ts`、`contracts.ts`、
> `SettingsPanel.vue` 等）。提交时按 hunk 拆分，保证每个提交只含自己那一项，
> 没有把未完成的半成品带进任何一个提交；`20cd408` 是第 7 项遗漏收尾文件的补充提交。

本轮**未推送、未打标签、未发布新版本**。

---

---

---

---

---

---

---

---

## 八、第二轮验收意见的处理（逐条证据）

### 1. 列表第四次 Backspace：**结构与光标**都要对

**用户反馈**：`liftListItem` 会把空列表项提升为**列表外的空段落**，光标仍停在空段落里、没有回到 `555` 末尾；旧 E2E 只查"没有空 li"，发现不了；层级断言也不能只看文本还在。

**复核结论**：反馈成立，而且比反馈更严重 —— 旧实现只对**顶层**空项成立。实测（直接调用命令并 dump 文档树）：`- 444` / `  - 555` 删空空 `555` 后，外层列表多出一个空 `list_item`（还挂着自己的空子列表），列表外再多一个空段落；嵌套有序列表同样。主场景的 `666` 恰好是顶层项，所以旧实现与旧断言都侥幸通过。

**修法**：不再 lift/join，只做一件事 —— **把整个空 `list_item` 从父列表里删掉**。守卫：空选区 + 段落为空 + `parentOffset === 0` + 空段落是本项第一块 + 整项 `textContent === ''` + 父级是 `bullet_list|ordered_list`；父列表 `childCount > 1` 删这一项，唯一子项则连父列表一起删。光标取"文档顺序上最近一个**有内容的文本块**末尾"（`pos + nodeSize - 1`；`Selection.findFrom(-1)` 会落在末尾前一位，实测 offset 2 而非 3）。

**证据**：`e2e-list-backspace.mjs` **23/23**，断言强度只增不减：(a) 无空列表项、(b) 完整层级逐项一致、(c) **光标在 `555` 末尾且在 `list_item` 内**、(d) 无列表外空段落、(e) 保存后无 `- <br />` 且逐行结构正确、(f) 保存重开一致；另有有序、任务（勾选态 `[false,true,false] → [false,true]`）、松散列表、**嵌套列表**、撤销/重做、无页面异常。单测 `listBackspaceKeymap.test.ts` **12/12**。

### 2. 粘贴不再丢连续空行

**用户反馈**：`split(/\n{2,}/)` 把 2 个、3 个乃至更多换行压成同一种结果，单测甚至把这种合并写成预期。

**修法**：逐行处理，**空行各自产出一个空段落**，不合并；单测改成要求真实个数（2 个空行 → `<p>a</p><p></p><p>b</p>`，3 个 → 3 个空段落，尾部空行同样保留）。

**证据**：`e2e-paste-newlines.mjs` **19/19**，其中新增：粘贴 `ALPHA` + 2 个空行 + `BRAVO` → 编辑器里 ALPHA 与 BRAVO 之间 ≥4 个换行（旧的"压成 1 个"实现是 2 个）；**保存后磁盘上 ALPHA 与 BRAVO 之间确有 2 行空行**；**重开后空行个数不变**。单测 11 条覆盖 1/2/3/4 个空行、尾部空行、CRLF、缩进、HTML 转义。

### 3. 保留既有 Markdown 粘贴能力

**用户反馈**：新插件拦截所有 `text/plain` 粘贴、跳过原有 Markdown 解析，标题/列表/围栏代码都会被当成普通正文。

**修法**：只有**看起来不像 Markdown** 的纯文本才走保留行边界的路径；命中"行首 Markdown 标记"（ATX 标题 / 列表 / 引用 / 围栏 / 分隔线 / 表格行 / `:::` 容器）时**放行给原有解析**。判定是纯函数 `looksLikeMarkdown()`，单测覆盖 12 个正例与 4 个反例（代码、普通多行文本，以及 `#`/`-`/`|` 出现在行中间时不算标记）。

**证据**：`e2e-paste-newlines.mjs` 里"Markdown 文本仍走原有解析"覆盖 `## 标题` + 列表 + 围栏代码块 → 标题仍是 `h2`、列表项仍是 `li`、代码块仍是代码块，且**落盘仍是 Markdown**（`## ` / `- ` / 围栏）；纯文本样例（代码）仍保留行边界。两类行为在同一脚本里各有断言，避免只验证代码样例。

### 4. 容量满额时后台失败必须可见（不再算"未验证"）

**用户反馈**：`backgroundGitFailure.ts` 创建任务失败后只记日志、返回 null；报告把它列成"已知缺口/未验证"后通过，属未完成需求。

**修法**：新增 `main/backgroundFailureLog.ts` —— 一条**不占用面板标签**的失败记录，保留主进程给出的**错误原文**、原因、知识库名与发生时间；同一 `(库, 操作, 原因, 消息)` 只累加 `count`。通过新 IPC 通道（`background-failure:list|changed|clear`）暴露给渲染端，在**设置 →「Git 与远端」**里给出汇总 + 「查看错误详情」展开原文；新出现一条时弹一次 toast 指向设置。

**证据**：

- 单测 `backgroundFailureLog.test.ts` **7/7**：原文/原因保留、同因累加、原因或消息变了算新条目、知识库查不到时的退化、订阅/取消订阅、清空、条数上限。
- `backgroundGitFailure.test.ts` 新增用例：用**真实容量门禁**（上限设 1 并先占一个运行中的任务）触发 `createBackgroundGitTask → null`，断言记录里保留了门禁的中文原文，且**没有多占任务标签**。
- 界面验证 `e2e-background-failure-visibility.mjs` **8/8**：注入一条"没有可见任务"的后台失败后，设置里出现汇总（含知识库、操作、原因）、「查看错误详情」展开的是**真实错误原文**、**命令任务列表仍为空**（不占标签）、同原因重复 3 次只有 1 条且显示 `×3`、可以清空。注入接口受 `DESK_E2E_EXPOSE_INTERNALS=1` 门禁保护，生产构建直接拒绝。

### 5. 后台与手动的运行归属隔离（并修掉一个真缺陷）

**用户反馈**：`claimHandle` 只按 `(知识库, kind)` 复用、运行中的记录也直接复用，后台工厂随后会修改阶段并结算同一个 `id/run`；要求用确定性测试覆盖两个方向，证明不串输出、不提前结算、不改变取消归属；不能证明就修正归属模型。

**复核结论**：**不能证明 —— 存在真缺陷**。`ensureBottomPanelCapacity` 与 `GitManager.scheduleBackgroundFetches` 会跳过手动在跑的这一轮（`state.busy`），所以"运行中直接重叠"这条路径本身被挡住了；但只要手动那一轮**刚结束**，后台定时那一轮就会按 `(库, kind)` 复用**手动那条标签**并给它 `run+1`、清掉它的输出与结果 —— 手动操作的历史被后台改写。

**修法（归属模型）**：`claimHandle` 的复用条件加上**来源必须一致**（`Boolean(existing.dto.background) === Boolean(input.background)`）。同一来源仍复用同一条（渲染端与主进程各 claim 一次的场景不变、运行中不得自增 `run` 的既有约束保留），来源不同则各自独立成一条，于是两条运行不再共用 `id/run`。

**证据**：`gitManager.backgroundFetch.test.ts` 新增 4 条确定性用例（**12/12**，含原有用例）：

1. 同一 `(库, kind)` 但来源不同 → 不复用，两条各自 `run = 1`；
2. 同一来源 → 仍复用同一条且 `run` 不变；
3. 手动已结束后后台同类开始 → **手动历史完全没被动过**（`status/error/run/background` 逐项），输出按 `id + run` 归属、两边**不串**，后台收尾**不会结算**手动那一轮；
4. 后台轮次运行中时手动开始 → 后台轮次**未被提前结算**、`cancelQueued` 手动那轮**不动**后台，后台那轮的 `reportStageChecked` 仍为真。

另外 `e2e-bottom-panel-capacity.mjs`（28/28）与 `e2e-git-background-fetch.mjs`（17/17）在本次改动后重跑仍全绿，确认没有破坏容量门禁与后台治理。

### 6. 第 11 项结论订正

**原结论**写的是"复现出两处确定差异 …… **不是网络问题**"。这个推论过头了：

- 可控环境里复现出的是**机制层面的差异** —— 后台 15s 超时（终端无超时）与非交互式凭据（`GIT_TERMINAL_PROMPT=0`、`stdio` 不给 stdin）。这两条能解释"为什么应用会失败而终端能成功"**这一类**现象，但**不能**证明用户当时遇到的那批超时就是由它们引起。
- 现场那次超时的**实际原因仍未确认**：没有用户侧的远端地址类型（https/ssh）、网络与代理状态、失败时刻的 stderr，以及那批任务各自的耗时。对照实验也**未覆盖** ssh agent（无本地 sshd / ssh 夹具）。

**订正后的表述**：本项交付的是"**在可控环境里定位到的两条机制差异 + 面向它们的治理**"（默认关闭的开关、全局并发上限、去重、退避、真实时长与分类、通知聚合、容量满额时的可见失败）。**"不是网络问题"证据不足，现场根因仍未确认**；第六节已按此措辞改写。

## 九、第三轮验收意见的处理（P1 ×3 + P2 ×1）

### 1. [P1] 空列表判定误删非文本内容

**用户反馈**：`item.textContent === ''` 不代表列表项为空；「空段落 + 图片」的项会被整项删掉（最小 schema 复现：图片数量 1 → 0）。

**复核**：成立。图片、分隔线、画布等**非文本节点**的 `textContent` 也是空串（行内图片只剩一个硬换行），按文本判空必然误判。

**修法**：改成**按节点结构**判空 —— `isStructurallyEmptyItem()` 遍历本项后代，只允许出现「空段落 / 空列表容器」；一旦遇到任何叶子节点（文本 / image / horizontal_rule / 代码块 …）就不算空。

**证据**（`listBackspaceKeymap.test.ts` 14/14）：

- 最小 schema 用例：项 = 空段落 + 行内 image，命令**拒绝接管**；
- **真实 Desk schema** 用例：`- 图文` + 行内图片，删掉文字后断言 `item.textContent.trim() === ''`（证明旧实现在这里必然误判）**且**命令返回 false、图片数仍为 1、项数仍为 1。

### 2. [P1] 来源隔离的索引不完整

**用户反馈**：`byKey` 仍只用 `(知识库, kind)`，新增来源不同的任务会覆盖索引；手动 A → 后台 B → 再次手动认领会建出 C，而仍活跃的 A 找不到。

**修法**：索引键改为 `(知识库, kind, 来源)`（`keyOf()`），`claimHandle` / `find` / 删除 / `dispose` 全部走同一个键；`find()` 支持按来源精确查，不传来源时优先返回活跃的手动任务。

**证据**（`gitManager.backgroundFetch.test.ts` 18/18）：新增**两个方向的三步交错**用例（手动 A → 后台 B → 再次手动认领；后台 A → 手动 B → 再次后台认领），都断言第三次**复用仍活跃的 A**、`run` 不变、总量仍是 2；另加"关闭其中一条只影响自己那条索引"。

### 3. [P1] 满额兜底记录的是容量错误，不是真实 Git 失败

**用户反馈**：记录里保存的是 `claimHandle` 抛的"标签已满"；返回 `null` 后 Git 仍继续执行，最终 `outcome.message` 因 `holder.task?.finish(...)` 被跳过而没进可见记录。

**修法**：记录责任从 factory 移到 **GitManager**（`onBackgroundFailureRecorder` 注入）：

- 认领失败时先记一条"为什么没有标签"；
- 执行结束后用**同一个 id** 覆盖成真实结果（`outcome.message` / 超时前缀）——
  同时发现并修掉一个真 bug：记录更新分支原本只改 `count/at`，**没有覆盖 `reason/message`**；
- **成功不记**（不会把成功的 fetch 展示成 Git 执行失败）。

**证据**（`gitManager.backgroundFetch.test.ts`）：三条确定性用例走**真实 capacity 门禁 + 真实 factory**：

- 满额 + fetch 实际失败 → 记录 message 含 `Could not resolve host`，reason 仍是"标签已满"，且**没有多占标签**；
- 满额 + 超时（code 124）→ 记录 message 含"超时"；
- 满额 + fetch **成功** → 记录里只允许"未执行"类原因（`message === reason`），不含任何 Git 失败/超时措辞。
  `e2e-background-failure-visibility.mjs` 8/8 重跑仍绿（界面侧真实错误原文可展开）。

### 4. [P2] Markdown 启发式会重新破坏代码粘贴

**用户反馈**：`looksLikeMarkdown()` 会把 Python/Shell 的 `# 注释`、C 风格注释里的 `* 内容` 当成 Markdown；反过来只有 `**粗体**`、链接等行内语法的 Markdown 又识别不出来。

**修法**（两步，不再仅靠行首正则）：

1. **应用内代码复制携带明确来源**：代码块的复制按钮与代码分组的复制改走 `ClipboardItem`，
   同时写 `text/plain` 与自定义类型 `application/x-desk-code`；粘贴端看到这个类型就**跳过 Markdown 解析**（纯文本仍可用，粘到外部应用不受影响）。
2. **收紧外部纯文本的启发式**：
   - 行内语法（`**粗体**` / `[链接](url)` / `*斜体*`）→ 认（旧实现只查行首，会漏）；
   - 列表要求**至少两行**；`*` / `+` 还要求**顶格**（C 风格注释块的 ` * 内容` 实测会被误判）；
   - 围栏要求**成对**；单个 `# 注释` 不再算（与标题字符层面无法区分，宁可不解析），
     `##` 及以上多级标题才直接认；其余块级标记（引用/表格/分隔线/容器）形态明确，照认。

**证据**：

- 单测 18 条（原 11 条扩到 18）：新增 Python 注释、Shell 注释、C 风格注释块、
  `**粗体**` / 链接 / 斜体、单个 `# 注释`、单个 `- item` 等冲突样例；
- E2E `e2e-paste-newlines.mjs` **25/25**（+6 条）：Python 注释代码粘贴后不产生标题、
  行边界保留、**落盘仍是多行**；行内 Markdown 仍解析出 `<strong>` 与链接；
  再补**保存 + 重开**核对（代码仍是多行文本、行内结构仍在）。

> 现场 fetch 根因的表述订正（第八节第 6 条）按验收意见保留。

## 十、第四轮验收意见的处理（P1 ×1 + P2 ×1）

### 1. [P1] 代码来源标记原先写不进去

**用户反馈**：实测 `ClipboardItem.supports('application/x-desk-code') === false`、`supports('web application/x-desk-code') === true`；当前写入落入异常回退变成无标记纯文本，又回到 Markdown 猜测；新增 E2E 直接设置 Python 文本，证明不了"复制 → 标记 → 粘贴"，Cmd+C 也没覆盖。

**复核（本机实测）**：确认成立。`application/x-desk-code` 不被支持；而且**即使**换成 `web application/...`，`navigator.clipboard.write` 在无剪贴板权限的环境里直接抛 `NotAllowedError` —— 自定义 MIME 这条载体本身就不可靠。

**修法**：改用**不依赖任何权限的文本哨兵**。

- 哨兵是 Unicode Tag 区字符（`U+E0000 U+E0001desk-codeU+E0001`，不可见、不参与排版），
  直接放进**纯文本本身**：`writeText` 与 `execCommand('copy')` 两条路都能带上，
  粘到外部应用也不可见；自定义 MIME 常量同时改成 Electron 实际认可的形式作为附带标记。
- **Cmd+C**：实测捕获阶段 `clipboardData` 是**空的**（Chromium 只在 copy 事件里填充），
  所以不能"读出来再改写"；改为自己从 CodeMirror 状态（`.cm-content` 上的 `cmView`）取
  选中文本，再 `preventDefault()` + `setData()`。代码块与代码组都覆盖。
- 复制路径统一**去掉尾部换行**再打哨兵（Electron 会把行尾统一成 CRLF，留着尾部换行会让
  "复制 → 粘贴"多一个空行，逐字比对就不相等）。

**证据**：`e2e-paste-newlines.mjs` **34/34**，夹具换成**冲突内容**
（`## 这不是标题` / `**这不是粗体**` / `# 也不是注释` / `- 也不是列表`）：

- 普通代码块**复制按钮** → 读回的纯文本以哨兵开头，哨兵之外的正文**逐字等于**代码块内容；
- 代码块内 **Cmd+A / Cmd+C** → 同上；
- **代码组**内 Cmd+A / Cmd+C → 同上（并且代码组粘贴改用**真实复制**而非直接写剪贴板，
  否则绕开了来源标记）；
- **端到端**：把带哨兵的剪贴板原样粘回正文 → `##` 行**没有**变成标题、`**` 行**没有**
  变成粗体、多行全在；再补**保存 + 重开**逐字核对（Python 注释代码仍多行、行内 Markdown 仍解析）。
  单测 22 条新增哨兵用例（加/剥/不可见性/冲突内容必走保留行边界）。

### 2. [P2] 无标签后台记录的生命周期与聚合

**用户反馈**：先建容量记录再按 id 更新成 Git 错误会再次 `count += 1`（一次失败可能显示 ×2）；
下次占位记录无法按原消息命中，重复失败不断新增；成功后最初的容量记录仍在失败列表；
自动推送仍只有 `task?.finish(...)`，满额时真实失败仍可能不可见。

**修法**：取消"运行中占位记录"，改成**只在最终失败时记一条**：

- `recordBackgroundFailureWithoutTask()` 变成**纯聚合器**（去掉 `id` 参数与更新分支）：
  聚合键 = `(知识库, 操作, 原因, 最终错误)`，命中只 `count += 1`；
- `reason` 说明"为什么没有可见任务"，`message` 是**真实执行结果**，两者分开 ——
  聚合按最终错误走，不按容量提示走；
- **成功不记录**：不再留下只写着"标签已满"的失败条目；
- **自动推送**接上同一条路径：满额时 `!task` 且最终失败/超时都会记录真实结果
  （`publish` 的 observer 分支不参与，所以直接走无标签记录入口）。

**证据**（`backgroundFailureLog.test.ts` 10 条 + `gitManager.backgroundFetch.test.ts` 20 条）：

- 一次失败 `count === 1`（不存在"先建占位再更新"的 ×2）；
- 同因连续失败三次 → **一条记录 ×3**，不新增条目；
- 满额 + fetch **成功** → 记录里只允许"未执行"类原因（`message === reason`），
  不含任何 Git 失败/超时措辞；
- 满额 + 自动推送失败 → 留下一条 `kind === 'git-push'` 的记录，`reason` 含"底部面板"、
  `message` 为真实 Git 错误，且**没有**占用任务标签。
  `e2e-background-failure-visibility.mjs`（8/8）与 `e2e-git-background-fetch.mjs`（17/17）重跑全绿。

> 列表结构判空与来源索引两处本轮源码复核未发现上一轮问题（用户已确认）；现场 fetch 根因未确认的边界表述继续保留。

## 十一、第五轮验收意见的处理（复制数据完整性）

### 1. [P1] 不再向 `text/plain` 注入哨兵

**用户反馈**：`desk-code` 是普通可见字符、并非 Tag 字符；即使全不可见也改变了复制内容（拼到合法 JavaScript 前解析直接 `SyntaxError`）；外部 IDE/终端不会剥标记，Desk 向代码块粘贴又会提前放行，不能以"粘回正文能去掉"作为复制正确的标准。

**复核**：成立，这是把测试便利放在了数据完整性之上。

**修法**：**移除纯文本哨兵**，来源信息只走**独立剪贴板格式** `application/x-desk-code`。
这里做了三组实测才定下载体：

| 载体                                                                        | 实测结果                                                                                  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `navigator.clipboard.write([ClipboardItem])`                                | `supports('application/x-desk-code') === false`；且无剪贴板权限时直接抛 `NotAllowedError` |
| Electron 主进程 `clipboard.write({ text, 'application/x-desk-code': ... })` | 调用成功，但 `availableFormats()` 里**只剩 `text/plain`** —— 自定义键被忽略               |
| **copy 事件里 `clipboardData.setData(自定义类型, …)`**                      | ✅ 主进程 `availableFormats()` 里能看到该格式，且 `text/plain` **逐字保留**（含末尾换行） |

所以复制统一走「一次性捕获监听 + `execCommand('copy')`」：在捕获阶段 `preventDefault()` +
`setData('text/plain', 原样文本)` + `setData('application/x-desk-code', '1')`，写完立刻摘掉监听。
`Cmd+C`（CodeMirror 选区）沿用同一手法（捕获阶段 `clipboardData` 为空，必须自己取文本）。
主进程那条无用的写剪贴板 IPC 已删除（它做不到这件事，留着是死代码）。

### 2. [P1] 不再裁剪末尾换行

**用户反馈**：三条复制路径都用 `.replace(/\n+$/, '')`，会删掉用户实际选中的换行与末尾空行；CRLF 归一化与删除末尾换行是两件事，不能为了让测试通过而删内容。

**修法**：**去掉全部裁剪**。复制写入的就是选区原文；粘贴端也只读 `text/plain` 原文
（不再需要剥离任何东西）。原先"多一个空行"的真正原因就是哨兵被追加在末尾换行之后
（Electron 把行尾统一成 CRLF 后，哨兵落到下一行）—— 移除哨兵后该现象自然消失。

### 3. 验收覆盖（`e2e-paste-newlines.mjs` 39/39）

按验收要求逐条覆盖，**比较前不做任何剥离/trim/裁剪**：

- **复制后的纯文本直接与原始选区比较**：普通代码块「复制按钮」、代码块 `Cmd+A/Cmd+C`、
  代码组 `Cmd+A/Cmd+C` 三条路都断言 `readText() === 选区原文`（只做 CRLF→LF 归一化）；
- **独立格式确实写入**：断言 `availableFormats()` 含 `application/x-desk-code`，
  且纯文本里**不含** `desk-code` 字样；
- **末尾换行 / 多个空行**：用 `## 冲突标题样式\n**不是粗体**\n\n\nconst tail = 1\n\n` 这种
  形状（末尾两个空行 + 中间两个空行）验证逐字一致；
- **部分选区**：双击选中一个词后复制，断言复制内容 === 当时的选区内容，且**不含**未选中行；
- **粘到正文**：`##` 行没变标题、`**` 行没变粗体，且每一行都与选区一致；
- **粘到另一个代码块**：内容与选区逐字一致；
- **粘到普通外部文本框**：内容逐字一致且不含任何标记；
- **合法代码仍可被对应解析器接受**：JS 用 `new Function`、JSON 用 `JSON.parse`；
  Python 无法在渲染端求值，改为逐字比对源码（含 `#` 注释与 `**`）。

### 4. 后台记录未重复返工

第五轮只动复制链路；`backgroundFailureLog` / `gitManager` 的无标签记录实现未改，
相关套件重跑仍绿（`e2e-background-failure-visibility` 8/8、`e2e-git-background-fetch` 17/17）。

## 十二、0.10.1 回归修复：复制图片丢 `text/plain`

### 1. 回归与影响

**现象**：在 Desk 里复制图片（Cmd+A / Cmd+C）后，系统剪贴板的 `text/plain` 分量丢了 —— `availableFormats()` 只有 `text/html`。

**用户可见影响**（中性探针，不是只看断言）：把复制到的图粘到**只认 `text/plain` 的地方**（外部 IDE、聊天框、页面内普通文本框）得到**空**（实测 `PLAIN_PASTE=""`）。Desk 内部粘贴不受影响（走 `text/html` 里的引用）。

**定位**：worktree 二分，**第一个坏提交是 `6dc6d04`**（图片描述框移出 contenteditable）。机制：在那之前，选区里的描述 `<input>` 会被 Chromium 当作纯文本来源（它的 value 就是 alt）；移出之后选区里只剩 `<img>`，而**图片节点不贡献纯文本** → Chromium 只写 `text/html`。与 `clipboardNewline` / `markCodeCopy` 无关（已用 copy 事件探针证伪：目标不在代码块内、监听器提前 return、三个阶段 `defaultPrevented` 均为 false）。

### 2. 修法

不动原生复制的 `text/html`，**复制完成后只补 `text/plain`**：

- `renderer/markdown/imageCopyText.ts`：算当前选区的纯文本形态（文字原样、图片取 alt、硬换行与块之间转成换行；**与选区里有没有图片无关**，避免同一种内容因有无图片而形态不一致）与 html 载荷（图片带 `src` + `alt`，保留 `.svg` 引用供画布插件识别）；
- 选区含图片时，`copy` 事件之后调用新通道 `clipboard:set-plain-text`（`main/ipc/clipboard.ts`），由主进程读剪贴板现状并**同时**写 `text/html` + `text/plain`。为什么必须在主进程：实测 `clipboard.write({ text })` 会把 `text/html` 一起清掉，只有两种 flavor 同时写才能保住 html；
- 代码块内复制不接管（那条有自己的 `application/x-desk-code` 独立格式标记，纯文本里也没有任何注入）。

**试过并放弃的三条路**（记录以免回退）：

1. 只在 `copy` 事件里 `clipboardData.setData('text/plain', alt)` —— 事件对象上读得到，**系统剪贴板拿不到**；
2. `execCommand('copy')` + 离屏元素重发 —— 在"纯 DOM 选区"下不产生任何 flavor，还会把原生 `text/html` 一起弄丢；
3. `EditorProps.clipboardTextSerializer` —— 实测这条复制**不经过 ProseMirror 的复制流程**（序列化器从未被调用）。

### 3. 验证（覆盖验收清单）

新增 `e2e-image-copy-plain-text.mjs`，**17/17 通过**，逐条对应：

| 验收项                                              | 结果                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 单张图片有 alt：系统剪贴板 `text/plain` 与 alt 一致 | ✅ `text="画布甲"`，`formats=["text/plain","text/html"]`                                             |
| 单张图片有 alt：粘到普通文本框有内容                | ✅ 粘回值 `"画布甲"`                                                                                 |
| 图片无 alt：明确预期                                | ✅ `alt=""` → `text/plain` 为空；**同时断言 `text/html` 仍带引用**，证明复制本身成功、不是失败       |
| 图片与正文混选                                      | ✅ `["图片复制","前段文字","画布甲","画布乙","尾段文字","const keep = 1"]`，正文不丢、描述各出现一次 |
| 多张图片                                            | ✅ alt 出现顺序与文档顺序一致                                                                        |
| 粘回 Desk（另一篇笔记）                             | ✅ 三张图都粘进来、描述正确、落盘是相对路径引用、**源笔记字节未变**                                  |
| 不回归：代码复制                                    | ✅ 纯文本仍是代码原文，`application/x-desk-code` 标记仍在                                            |
| 不回归：图片描述编辑                                | ✅ 逐字输入后 alt 正确（`"新描述"`）                                                                 |

**回归证明**：同一套件在 **0.10.0（未修复）上 7 条失败** —— 那时 `text/plain` 是 `![画布甲](../assets/0001-甲.svg)` 这类内容（粘到普通文本框得到的是这种带标记的行内形式，而不是干净的 alt），修复后 **17/17**。

其他回归：`e2e-excalidraw-copy` **9/9**、`e2e-image-caption` **26/26**、`e2e-paste-newlines` **44/44**；单测 **180 files / 1614 passed**；lint / typecheck / format:check / build 全绿。

### 4. CI 失败排查结论（2026-09-20 已定位并处理）

#### (a) 两条 E2E 失败：**陈旧脚本**（已修）

`e2e-block-menus.mjs` 与 `e2e-excalidraw-inline.mjs` 连挂两次且失败项完全一致、本地可稳定复现。根因同源：`6dc6d04` 把图片描述 `<input>` 移出 contenteditable 后，它变成**绝对定位浮层**（挂在编辑器 canvas 上，见 `deskImageView.ts` 的 `resolveCaptionHost`），两个脚本仍按旧结构写：

| 脚本                        | 旧写法                                                          | 失败表现                                                                  |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `e2e-excalidraw-inline.mjs` | `canvasFigure().locator('.desk-image__caption')`（figure 后代） | `locator.fill: Timeout 30000ms`                                           |
| `e2e-block-menus.mjs`       | `openMenu()` 只把格式工具条当拦截浮层，候选 hover 点取块下沿    | `hover ... <input class="desk-image__caption"> intercepts pointer events` |

修法（只改测试）：前者改用页面级 `input.desk-image__caption` 并先 click；后者把格式工具条与描述浮层**都**收进 overlay 列表判断覆盖，并补一个靠近块上沿的候选点。修复后本地两套件全过，**推送后 E2E (desk) 连续多次通过**。

#### (b) `disposeSpawn` 超时：**根因定位 + 已消除危害**（残留问题已记录）

`apps/desk/src/main/disposeSpawn.test.ts > dispose() 收掉仍在挂着的 git fetch` 在 CI 上偶发 `Test timed out`（此前 7 次挂 6 次，本地从未复现）。

排查链条（**每一步都是 CI 实测数据**，不是猜测）：

1. 加阶段计时后，CI 报 `卡在 manager.dispose()（>20000ms）；阶段=repoReady=47ms, queueIdle=53ms, gitProcessUp=195ms`，同一时刻 `ps` 里**已无任何 git 进程**；
2. 给 `runGit` 加"硬上界到点上报内部清理状态"后发现 `onCleanupState` **一次都没触发** → 根本没走到 `runGit` 的终止路径，排除"清理确认被 EPERM 卡住"（我先前的假设被证伪）；
3. 给 `dispose()` 每轮打印队列状态（`tails` / `kills` / 各队列项 `running|canceled`）后得以确认：它卡在 `Promise.allSettled(operationTails)`——**单个操作在 CI 上偶发不结算**。

**修法（产品侧）**：`dispose()` 每轮等待队列结算加上界 `DISPOSE_TAIL_TIMEOUT_MS = 5000`；到点不再干等，改为 `deskLog('git:dispose','tail timeout', { tails, nodes })` 如实记录"谁还没结算"后继续退出。**退出流程不允许被单个操作拖死**——宁可晚 5s 退出并留下可诊断日志，也不能退不掉。

**验证**：

- 新增确定性单测（塞一个永不结算的操作）：修复前 `dispose()` 无限等待，修复后 `5004ms` 返回；
- 保留前两轮加的失败自证（阶段计时、进程/环境快照、`runGit` 清理状态上报），下次 CI 复现可直接看出是哪个操作没结算；
- 推送后 `CI` 与 `E2E (desk)` 均通过。

**仍未确认**：那个操作在 CI 上为何偶发不结算（本地含 8 路 CPU 满载、把 `http_proxy` 指向"接受连接但不响应"的本地代理，均不复现）。它现在最多让退出晚 5s 并留下诊断日志，不再让应用退不掉；已排除的假设与对照实验记录在提交信息里。

## 十三、第二列吸顶头部：背景透明 + 上方透出带

验收里报的两个现象，实际是**两个独立缺陷**，各自都有确定性回归断言。

### 13.1 吸顶行背景是透明的

现象：滚动第二列时，「变更 / 目录」栏下方的目录项从栏里透出来。

原因不是"忘了写背景"，而是**写了但被覆盖**：吸顶规则与共享基类 `.section-heading`（为详情栏那种静态标题设了 `background: transparent`）**同优先级**，而后者在 SFC 里更靠后 → 计算值 `rgba(0, 0, 0, 0)`。

修法：把吸顶选择器限定成 `.navigator-body .git-heading, .navigator-body .toc-heading`，多一层限定抬高优先级；**不动基类的 `transparent`**（非吸顶标题确实需要它）。

### 13.2 吸顶行上方还有一条透出带

现象：搜索栏下方仍有内容从吸顶行上方透上来。

原因：sticky 只能吸到**滚动容器的内容盒**上沿，容器的 `padding-top` 会在容器顶边与吸顶行之间留出一条带子，而 `overflow: auto` 的裁剪边界是 padding box —— 滚动的目录项正好画进这条 padding 带里。实测 `padding-top: 7px` 时该带高 7px，打点命中 `node-label` / `note-index`。

修法：滚动容器顶部不留 padding（`padding: 0 7px 7px`）；**留白挪到滚动容器之外**——给搜索栏 `.navigator-top` 加 `margin-bottom: 7px`，它在滚动容器之外，怎么留都不会被透视。视觉上未滚动时的间距与修复前完全一致。

### 13.3 回归断言（`scripts/e2e-sidebar-sticky.mjs`，13/13）

- **吸顶行背景不透明**：读 `getComputedStyle(el).backgroundColor`，拒绝 `rgba(0, 0, 0, 0)` / `transparent`；
- **吸顶行上方没有内容透出**：从容器顶边到吸顶行顶边逐点 `elementFromPoint`，只有命中滚动内容（目录项等）才算失败，命中任一吸顶行算正常（「目录」栏上方本就是叠着的「变更」栏）。

两条都做过**反向验证**（把修复临时改回去，只有对应那条断言变红），确认不是恒真断言。

## 十四、图片描述浮层压住下方内容

验收现象：图片带描述时，描述行压在下方的块上（截图里是代码分组的表头被描述盖住）。

**根因**：描述浮层是**绝对定位**（结构上必须如此 —— 它要在 contenteditable 子树之外，
否则输入的字会被 ProseMirror 当成正文写进图片 `alt`，见 `deskImageView.ts` 里 `caption`
的说明），于是它**完全不占正文流**：`figure` 的高度只算图片，下一个块紧贴图片下沿开始。

**修法**（比"给图片写死条件下边距"更稳）：在定位浮层的同一个函数里，按浮层**实测高度**
把间距写回 `figure` 的下外边距：

```
figure.style.marginBottom = 4（浮层起点）+ captionRow.offsetHeight + 8（余量）
```

- 不写死常量：字号 / 行高 / 缩放变化时同样成立；
- 浮层隐藏（没有描述）时清成空串，不留多余间距；
- 用 `margin` 而不是 `padding`：`padding` 会算进 `figure` 自身盒高，而浮层正是按
  `figureRect.bottom` 定位的 —— 会自己把自己往下推（正反馈）。`margin` 在 border box
  之外，`figureRect.bottom` 不受影响，一轮收敛。

**验证**（`scripts/e2e-image-caption.mjs`，28/28）：

- `图片带描述时下方内容被挤开（描述不压住下一个块）`：量"描述下沿 → 下一个有内容的块上沿"
  的余量，要求 ≥ 0。实测 `captionHeight=20, figureBottom=277, figureMarginBottom=32px,
nextTop=317, clearance=16`；
- `清空描述后补出的间距一起消失`：要求浮层不可见且 `marginBottom` 回到 `0px`（防"永久白留一段"）。

## 十五、笔记标题行加「完成」开关（与目录里的圆点同源）

验收要求：在笔记头部标题行（`0003. 222` 那一行）的**编号左侧**放一个完成状态开关，
样式与目录树里的一致。

**做法**：把目录树里的圆点抽成共享组件 `components/NoteDoneToggle.vue`
（`done-toggle` + `done-dot` 两个 class 保持不变），目录树与笔记头部**用同一个组件** ——
样式只有一份，两处不会各自漂移；形状仍是主信号（空心环 = 待完成，实心 = 已完成），
颜色只是强化，`aria-label` 也在组件里统一给。

**位置**：`.document-toolbar > .document-path` 里、`.note-index` 之前
（单测直接断言 `note-index.element.previousElementSibling` 就是这个开关，
避免"放错行"这类回归 —— 第一版曾放到上面那行面包屑里，被验收打回）。

**接线**：

- 状态直接读会话里的 `document.config.done`：主进程就是从 TOC 取的这一位，
  切换完成后 `toggleDone` 把新的 `mutation.note` 同时写回**会话**与**整棵树**，两边天然同步，
  不必再遍历 TOC 找节点；
- `toggleDone` 的参数收窄成 `{ uuid, completed }`（它本来只读这两个字段）：
  目录树直接传节点，笔记头部传 `{ uuid: tab.noteUuid, completed }`；
- 沿用目录树同一个「显示完成状态」设置（`settings.toc.showNoteStatus`），两处一起出现/隐藏；
- 只读、或标签处于只读视图时置灰（与同排的标题/格式化按钮同一套判据）。

**验证**（单测 4 个文件 71/71）：

- 位置与接线：开关是 `.note-index` 的前一个兄弟节点；点击调用
  `toggleDone({ uuid: 'note-a', completed: false })`；
- 已完成呈现实心；只读文档下按钮带 `disabled`；
- `TocNodeList` 既有断言（`.done-toggle` 数量 / class / `aria-label` / 无 emoji）不变，抽取后仍绿。
