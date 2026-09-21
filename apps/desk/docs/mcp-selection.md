# 本机 MCP 选区上下文服务（工具契约 + 客户端接入）

**状态**：**实现待验收**（阶段 A / B 已自测通过；阶段 C「两个真实客户端联调」未做，见验收报告）。

Desk 把「用户当前选中的笔记内容」通过本机 MCP 服务暴露给外部 Agent，
让 Agent 不必让用户复制路径和正文。**首版只有一个只读工具** `get_current_selection`。

---

## 一、三层结构（选区能力不绑在 MCP 上）

| 层             | 代码位置                                     | 职责                                                             |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| 编辑器选区采集 | `src/renderer/src/selection/*`、各编辑器组件 | 以**编辑器状态**为准采集选区（不读 DOM 文本、不截图）            |
| 上下文服务     | `src/main/selection/selectionService.ts`     | 校验、原子替换、失效 / 清除、唯一读取接口 `read()`（与协议无关） |
| MCP 接口       | `src/main/mcp/server.ts`（官方 SDK）         | Streamable HTTP + 鉴权 + 工具注册；工具直接读上下文服务          |

将来的内置 Agent 可以直接复用中间层，不需要绕本机 HTTP。

## 二、连接方式

- **地址**：`http://127.0.0.1:39217/mcp`（端口可在「设置 → 本机 MCP」改；改了要同步客户端配置）
- **只监听回环地址**（`127.0.0.1`），不监听所有网卡；
- **鉴权**：请求头 `Authorization: Bearer <令牌>`（令牌在设置里复制 / 重置；**不放 URL**）
- **传输**：MCP **Streamable HTTP**（`enableJsonResponse`）；会话 id 走 `mcp-session-id` 头
- **开关默认关闭**。设置里打开后主进程才监听；关闭或退出应用会停服务、释放端口、断开现有会话
- 端口被占用时**明确报错**（「端口 N 已被占用，MCP 服务未启动（不会自动改端口）」），
  不会静默换端口 —— 否则配好的客户端会失联

### 本地安全措施

| 措施          | 说明                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| 回环监听      | 只 `listen(port, '127.0.0.1')`                                           |
| `Host` 校验   | 只接受 `127.0.0.1` / `localhost` / `[::1]`（挡 DNS rebinding），否则 403 |
| `Origin` 校验 | 带了 `Origin` 就必须是本机来源（浏览器页面默认被挡），否则 403           |
| Bearer 令牌   | 随机 256 位；恒定时间比较；**不写日志**、不进笔记、不进知识库配置        |
| 令牌存储      | 系统凭据存储加密（Electron `safeStorage`，文件权限 0600 兜底）           |
| 重置令牌      | 立刻换新值并**关闭所有现有会话**：旧令牌 / 旧连接不能再读                |

客户端配置示例（设置页里可直接复制）：

```json
{
  "mcpServers": {
    "tnotes-desk": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:39217/mcp",
      "headers": { "Authorization": "Bearer <令牌>" }
    }
  }
}
```

> 客户端必须支持 **Streamable HTTP** 与**自定义请求头**。
> 只支持 stdio 的客户端不在首版直接接入范围内。

## 三、工具契约

### `get_current_selection`

无参数。返回一个文本块（`content[0].text` 是格式化 JSON）以及同一份 `structuredContent`。

**用法约定**：用户提到「Desk 当前选区 / 我选中的内容」时，**先调用这个工具**；
`status` 不是 `ok` 就如实告诉用户当前没有有效选区，**不要臆测内容**。
它只读：不会修改笔记、文件或 Git 状态。

### `status` 取值

| status                  | 含义                                                    | 是否给内容                             |
| ----------------------- | ------------------------------------------------------- | -------------------------------------- |
| `ok`                    | 有有效选区                                              | 给                                     |
| `no_selection`          | 用户没有选中内容，或主动取消了选区                      | 不给（`message` 说明）                 |
| `unsupported_selection` | 选区形式首版不支持（多光标 / 无法映射）                 | 不给（`message` 说明原因）             |
| `selection_invalidated` | 上一次选区已失效（切笔记 / 切视图 / 关笔记 / 外部改动） | 不给（不回退旧内容）                   |
| `context_too_large`     | 选区超过上限                                            | 不给（`message` 给出超限原因与字符数） |

