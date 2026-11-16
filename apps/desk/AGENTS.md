# Desk

Electron + Vue 3。可视化编辑器用 Milkdown / ProseMirror（**自组装配**：`src/renderer/src/markdown/deskEditor.ts` + 从 Crepe 移植的特性 `crepePort/`，不再依赖 `@milkdown/crepe`），笔记页（可视化与源码）和只读文本标签都是 CodeMirror 6。知识库读写 `@tnotesjs/kb`，预览 `@tnotesjs/ssg`，共享块 `@tnotesjs/ui`。

- 知识库文本文件浏览（只读）：主进程 `kb-files:list` / `kb-files:read`（`packages/kb/src/files.ts`）只列一层目录，并按拒绝名单过滤 `.git` / `node_modules` / `.tnotes/dist` / 系统垃圾；**能不能当文本看由字节判定**（采样里有 NUL 或非法 UTF-8 → 不是文本），不看扩展名。面包屑等入口打开的 `text-file` 标签用只读 CodeMirror 渲染。
- 左侧内容区顶部三个视图：笔记目录、搜索、Git（`components/navigatorView.ts`，记住上次视图；曾经的「文件」记忆回到笔记目录）。`assets/` 存在时头部有资源入口，打开已有的知识库资源标签；`demos/` 存在时有实验入口，列出直属的 `0001. 名称` 文件夹，用已配置的 IDE 打开，不在 Desk 里编辑。
- 标题里按一次 Backspace（光标在行首）**直接回正文**，不论几级标题 —— 覆盖 Milkdown 默认的逐级降级（`markdown/headingKeymap.ts` 用优先级 100 抢在 `DowngradeHeading` 前）。行内其它位置、Delete、空选区之外的场景都放行给默认行为。
- 代码块收起 / 展开（Desk 与站点同一套规则，规则在 `@tnotesjs/ui/code` 的 `collapse.ts`）：**纯视图状态**，不写回 markdown、不写 localStorage，重开笔记一律展开；**折叠 = 代码区整体隐藏、只剩标题栏**（`is-collapsed`，不是「露出前几行」）；每个代码块标题左侧都有折叠 Icon（编辑器里是 `.tools` 里的 `.desk-code-collapse`，`order: -1` 固定在标题左侧），只有点它才切换；代码分组的 Icon 在 tab 行最左侧，切换 tab 自动展开新面板（`deskRawBlockView/container.ts` 的 `activateTab`）。站点侧由 `CodeBlock.vue`/`CodeGroup.vue` SSR 出 Icon，`hydrateIslands.ts` 用同一套 class 契约补行为。**代码块高度一律由内容撑开**：不设 `max-height`、不出现内部纵向滚动（`milkdownMarkdownEditor.scoped.css` 里代码块 / 代码分组面板 / raw 块源码编辑器与预览都放开）。
- Markdown 是磁盘 canonical。自定义语法经 `rawBlockProjection.ts` 投影为 `deskRawBlock`；`sourcePreservation.ts` 保证未编辑块字节级零 diff。
- 独占一行的 `<br />` 不投影，交给 Milkdown `remark-preserve-empty-line`。段内 / 表格内 `<br>` 仍走投影。
- 自由绘图是**两个文件一份资源**：`assets/*.excalidraw` 是唯一真相源，同名 `.svg`（如 `0013-x.excalidraw` ↔ `0013-x.svg`）是**派生图**，由 `exportToSvg` 导出（字体已内联）。笔记里引用的就是那张派生 `.svg`（`![画布](../assets/0013-x.svg)`），**完全按图片处理**：拖拽改尺寸、描述、对齐都走 `markdown/deskImageView.ts`。判据只有一条：同名 `.excalidraw` 在 → 图上多一项「编辑」（打开 `editor-groups/ExcalidrawTabPane.vue` 的画布标签页）；不在 → 就是一张普通图片。**没有笔记内嵌编辑器**，SSG 也没有画布岛（站点只是渲染那张派生 SVG）。
- 画布写入必须走 `window.desk.excalidraw.*` 受限 IPC：源文件只允许 `assets/*.excalidraw`（≤32MB、写要带 `expectedRevision`），派生图 `writeDerived` **只能写与源画布同目录同名的 `.svg`**（目标路径由主进程推导，渲染端指定不了），两者都过资源写入门禁。画布标签页打开期间该库有未写完内容的画布会阻止资源整理。画布内容变化**不改笔记源码**；派生 `.svg` 由 `editor/excalidraw/canvasImage.ts` 在编辑期间节流重导出（内存预览即时、落盘 1.2s 节流、关标签页前冲刷）。
- 归属规则：文件名四位前缀是主人。**引用的资源一律拷贝、不共享**：把画布图粘贴到别的笔记时，由 `markdown/canvasImageClipboardPlugin.ts`（规则在 `editor/markdown/canvasImageRefs.ts`）把 `.excalidraw` 复制成目标编号的新文件、按新内容重新导出同名 `.svg`，并改写插入的引用；同编号粘贴不复制。
- 笔记级资源面板（右侧栏，`editor-groups/NoteAssetsPanel.vue`）：按「本笔记引用的资源 / 编号匹配的资源 / 引用缺失」分组，支持复制相对路径、定位正文引用、插入图片、删除无效资源（走回收区）与修复编号不匹配（重命名 + 主进程改写引用）。数据不跑整库扫描：引用直接从笔记 markdown 解析（带偏移），编号匹配用 `kbFiles.list('assets')` 列一层；判定规则在 `editor-groups/noteAssets.ts`（纯函数 + 单测）。画布的 `.excalidraw` 与同名 `.svg` 视为一份资源的两半：任一侧被引用，两半都不算无效。
  - 面板的删除是**定向删除**：`assets.planRecycle(kb, relPaths, generation, { targeted: true })`。`targeted` 只放开两处——不要求整库批量清理的覆盖门禁、允许删画布真相源；「该资源确实没有任何引用」这条安全线不放开（不确定引用也算引用）。批量清理仍走默认模式，画布源文件照样挡住。
  - 画布重命名由 `packages/kb/src/asset-scan/plan.ts` 的 `planRename` **自动配对**：改任一半（`.excalidraw` 或派生 `.svg`）都把同名另一半一起搬并改写指向派生图的引用，且不许换后缀；落盘与撤销都按 `plan.moves` 逐个文件处理。
