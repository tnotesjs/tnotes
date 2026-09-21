# 本机 MCP 选区上下文服务 · 验收报告

**日期**：2026-09-21
**状态**：**实现待验收**（阶段 A / B 自测通过；阶段 C「真实客户端联调」未做，原因见第六节）
**范围**：只读工具 `get_current_selection`（不做内置对话面板、不做模型配置、不做文件 / Git / 终端工具）
**本轮**：未推送、未打标签、未发版

---

## 一、交付内容

| 层             | 文件                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| 编辑器选区采集 | `src/renderer/src/selection/{visualSelection,sourceBlocks,selectionReporter,codeEditorSelectionBridge}.ts` |
| 上下文服务     | `src/main/selection/selectionService.ts`（与协议无关，协议中立）                                           |
| MCP 接口       | `src/main/mcp/{server,manager,token}.ts`（官方 SDK，Streamable HTTP）                                      |
| 设置界面       | `src/renderer/src/components/settings/McpSettings.vue` + 设置面板新分组                                    |
| 契约 / 接入    | `docs/mcp-selection.md`                                                                                    |

## 二、复现命令（本机全绿）

```bash
cd /Users/huyouda/tnotesjs/tnotes

# 门禁
pnpm --filter desk lint          # 0 error / 41 warning（与改动前同量级）
pnpm --filter desk test          # 188 files / 1720 tests passed
pnpm --filter desk typecheck     # 0 error
pnpm --filter desk build
pnpm format:check                # All matched files use Prettier code style

# 真实 MCP 协议链路（先构建：E2E 验的是 out/）
pnpm --filter desk exec electron-vite build
node apps/desk/scripts/e2e-mcp-selection.mjs          # 24/24
node apps/desk/scripts/e2e-mcp-visual-selection.mjs   # 33/33
node apps/desk/scripts/run-e2e.mjs --only mcp         # 2/2 套件（走 runner）
```

两个 E2E 都用**官方 SDK 客户端**（`@modelcontextprotocol/sdk` 1.30.0）走
`initialize → tools/list → tools/call`，连的是主进程真实起的本机服务；
不是直接调内部函数。夹具与 profile 全在 `mkdtemp` 的临时目录里，不碰真实知识库。

## 三、验证分层

### 1. 源码核对（读代码确认，不靠测试结论）

| 要求                                         | 实现位置                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| 选区不外泄到 MCP 之外的耦合                  | `selectionService` 不 import 任何 MCP；工具回调只调 `read()`                    |
| 不读 DOM 文本 / 不截图                       | 源码视图用 Monaco `state`；可视化用 PM `state.selection` / CM `state.selection` |
| 原子替换（不出现「路径来自 A、文本来自 B」） | 渲染端整包上报，主进程 `snapshot = request` 一次替换                            |
| 「谁是当前活动编辑器」由**切换代次**判定     | 上报 / 失效 / 清除都带 `generation`，主进程按代次水位 + 已结束代次收消息        |
| 只接受活动编辑器                             | 渲染端按「活动标签 + 活动分组」过滤，且只有当前归属者能清空 / 失效快照          |
| 令牌不进日志                                 | `mcp/server.ts` 的 `deskLog` 只记 url / 端口 / 状态，从不记 token               |
| 只读                                         | 工具链路里没有任何写文件 / 写 Git 调用                                          |

### 2. 确定性单测（新增 / 受影响）