任何非 `ok` 都是**结构化结果**，不是服务器错误（不会抛异常给客户端）。

### `ok` 时的字段

```jsonc
{
  "status": "ok",
  "snapshotId": "uuid", // 每次有效快照一个 id；失效 / 清除后不再提供旧内容
  "capturedAt": "2026-09-21T10:00:00.000Z", // 仅用于展示，不是版本标识
  "knowledgeBase": { "id": "kb-…", "name": "TNotes.docs", "rootPath": "/…/TNotes.docs" },
  "note": { "id": "uuid", "title": "标题", "absolutePath": "/…/notes/0001. 标题.md" },
  "editor": {
    "viewMode": "visual", // visual | readonly | source
    "collector": "visual", // source | visual | readonly（哪条采集路径）
    "contentSource": "draft", // draft | disk：选区坐标对应哪份内容
    "hasUnsavedChanges": true,
    "revision": "e73b…" // 内容版本令牌（笔记 revision，草稿变动时递增），不是时间戳
  },
  "selection": {
    "selectedText": "选中的原文",
    "mapping": "block", // source-range（能精确映射到源码）| block（只有块级上下文）
    "sourceRange": {
      "startLine": 3,
      "startColumn": 1,
      "endLine": 3,
      "endColumn": 6,
      "startOffset": 8,
      "endOffset": 13,
      "lineBase": 1,
      "columnBase": 1,
      "endExclusive": true,
      "source": "disk" // 这份坐标属于磁盘内容还是编辑器草稿
    },
    "blocks": [
      {
        "kind": "raw-block:code-group",
        "markdown": "::: code-group\n…\n:::",
        "source": "raw",
        "sourceRange": { "startLine": 7, "endLine": 19 }
      }
    ]
  },
  "limits": { "maxSelectedChars": 20000, "maxBlockChars": 60000, "maxBlocks": 20 }
}
```

**计数规则（明确写死，避免歧义）**

- 行 / 列都是 **1 基**（`lineBase: 1`、`columnBase: 1`）；
- `startOffset` / `endOffset` 是 **0 基 UTF-16 码元**偏移（Monaco / JS 字符串口径，emoji 占 2 个）；
- **结束位置不含**（`endExclusive: true`）：`endOffset - startOffset === selectedText.length`；
- 文本**逐字返回**：不 trim、不折叠空白，行尾空格与末尾换行照原样带出；
- 每个范围都带 `source`（`draft` / `disk`）说明它对应哪份内容。

**`contentSource: "draft"` 的含义**：内容来自编辑器草稿，**可能与磁盘不同**。
此时的行列 / 偏移只对草稿成立，**不要拿它去改磁盘文件**；
要按磁盘定位请让用户先保存，或用 `hasUnsavedChanges` 判断。

### 块上下文（`selection.blocks`）

- 只给**与选区相交的块**，绝不给整篇笔记或整个知识库；
- `source: "raw"` = 与编辑器里的原文**逐字一致**（源码视图切片、特殊组件原文）；
- `source: "reserialized"` = 编辑器**重新序列化**得到的 Markdown，未必与文件逐字相同；
- `kind` 是给 Agent 看的类型：
  - `paragraph` / `heading:N` / `list` / `blockquote` / `table` / `code` / `image` / `container:callout`；
  - raw 块带上可识别的细分类型：`raw-block:code-group`、`raw-block:mindmap`、`raw-block:mermaid`、
    `raw-block:js`…（识别不出时回落到粗分类，如 `raw-block:raw-component`）。

### 上限（超出即 `context_too_large`，**不静默截断**）

| 维度                     | 上限   |
| ------------------------ | ------ |
| 选中字符数               | 20 000 |
| 相关块 Markdown 总字符数 | 60 000 |
| 相关块数量               | 20     |

超限时旧快照会失效（不会把上一次的选区当成当前选区返回），`message` 里给出实际字符数与上限。

**语义上限 vs 传输上限**：上面这三个是**语义**上限，判定只在主进程
（`selectionService`）；IPC 的 schema 另有一组**传输**上限（1M 字符 / 500 块 / 总量 2M），
它必须明显高于语义上限 —— 否则「刚刚超语义上限」的上报会被 schema 挡在门外，
服务没机会执行，旧快照会继续以 `ok` 返回。超过传输上限的选区不会把正文塞进 IPC：
渲染端改发**不带正文的超限状态**（`capture.overLimit`），主进程照样明确失效。