- 资源 journal / 回收区在 `userData/asset-journals|asset-recycle/<kb-root-sha256>/`，打开知识库时会先恢复未完成事务。未完成 journal 会暂停该库 Git 与写入。资源面板在确定性范围内可预览、执行重命名/回收/同笔记合并/sharp 有损压缩并按 journal 恢复；渲染端只提交计划 ID。IPC `assets:plan-*` / `assets:apply` / `assets:restore` / `assets:history` 受脏文档与 Git 门禁约束。压缩默认有损，禁止标成无损。
- 历史版本（笔记与资源）：只读部分在 `main/history/gitHistory.ts`（按四位编号关联历史文件名与同编号资源、固定 HEAD 分页、只收 40 位 OID + 快照内路径），`renderer/history/*` 是只读渲染（commit 上下文 + `tnotes-asset://history` 协议，缓存键 `commit:blobOID`，绝不回退当前磁盘）。
- 恢复分成两段：`history:plan` 只验证并固化影响范围（不改文件），`history:apply` 执行写回。渲染端**只能提交计划 ID + revision**，字节与路径不出主进程；确认前必须先受控 flush（画布 settle → 保存笔记 → 写者快照），有未完成写入就拒绝建计划。
- 恢复的写回是「阶段日志 + 原始字节」事务：日志与回滚数据在 `userData/history-restore-journals/<kb-root-sha256>/`（**不在 KB 里、不进 Git**），阶段 `planned → backing-up → backed-up → writing → written → committing → committed`，每步落盘。备份提交与恢复提交都复用 H0 的按路径独立索引（`main/history/gitSnapshot.ts`），不夹带其它暂存内容、无变化不产生空提交。
- 崩溃恢复：打开知识库时 `workspaceManager.syncAssetWriteHolds()` 会先跑 `recoverHistoryRestore`——写完一半按日志回滚，提交已生成则按「父提交 + 目标路径 blob OID」识别并清理日志（不重复提交）。仍有 `failed` 日志时沿用 `incomplete-journal` 暂停该库 Git 与写入（目前没有「确认失败日志」的 UI 入口，属于已知遗留）。
- 恢复与资源整理**共用** `withAssetWriteGuard`（`main/assetOperations.ts`）这一把写事务锁：同一知识库同时只允许一个写事务，互斥不排队；恢复期间自动写被暂停，恢复后笔记重新读盘、画布在下次可见时 `revalidate`（提示「磁盘上的画布已被其他入口修改」而不是静默覆盖）。
- 三类「版本/日志」不要混用：Git commit 是笔记与资源的版本真相；`asset-journals` 是资源整理的事务日志；`history-restore-journals` 是历史恢复的事务日志。画布的临时恢复数据仍走画布会话自己的机制，不写进这三者。
- 测试知识库在 `apps/desk/playground`。
- 门禁：`pnpm --filter desk lint && pnpm --filter desk test && pnpm --filter desk typecheck && pnpm --filter desk build && pnpm format:check`（格式化检查用**根目录**的 `pnpm format:check`，与 CI 一致 —— prettier 只读运行目录下的 `.prettierignore`，在 `apps/desk` 里跑不到根目录的排除项）
- E2E（`scripts/e2e-*.mjs`）验的是 `out/`，改完先 `pnpm --filter desk exec electron-vite build`。