| 测试文件                                             | 数量 | 覆盖                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main/selection/selectionService.test.ts`            | 15   | 整包替换、草稿标记、空选区、多选区、**两种切换顺序 / 旧代次迟到上报 / 已结束代次不复活**、三个语义上限各自失效并恢复、`overLimit` 标记、按笔记清除、`invalidateNow` 兜底                                                            |
| `main/ipc/selection.test.ts`                         | 6    | **IPC 边界**：三个语义上限经真实 handler 进来都要返回 `context_too_large`（不是 `INVALID_REQUEST`）、没有旧正文、缩小后恢复；超传输上限被 schema 挡下也必须失效；旧代次 clear 不清新快照                                            |
| `renderer/src/selection/selectionReporter.test.ts`   | 13   | 换归属者才推进代次、`accepted:false` / IPC 失败都不记去重签名（可重试）、**超限后原样选回同一内容能恢复**、**旧代次响应迟到不改新代次缓存**、超传输上限只报不带正文的超限状态、旧归属者失效被跳过、无上报不发 clear、桥缺失静默降级 |
| `renderer/src/clipboardText.test.ts`                 | 3    | 异步剪贴板成功时不走兜底；被 `NotAllowedError` 拒绝时退回同步手势路径并把文本真的放进 textarea；两条路都失败返回 false                                                                                                              |
| `renderer/src/selection/visualSelection.test.ts`     | 8    | 段落 / 跨段 / 代码块 / 代码组 / NodeSelection / CM 多光标 / raw block 细分类型                                                                                                                                                      |
| `renderer/src/selection/sourceBlocks.test.ts`        | 5    | 源码视图的行状态机（围栏 / 容器 / 标题 / 列表 / 引用）                                                                                                                                                                              |
| `renderer/src/markdown/MarkdownSourceEditor.test.ts` | 14   | 精确范围（1 基行列、0 基偏移、结束不含）、不 trim、emoji、非活动标签不 emit                                                                                                                                                         |
| `renderer/src/editor-groups/NoteTabPane.test.ts`     | 28   | 其中 1 条：**只有活动分组里的活动标签能写入快照**（多分组隔离的守卫）                                                                                                                                                               |

### 3. 真实界面 + 真实 MCP 协议（E2E，共 57 项）

**`e2e-mcp-selection.mjs`（阶段 A，24/24）**：启动与回环地址、令牌长度、
无令牌 / 错令牌 401、伪造 `Origin` / 非回环 `Host` 403、`initialize` + `tools/list`（刚好 1 个工具）、
工具说明含 draft 与磁盘提示、无选区是结构化结果、源码视图精确范围与逐字文本（含 emoji 与行尾空格）、
相关块只含涉及块、`revision` / `contentSource`、失焦后仍可读、主动取消清除、草稿标记、
切笔记失效、工具调用前后磁盘字节不变、令牌轮换（旧令牌 401 + 旧会话断开 + 新令牌可用）、
关闭开关后停服并释放端口。

**`e2e-mcp-visual-selection.mjs`（阶段 B，33/33）**：段落内 / 跨段落 / 普通代码块 /
代码组面板 / 整块思维导图（`raw-block:mindmap` + 完整原文）、失焦后清 DOM 选区不算取消、
搜索框不冒充正文选区、草稿标记、两个编辑器分组的身份与选区隔离（切过去 / 切回来各一轮）、
**选字超限**（25507 字符 > 20000）与**相关块超限**（在 65k 单段里只选 2 个字符 → 相关块 65001 字符 > 60000）
都明确失效、**超限后原样选回同一段内容可以恢复**、取消后恢复、关闭标签失效、只读（磁盘字节不变）、
设置界面（地址 / 状态 / 令牌 / 配置示例 / 关闭释放端口 / 重开恢复 / 端口占用明确报错且不顶掉占用方）、
无未捕获页面异常。

### 4. 真实客户端验证（阶段 C）

**未做**。未获授权安装 / 登录客户端或改客户端配置，因此没有用「两个实际安装的客户端
（至少一个真实 Agent 客户端）」联调，只做了官方 SDK 客户端 + 裸 HTTP 校验。
待授权后的步骤见第六节。

## 四、验证过程中发现并修掉的问题（都有「撤掉修复即变红」的证据）

| #   | 问题                                                                                             | 影响                                                               | 钉住它的证据                                              |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------- |
| 1   | 可视化视图的选区上报挂在 PM 事务上，**代码块 / 代码组面板里的 CodeMirror 选区不产生 PM 事务**    | 在代码块 / 代码组里选了一段，Agent 读不到（首版明确要支持的两类）  | `e2e-mcp-visual-selection`：普通代码块 1 项 + 代码组 1 项 |
| 2   | 多分组切换时「新活动编辑器上报」与「旧编辑器失效」同 tick 竞争，**旧分组的失效把新上报一起清掉** | 切到另一个编辑器分组后，本应可读的选区变成 `selection_invalidated` | `e2e-mcp-visual-selection`：切过去 / 切回来 2 项          |
| 3   | 选区超限时只拒绝本次上报、**旧快照原样保留**                                                     | 工具把上一次的选区当成「当前选区」返回（静默给出过期内容）         | `selectionService.test.ts` 超限用例 + E2E 大选区用例      |
| 4   | raw 块类型只有粗分类（`raw-block:raw-container`）                                                | Agent 分不清「代码组」「思维导图」，等于没有类型信息               | `visualSelection.test.ts` 细分类型用例 + E2E 2 项         |
| 5   | 选区上报桥缺失时直接解引用 `window.desk.selection`                                               | 单测 / 非 Electron 环境下 mounted 抛异常，整组用例失败             | `MarkdownSourceEditor.test.ts` 14 项恢复全绿              |

## 四之二、复核后修掉的两个 P1（本轮新增）

### P1-1 分组归属保护与主进程拒收逻辑冲突，切换后仍返回旧笔记

- **复现**：A 的选区已写入主进程 → B 先上报（渲染端把归属者改成 B）→ A 随后失效被"只有归属者可以失效"跳过
  → B 的上报到达主进程又被"当前快照属于另一篇笔记"拒收 → MCP 仍返回 A 的选区（`status: ok`）。
- **根因**：把"上一个快照的笔记"当成"当前活动笔记"来判新旧，和渲染端的归属者保护叠加成互相拒收；
  此外渲染端只看 IPC 的 `ok`、不看业务结果 `accepted:false`，并且**在收到结果之前就记了去重签名**，
  于是被拒的选区再也发不出去。
- **修法**：统一成**切换代次**（`generation`）——活动编辑器每换一次就 +1，随上报 / 失效 / 清除一起发；
  主进程只接受「代次 ≥ 水位」的消息，并记录**已结束代次**（结束代次的上报一律丢弃，防"在途上报复活旧内容"）。
  归属者只用于"谁能清空 / 失效"。渲染端改为：只有 `ok && accepted` 才记去重签名，
  `accepted:false` / IPC 失败都记诊断并允许重试。
- **钉住它的证据**：`selectionService.test.ts`（两种切换顺序都不得留下 A 的选区、旧代次迟到上报不覆盖新快照、
  已结束代次不复活）；`selectionReporter.test.ts`（换归属者才推进代次、`accepted:false` 后可重试）；
  `e2e-mcp-visual-selection.mjs`（切过去 / 切回来两轮，身份与文本都不串）。

### P1-2 更大的选区被 IPC 提前拒绝，绕过旧快照失效

- **复现**：先上报正常选区，再上报一个 60 001 字符的块 —— 被 schema（`max(60_000)`）拒绝，
  `selectionService.update()` 没机会执行，MCP 仍返回前一个选区且 `status: ok`。
- **根因**：IPC 的传输上限与服务的语义上限是同一组数字，schema 抢在服务前面拒收。
- **修法**：拆成两组常量 —— **语义上限**（20k / 60k / 20，判定只在 `selectionService`）
  与**传输上限**（1M / 500 / 总量 2M，明显更高）；超过传输上限的负载由渲染端改发
  **不带正文的超限状态**（`capture.overLimit`）；另外给上报通道加 `onInvalid` 兜底：
  被 schema 挡下时也让旧快照失效（`invalidateNow`），任何"上报没进来"的情况都不留过期内容。
- **钉住它的证据**：`main/ipc/selection.test.ts` 三个语义上限都走真实 handler 并返回 `context_too_large`
  （不是 `INVALID_REQUEST`）、没有旧正文、缩小后恢复；超传输上限被挡下时旧快照失效；
  `selectionReporter.test.ts` 超传输上限只报不带正文的超限状态、刚超语义上限照常发正文（交给主进程判定）；
  `e2e-mcp-visual-selection.mjs` 相关块超限用例（65001 字符）。

### P2 超限后重新选回原来的内容被去重缓存拦住

- **复现**：上报正常选区 A（成功，写入去重签名）→ 同一编辑器上报 20 001 字符（主进程清快照、
  返回 `context_too_large`）→ 再次上报**与 A 完全相同**的内容 → 渲染端认为"签名没变"直接跳过 →
  MCP 一直停在 `context_too_large`。原有恢复用例换了另一段内容，所以没盖住这个分支。
- **根因**：被拒时只"不记录新签名"，却留着**已不代表主进程当前状态**的旧成功签名。
- **修法**：去重缓存改成「主进程确认接受过的内容 + 它所属的代次」：只有 `ok && accepted` 才写入；
  被拒 / IPC 失败立刻作废；异步结果先核对代次，迟到的响应既不写、也不清新代次的缓存。
  超限（语义与传输两种）之后原样重报都能恢复。
- **钉住它的证据**：`selectionReporter.test.ts` 新增 4 条 —— 语义超限后原样选回恢复、
  传输超限（不带正文状态）后原样选回恢复、旧代次的接受响应迟到不顶掉新代次缓存、
  旧代次的失败响应迟到不清新代次缓存；E2E 新增「超限之前先建立成功快照 → 相关块超限 →
  原样选回同一段 → 恢复 ok」。把缓存逻辑临时退回旧行为时，这 3 条单测立刻变红。

### 修复：设置页两个复制按钮在 Desk 里静默失败

- **现象**：点「复制令牌」「复制配置示例」都没写进系统剪贴板，按钮也没有任何失败反馈。
- **根因**：Desk 主进程 `setPermissionRequestHandler(... callback(false))` 拒绝一切权限请求，
  渲染端 `navigator.clipboard.writeText` 会抛 `NotAllowedError: Write permission denied.`。
  本机实测（一次性探针）：`isSecureContext=true`、`navigator.clipboard` 存在、
  `permissions.query({name:'clipboard-write'})` 甚至返回 `granted`，**但写入仍然被拒** ——
  只 `catch {}` 吞掉就是"点了没反应"；同步路径（隐藏 textarea + `execCommand('copy')`）实测可用。
- **修法**：新增共享 `clipboardText.writeClipboardText`（先异步 API，失败退回同步手势路径，
  返回是否真的成功），设置页用它并在失败时给出可见提示（令牌 / 配置在界面上可直接手动选中）；
  同一根因的另外两处复制（资源详情「复制路径」、笔记「复制诊断信息」）也改用同一 helper。
- **证据**：`clipboardText.test.ts` 3 条；E2E 新增 4 条 —— 点「复制令牌」后从**主进程读系统剪贴板**
  断言等于当前令牌、按钮显示「已复制」、点「复制配置示例」后断言剪贴板含 url 与令牌、
  全程没有失败提示（E2E 因此加了 `locks: ['clipboard']`，避免与其它剪贴板套件互相覆盖）。

### 顺带修掉：切笔记 / 切视图瞬间读到已销毁的编辑器视图

E2E 新增用例时暴露的未捕获异常：`refreshSelection` 在切换瞬间拿到 state 已失效的
ProseMirror / CodeMirror 视图（`Cannot read properties of undefined (reading 'selection')`）。
现在采集入口对这种死视图直接返回（`captureVisualSelection` / `codeMirrorCapture` / `selectionCapture`），
让上一步的失效结论成立，而不是去读一个死掉的 state。

## 五、支持的选区类型与上限（首版）

- **源码视图**：单个非空选区（正 / 反选归一）→ 逐字原文 + 精确范围 + 涉及块行范围；
  **多光标明确不支持**（`unsupported_selection`）。
- **可视化视图**：段落内、跨段落、普通代码块内部、代码组当前面板内部、
  整块特殊组件（`NodeSelection`：思维导图 / mermaid / 组件容器 → 类型 + 完整原文）；
  代码编辑器多光标明确不支持；无法映射只给块级上下文，不编造坐标。
- **上限**：选中 20 000 字符 / 相关块 60 000 字符 / 20 块，超出 → `context_too_large` 并说明原因，**不静默截断**。
- 计数规则：行列为 1 基、偏移 0 基 UTF-16、结束不含、文本不 trim，每个范围都标 `draft` / `disk`。
- 快照生命周期：失焦保留、取消清除、切笔记 / 切视图 / 关笔记 / 外部改动失效、内容变化按当前选区重报、
  **当前活动编辑器由切换代次判定**（旧代次的迟到上报 / 失效既不覆盖也不能复活旧内容）、
  只有活动编辑器可更新、非正文输入不算选区。
- 上限分两组：语义上限（20k / 60k / 20，超限 → `context_too_large` 并失效旧快照）、
  传输上限（1M / 500 / 总量 2M，超了就不发正文、只报超限状态）。

## 六、未验证边界（如实列出）

1. **真实客户端联调（阶段 C）**：未安装 / 未配置任何实际客户端，因此
   「客户端能否解析配置、能否带自定义请求头、初始化后能否稳定调用」尚未验证。
   计划（需授权后执行）：在本机已安装的 MCP 客户端里配置 `http://127.0.0.1:39217/mcp` +
   Bearer 令牌，实跑「用户提到当前选区 → 调用工具 → 转述结果」；
   至少一个是真实 Agent 客户端，另一个可以是只读探测工具；只读盘点客户端清单不需要授权。