## 四、支持的选区类型（首版）

| 视图     | 选区                                                             | 结果                                                           |
| -------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| 源码视图 | 单个非空选区（正选 / 反选都归一）                                | 逐字原文 + 精确范围（`mapping: source-range`）+ 涉及块的行范围 |
| 源码视图 | 多个不连续选区（多光标）                                         | `unsupported_selection`（明确不支持，不悄悄取其中一个）        |
| 可视化   | 段落内文本                                                       | 文本 + 涉及块（`mapping: block`，块标 `reserialized`）         |
| 可视化   | 跨段落文本                                                       | 同上，文本按块用换行连接                                       |
| 可视化   | 普通代码块内部（CodeMirror 选区）                                | 文本 + 该代码块（块级）                                        |
| 可视化   | 代码组**当前面板**内部                                           | 文本 + 整个代码组组件源码（`source: raw`）                     |
| 可视化   | 整块特殊组件（`NodeSelection`，如思维导图 / mermaid / 组件容器） | 类型 + **完整组件源码**（`raw`）；不编造块内坐标               |
| 可视化   | 代码编辑器多光标                                                 | `unsupported_selection`                                        |
| 任意视图 | 选区落在无法识别的块之间                                         | `unsupported_selection`（不拼坐标）                            |

**快照生命周期**

- 失焦（切到外部 Agent）**保留**快照；失焦后 DOM 选区的变化**不算取消选区**；
- 用户主动取消选区（光标收成空选区）→ `no_selection`；
- 切笔记 / 切编辑视图 / 关笔记标签 / 磁盘被外部改动 → `selection_invalidated`；
- 内容变化（未保存）→ 用**当前**选区重新上报，并标 `contentSource: draft`；
- 快照整包原子替换，不会出现「路径来自 A、文本来自 B」；
- 非正文输入（搜索框、设置项、图片描述等）不会被当成正文选区。

**谁是"当前活动编辑器"（内部机制，排查问题时用得上）**

每个上报 / 失效 / 清除都带一个**切换代次** `generation`：活动编辑器每换一次
（换分组 / 换标签 / 换笔记 / 换视图）渲染端就 +1，主进程只接受「代次不小于已见最大代次」
的消息，并把被明确结束的代次记下来（结束代次上的上报一律丢弃）。

为什么不用"上一个快照是哪个笔记"来判断：切换的瞬间，新编辑器会上报、旧编辑器会失效，
两条消息顺序不保证 —— 用笔记比对会互相拒收（新上报被当成"别的笔记"拒掉，
旧失效又被归属者保护跳过），结果是旧笔记的选区一直以 `ok` 返回。代次把
"我描述的是哪个上下文"变成消息自带的属性，两种顺序都收敛到新编辑器；旧代次的迟到上报
既不能覆盖新快照，也不能复活已结束的上下文。

多个编辑器分组时另有一条：只有**活动标签 + 活动分组**的编辑器能上报，
不是当前归属者的编辑器也不许清空 / 失效快照（后台分组既不能覆盖，也不能误清）。

## 五、SDK 与协议版本

| 项         | 值                                                                         |
| ---------- | -------------------------------------------------------------------------- |
| MCP SDK    | `@modelcontextprotocol/sdk` **1.30.0**（MIT，Anthropic PBC，锁定精确版本） |
| 协议修订   | 客户端声明 `protocolVersion: 2025-06-18`（E2E 客户端实测通过）             |
| 传输       | Streamable HTTP（服务端 `StreamableHTTPServerTransport`，JSON 响应）       |
| 服务端标识 | `tnotes-desk-selection` 0.1.0                                              |

## 六、把工具接给 Agent 时的注意点

1. **不要承诺「Agent 一定会自动调用」**：能否自动调用取决于客户端。可用的约定是
   「用户提到 Desk 当前选区 → 先调 `get_current_selection`」；
2. `status` 不是 `ok` 时如实转述，不要用笔记里的其它内容顶替；
3. `contentSource: draft` + `hasUnsavedChanges: true` 时，提醒用户草稿与磁盘可能不一致；
4. 需要写文件 / 跑命令时用 Agent 自己的能力，不要指望这个服务（它是只读的）；
5. `revision` 可以当版本令牌用（两次读取相同就是同一版本），`capturedAt` 只用于展示。