2. **源码视图多光标（多处选区）**：只有单测覆盖（`getSelections()` 分支）；E2E 没有触发真实多光标。
3. **只读视图（`viewMode: readonly`）的选区**：采集路径同可视化，但未在真实界面单独验。
4. **非正文输入的其它形态**：只验了侧栏搜索框；图片描述框、callout 标题输入框等按设计不触发
   （不在 `.milkdown` 里、也不是 CM 焦点），未逐个真实界面验证。
5. **块数 / 块字符超限**：只有单测覆盖；真实界面验的是选字超限。
6. **打包产物**：E2E 跑的是 `out/`（electron-vite build）；未跑 `e2e-packaged-smoke`，
   asar / 打包后 SDK 打进来是否正常未验（SDK 已进 main bundle，未在 .app 里跑过）。
7. **多窗口 / 多实例**：未验（本轮都是单窗口）。
8. **Windows / Linux**：未验（本轮只在 macOS）；服务本身与平台无关，但凭据存储与打包差异未测。
9. **端口占用后的客户端侧表现**：Desk 侧文案明确（不偷偷换端口），客户端如何报错未验。
10. **令牌轮换后的客户端重连**：Desk 侧旧令牌 401 + 旧会话断开已验证；客户端重连行为未验。

## 七、工作约定遵循情况

- 本轮**未** `git push`、未打标签、未发版；
- 每个改动按项提交（设置界面 / 超限 / 代码块选区 / 分组归属 / 细分类型 / 单测 / E2E 各一条）；
- 测试使用隔离的临时知识库与 profile，未触碰真实笔记目录。
