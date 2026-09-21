// desk e2e 套件注册表：runner（scripts/run-e2e.mjs）据此做增量选择与并发调度。
//
// 字段：
//   name   脚本文件名（相对 scripts/）
//   area   区域标签（--only/--skip 可按键名、去前缀名或 area 匹配）
//   tier   `regression`（默认参与全量）｜`manual`（人工工具/试验台/基准，默认不跑，
//          用 --include-manual 才跑）
//   globs  该套件覆盖的源码路径 glob（相对仓库根）；`--since <ref>` 用它和 git 改动
//          文件求交。以「它实际断言的代码路径」为准，宁可多写主要依赖。
//   serial true = 独占跑（全局快捷键 / 原生菜单 / 拖拽 / 焦点 / 大窗口 / 系统剪贴板 /
//          固定端口 / app.quit 等对「同时还有别的 Electron 在跑」敏感的套件）
//   smoke  true = PR 冒烟核心集（快、稳、覆盖面广）
//   note   一句话说明验什么（--list 时人读）
//
// 体检结论（2026-09-12，4 路并行审计 + 实测）：
//   · `e2e-mindmap` 没有任何断言（启动→截图→dump 像素），是人工观察工具 → tier=manual
//   · `e2e-excalidraw-e0` 验的是 packages/ui/e0-spike 试验台而非产品，产品交接由
//     excalidraw-tab 覆盖 → tier=manual
//   · `e2e-open-random-notes` 的断言点已被单测 + 其它套件的启动/打开流程覆盖，
//     属可删候选（保留是因为 4.5s 很便宜且是新 fixture 的启动冒烟）
//   · `e2e-packaged-smoke` 需要打包产物（`build:unpack`），且验的是 asar/Vite 这类
//     只在 .app 里才暴露的集成问题 → tier=manual
export const SUITES = [
  {
    name: 'e2e-assets-acceptance.mjs',
    area: 'assets',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor-groups/KbAssetsPane.vue',
      'apps/desk/src/renderer/src/editor-groups/kbAssetsReasons.ts',
      'apps/desk/src/main/assetOperations.ts',
      'apps/desk/src/main/imageEncode.ts',
      'apps/desk/src/main/imageUploadOptimize.ts',
      'apps/desk/src/main/encodeManager.ts',
      'apps/desk/src/main/imageBed.ts',
      'apps/desk/src/renderer/src/editor/markdown/pasteImageWidth.ts',
      'apps/desk/src/renderer/src/editor/markdown/noteViewPosition.ts',
      'packages/kb/**',
      'packages/ssg/**',
      'packages/ui/src/markdown/**'
    ],
    serial: false,
    locks: ['clipboard'],
    smoke: false,
    note: '资源验收：盘点/合并/压缩/转格式/断链 + SSG 产物资源完整性（sharp/oxipng、系统剪贴板、固定端口 8123）'
  },
  {
    name: 'e2e-external-change.mjs',
    area: 'notes',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/stores/workspace/documents.ts',
      'apps/desk/src/renderer/src/editor-groups/NoteTabPane.vue',
      'apps/desk/src/main/workspace/noteIo.ts',
      'packages/kb/src/workspace.ts'
    ],
    serial: false,
    smoke: false,
    note: '外部修改与未保存冲突：外部改盘后在 Desk 保存会弹冲突横幅、不覆盖磁盘、不丢本地编辑，载入磁盘可恢复'
  },
  {
    name: 'e2e-terminal.mjs',
    area: 'terminal',
    tier: 'regression',
    globs: [
      'apps/desk/src/main/terminalManager.ts',
      'apps/desk/src/renderer/src/stores/terminal.ts',
      'apps/desk/src/renderer/src/terminal/**',
      'apps/desk/src/main/ipc/terminal.ts',
      'apps/desk/src/shared/contracts.ts'
    ],
    serial: false,
    smoke: false,
    note: '交互式终端：真 node-pty 起 shell 并读回真实输出、cwd 绑定知识库、多会话并存、关闭隔离、旧代次输入被拒绝'
  },
  {
    name: 'e2e-command-task.mjs',
    area: 'command-task',
    tier: 'regression',
    globs: [
      'apps/desk/src/main/gitManager.ts',
      'apps/desk/src/main/commandTaskManager.ts',
      'apps/desk/src/main/ipc/commandTask.ts',
      'apps/desk/src/main/ipc/git.ts',
      'apps/desk/src/renderer/src/stores/commandTask.ts',
      'apps/desk/src/renderer/src/stores/workspace/git.ts',
      'apps/desk/src/renderer/src/terminal/**',
      'apps/desk/src/shared/contracts.ts'
    ],
    serial: false,
    smoke: false,
    note: '命令任务：手动 Git 操作在底部面板建标签、复用同一标签、失败重试走完整业务流程、排队取消不误杀同库正在跑的任务（真实 git 子进程与裸远端）'
  },
  {
    name: 'e2e-kb-assets.mjs',
    area: 'assets',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor-groups/KbAssetsPane.vue',
      'apps/desk/src/renderer/src/editor-groups/kbAssetsReasons.ts',
      'apps/desk/src/main/assetOperations.ts',
      'packages/kb/src/asset-scan/**',
      'packages/kb/src/assets.ts'
    ],
    serial: false,
    smoke: true,
    note: '资源改名/回收/恢复后磁盘与笔记引用同步'
  },
  {
    name: 'e2e-image-chrome.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor/markdown/deskImageView.ts',
      'apps/desk/src/renderer/src/editor/markdown/imageAttrs.ts',
      'packages/ui/src/markdown/image.ts',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue'
    ],
    serial: false,
    locks: ['clipboard'],
    smoke: false,
    note: '图片选中浮层几何 + 真实拖拽缩放（2px 容差，跨 DPI 易碎）'
  },
  {
    name: 'e2e-history-preview.mjs',
    area: 'history',
    tier: 'regression',
    globs: [
      'apps/desk/src/main/history/**',
      'apps/desk/src/main/assetProtocol.ts',
      'apps/desk/src/renderer/src/history/**',
      'apps/desk/src/renderer/src/editor-groups/HistoryTabPane.vue',
      'packages/ui/src/components/Mermaid/**',
      'packages/ui/src/excalidraw/**'
    ],
    serial: false,
    smoke: false,
    note: '历史标签页只读预览 + 恢复写回（自定义协议、真实 Git、原生菜单）'
  },
  {
    name: 'e2e-delete-dialog.mjs',
    area: 'notes',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/deletePreview.ts',
      'apps/desk/src/main/workspace/deleteScope.ts',
      'apps/desk/src/main/workspace/mutations.ts',
      'apps/desk/src/main/gitManager.ts',
      'apps/desk/src/main/contextMenus.ts',
      'apps/desk/src/renderer/src/App.vue'
    ],
    serial: false,
    smoke: true,
    note: '删除对话框：按 Git 状态说明后果 + 可选「先记录当前版本」（原生菜单 + Git 时序）'
  },
  {
    name: 'e2e-open-random-notes.mjs',
    area: 'notes',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/components/TocNodeList.vue',
      'apps/desk/src/renderer/src/stores/workspace/toc.ts',
      'apps/desk/src/renderer/src/stores/workspace/documents.ts',
      'apps/desk/src/main/workspace/scan.ts'
    ],
    serial: false,
    smoke: false,
    note: '自建 fixture：扫描 KB → 打开 3 篇笔记（体检结论：可删候选，断言已被单测+其它套件覆盖）'
  },
  {
    name: 'e2e-clear-line-styles.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/clearLineStyles.ts',
      'apps/desk/src/renderer/src/markdown/clearSourceLineStyles.ts',
      'apps/desk/src/renderer/src/markdown/sourceEdits.ts',
      'apps/desk/src/renderer/src/monaco/**',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue',
      'apps/desk/src/renderer/src/markdown/MarkdownSourceEditor.vue'
    ],
    serial: false,
    smoke: true,
    note: 'Mod-\\ 清整行样式（可视化/源码双视图）+ ⌘S 落盘保真'
  },
  {
    name: 'e2e-block-interactions.mjs',
    area: 'block-editing',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/rawBlockInteractions.ts',
      'apps/desk/src/renderer/src/markdown/verticalBlockSelection.ts',
      'apps/desk/src/renderer/src/markdown/blockActionMenu.ts',
      'apps/desk/src/renderer/src/markdown/BlockActionMenu.vue',
      'apps/desk/src/renderer/src/markdown/createDeskRawBlockView.ts',
      'apps/desk/src/renderer/src/markdown/deskRawBlockView/**',
      'apps/desk/src/renderer/src/markdown/slashMenu.ts',
      'apps/desk/src/renderer/src/markdown/milkdownMarkdownEditor.scoped.css',
      'packages/ui/src/styles/tokens.css'
    ],
    serial: false,
    locks: ['clipboard'],
    smoke: false,
    note: '块级交互：整块/范围选择、六点菜单、拖拽、复制剪切删除、暗色对比（体检建议拆 3：选块/拖拽菜单/剪贴板暗色）'
  },
  {
    name: 'e2e-block-menus.mjs',
    area: 'block-menu',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/blockActionMenu.ts',
      'apps/desk/src/renderer/src/markdown/BlockActionMenu.vue',
      'apps/desk/src/renderer/src/markdown/slashMenu.ts',
      'apps/desk/src/renderer/src/markdown/rawBlockInteractions.ts',
      'apps/desk/src/renderer/src/markdown/verticalBlockSelection.ts',
      'apps/desk/src/renderer/src/editor/markdown/rawBlockProjection.ts',
      'apps/desk/src/renderer/src/editor/markdown/sourcePreservation.ts'
    ],
    serial: false,
    smoke: false,
    note: '六点菜单 / 复制剪切删除 / 「在下方添加」子菜单（体检建议删掉已被单测覆盖的标题箭头段）'
  },
  {
    name: 'e2e-block-ranges.mjs',
    area: 'block-range',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/rawBlockInteractions.ts',
      'apps/desk/src/renderer/src/markdown/verticalBlockSelection.ts',
      'apps/desk/src/renderer/src/markdown/selectionKind.ts',
      'apps/desk/src/renderer/src/markdown/standaloneImageParagraph.ts',
      'apps/desk/src/renderer/src/markdown/createDeskRawBlockView.ts',
      'apps/desk/src/renderer/src/markdown/milkdownMarkdownEditor.scoped.css',
      'apps/desk/src/renderer/src/editor/markdown/rawBlockProjection.ts'
    ],
    serial: false,
    locks: ['clipboard'],
    smoke: true,
    note: '块范围选择权威用例：Shift+↑↓ 整块一步一选、真实软换行视觉行、OS 剪贴板字节'
  },
  {
    name: 'e2e-empty-break-deletion.mjs',
    area: 'block-editing',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor/markdown/rawBlockProjection.ts',
      'apps/desk/src/renderer/src/editor/markdown/sourcePreservation.ts',
      'apps/desk/src/renderer/src/markdown/readonlyGuard.ts',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue',
      'apps/desk/src/renderer/src/markdown/MarkdownSourceEditor.vue'
    ],
    serial: false,
    smoke: true,
    note: '独占一行 <br /> 映射空段落 + 点击后 Delete 语义'
  },
  {
    name: 'e2e-markdown-input.mjs',
    area: 'input',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/markdownInputRules.ts',
      'apps/desk/src/renderer/src/markdown/slashMenu.ts',
      'apps/desk/src/renderer/src/markdown/attachRawSourceEditor.ts',
      'apps/desk/src/renderer/src/markdown/deskRawBlockView/diagram.ts',
      'apps/desk/src/renderer/src/editor/markdown/deskCallout.ts',
      'apps/desk/src/renderer/src/editor/markdown/componentBody.ts',
      'apps/desk/src/renderer/src/editor/markdown/rawBlockProjection.ts',
      'apps/desk/src/renderer/src/editor/markdown/diagramRenderer.ts',
      'packages/ui/src/components/Mermaid/Mermaid.vue'
    ],
    serial: false,
    smoke: true,
    note: 'slash/输入规则：mermaid、提示块、组件、行内代码与公式的 canonical 源码'
  },
  {
    name: 'e2e-inline-break.mjs',
    area: 'input',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor/markdown/htmlBreak.ts',
      'apps/desk/src/renderer/src/editor/markdown/rawBlockProjection.ts',
      'apps/desk/src/renderer/src/editor/markdown/sourcePreservation.ts',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue'
    ],
    serial: false,
    smoke: false,
    note: '行内 <br>（段落 + 表格单元格）渲染与磁盘保真（未编辑零 diff、编辑后不丢）'
  },
  {
    name: 'e2e-block-spacing.mjs',
    area: 'spacing',
    tier: 'regression',
    // 只挂决定块级纵向间距的样式：只有改这些文件时才需要跑它，其它改动不会选中。
    globs: [
      'apps/desk/src/renderer/src/markdown/milkdownMarkdownEditor.scoped.css',
      'apps/desk/src/renderer/src/markdown/crepePort/theme/common/**'
    ],
    serial: false,
    smoke: false,
    note: '相邻顶层块不能贴合：相邻列表并成一条 / 相邻 callout 卡片连成色带（卡片看 border 间距，文字块看内容间距）'
  },
  {
    name: 'e2e-block-boundary-navigation.mjs',
    area: 'block-editing',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/blockBoundaryCaret.ts',
      'apps/desk/src/renderer/src/markdown/blockBoundaryNavigation.ts',
      'apps/desk/src/renderer/src/markdown/rawBlockInteractions.ts',
      'apps/desk/src/renderer/src/markdown/verticalBlockSelection.ts',
      'apps/desk/src/renderer/src/markdown/milkdownMarkdownEditor.scoped.css'
    ],
    serial: false,
    smoke: false,
    note: '块边界光标 + T1–T6 键盘导航：代码块/表格/只读块停靠、↓/→ 进内部与穿出、边界键位（打字/Enter/Del/Backspace）、纯导航零 diff'
  },
  {
    name: 'e2e-list-fold.mjs',
    area: 'block-editing',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/listItemCollapse.ts',
      'apps/desk/src/renderer/src/markdown/milkdownMarkdownEditor.scoped.css',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue'
    ],
    serial: false,
    smoke: false,
    note: '缩进列表折叠（语雀交互）：按钮只在有子列表的项出现 / 悬停显形 / 折叠只改视图（markdown 零 diff）/ 上下箭头跳过隐藏子树'
  },
  {
    name: 'e2e-code-exit.mjs',
    area: 'code-block',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/rawBlockInteractions.ts',
      'apps/desk/src/renderer/src/markdown/verticalBlockSelection.ts',
      'apps/desk/src/renderer/src/markdown/attachRawSourceEditor.ts',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue',
      'apps/desk/src/renderer/src/markdown/deskRawBlockView/container.ts',
      'apps/desk/src/renderer/src/editor/markdown/deskCodeTabEditor.ts',
      'apps/desk/src/renderer/src/editor/markdown/containerSourceEditor.ts',
      'packages/ui/src/components/CodeGroup/CodeGroup.vue'
    ],
    serial: false,
    smoke: false,
    note: '代码块末尾光标 → 正文导航'
  },
  {
    name: 'e2e-code-fence-input.mjs',
    area: 'input',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/markdownInputRules.ts',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue',
      'apps/desk/src/renderer/src/editor/markdown/codeBlockTitlePlugin.ts'
    ],
    serial: false,
    smoke: false,
    note: '中点代码围栏快捷键的真实输入路径（体检结论：可合并进 e2e-markdown-input，省一次启动、覆盖不减）'
  },
  {
    name: 'e2e-note-assets.mjs',
    area: 'note-assets',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor-groups/NoteAssetsPanel.vue',
      'apps/desk/src/renderer/src/editor-groups/noteAssets.ts',
      'apps/desk/src/renderer/src/editor-groups/NoteTabPane.vue',
      'apps/desk/src/main/assetOperations.ts',
      'packages/kb/src/asset-scan/**'
    ],
    serial: false,
    locks: ['clipboard'],
    smoke: false,
    note: '笔记级资源面板：引用/编号匹配/无效/缺失分组、复制路径、定位引用、插入、删除、修复编号'
  },
  {
    name: 'e2e-kb-files.mjs',
    area: 'kb-files',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor-groups/KbPathBreadcrumb.vue',
      'apps/desk/src/renderer/src/editor-groups/kbPathBreadcrumb.ts',
      'apps/desk/src/renderer/src/editor-groups/TextFileTabPane.vue',
      'apps/desk/src/renderer/src/monaco/**',
      'apps/desk/src/main/ipc/kbFiles.ts',
      'apps/desk/src/shared/contracts.ts',
      'packages/kb/src/files.ts'
    ],
    serial: false,
    smoke: false,
    note: '知识库文本入口：面包屑浏览 + 只读 Monaco 文本标签页 + 拒绝名单/二进制判定'
  },
  {
    name: 'e2e-source-unicode-highlight.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/monaco/**',
      'apps/desk/src/renderer/src/markdown/MarkdownSourceEditor.vue',
      'apps/desk/src/renderer/src/editor-groups/TextFileTabPane.vue'
    ],
    serial: false,
    smoke: false,
    note: '源码视图 Unicode 高亮：中文全角标点不再黄框，异常不可见/真混淆字符仍提示（深浅主题）'
  },
  {
    name: 'e2e-source-selection-background.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/MarkdownSourceEditor.vue',
      'apps/desk/src/renderer/src/monaco/**'
    ],
    serial: false,
    locks: ['clipboard'],
    smoke: false,
    note: '源码视图跨行选区几何：选区圆角遮罩不被写成透明（像素级前后对照 + 剪切/撤销对齐选区）'
  },
  {
    name: 'e2e-source-folding.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/sourceFolding.ts',
      'apps/desk/src/renderer/src/markdown/MarkdownSourceEditor.vue',
      'apps/desk/src/renderer/src/monaco/**',
      'apps/desk/src/renderer/src/commands/headingFoldBridge.ts',
      'apps/desk/src/renderer/src/commands/paletteCommands.ts',
      'apps/desk/src/renderer/src/editor-groups/NoteTabPane.vue'
    ],
    serial: false,
    smoke: false,
    note: '源码视图折叠：行号槽箭头折标题章节/整块代码围栏，命令面板按级别折叠且不折代码块'
  },
  {
    name: 'e2e-boundary-delete.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/blockBoundaryCaret.ts',
      'apps/desk/src/renderer/src/markdown/blockBoundaryNavigation.ts',
      'apps/desk/src/renderer/src/editor/markdown/deskCallout*'
    ],
    serial: false,
    smoke: false,
    note: '可视化块边界：特殊块后段首 Backspace / 块前段尾 Delete 先落可见光标，再按才删整块（含撤销）'
  },
  {
    name: 'e2e-mcp-selection.mjs',
    area: 'mcp',
    tier: 'regression',
    globs: [
      'apps/desk/src/main/mcp/**',
      'apps/desk/src/main/selection/**',
      'apps/desk/src/main/ipc/selection.ts',
      'apps/desk/src/renderer/src/selection/**',
      'apps/desk/src/renderer/src/markdown/MarkdownSourceEditor.vue',
      'apps/desk/src/renderer/src/editor-groups/NoteTabPane.vue'
    ],
    serial: false,
    smoke: false,
    note: '本机 MCP 选区服务：真实 SDK 客户端 initialize/list/call、鉴权、失焦、失效、令牌轮换、端口释放'
  },
  {
    name: 'e2e-mcp-visual-selection.mjs',
    area: 'mcp',
    tier: 'regression',
    // 会读系统剪贴板（验设置页「复制令牌 / 复制配置示例」真的写进去了）
    locks: ['clipboard'],
    globs: [
      'apps/desk/src/main/mcp/**',
      'apps/desk/src/main/selection/**',
      'apps/desk/src/main/ipc/selection.ts',
      'apps/desk/src/renderer/src/selection/**',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue',
      'apps/desk/src/renderer/src/markdown/MarkdownSourceEditor.vue',
      'apps/desk/src/renderer/src/editor/markdown/containerSourceEditor.ts',
      'apps/desk/src/renderer/src/editor-groups/NoteTabPane.vue',
      'apps/desk/src/renderer/src/components/settings/McpSettings.vue',
      'apps/desk/src/renderer/src/components/SettingsPanel.vue'
    ],
    serial: false,
    smoke: false,
    note: '本机 MCP 可视化选区：段落/跨段/代码块/代码组/整块组件、失焦与草稿、多分组隔离、大选区拒绝、设置界面（含端口占用）'
  },
  {
    name: 'e2e-excalidraw-copy.mjs',
    area: 'excalidraw',
    tier: 'regression',
    locks: ['clipboard'],
    globs: [
      'apps/desk/src/renderer/src/editor/markdown/canvasImageRefs.ts',
      'apps/desk/src/renderer/src/markdown/canvasImageClipboardPlugin.ts',
      'apps/desk/src/renderer/src/editor/excalidraw/canvasImage.ts',
      'apps/desk/src/main/ipc/excalidraw.ts',
      'apps/desk/src/main/workspaceManager.ts',
      'packages/kb/src/excalidraw.ts',
      'packages/kb/src/asset-scan/**'
    ],
    serial: false,
    smoke: false,
    note: '跨笔记粘贴画布图：源文件与派生 SVG 一起按目标编号复制（不共享引用）'
  },
  {
    name: 'e2e-excalidraw-e0.mjs',
    area: 'excalidraw',
    tier: 'manual',
    globs: [
      'packages/ui/src/excalidraw/**',
      'packages/ui/src/entries/excalidraw-*.ts',
      'packages/ui/e0-spike/**'
    ],
    serial: true,
    smoke: false,
    note: '试验台/基线：React 编辑器交接与首屏体积测量（非产品断言，固定端口 8124）'
  },
  {
    name: 'e2e-excalidraw-git.mjs',
    area: 'excalidraw',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor/excalidraw/canvasController.ts',
      'apps/desk/src/main/git.ts',
      'apps/desk/src/main/gitManager.ts',
      'apps/desk/src/main/workspaceManager.ts',
      'packages/kb/src/excalidraw.ts'
    ],
    serial: false,
    smoke: false,
    note: '画布每画一步只写盘、不产生 commit；笔记源码不变'
  },
  {
    name: 'e2e-git-background-fetch.mjs',
    area: 'git',
    tier: 'regression',
    globs: [
      'apps/desk/src/main/gitManager.ts',
      'apps/desk/src/main/backgroundFetchScheduler.ts',
      'apps/desk/src/main/backgroundGitFailure.ts',
      'apps/desk/src/main/settings.ts',
      'apps/desk/src/renderer/src/stores/failureNotice.ts',
      'apps/desk/src/renderer/src/components/settings/GitSettings.vue',
      'apps/desk/src/renderer/src/components/SettingsPanel.vue'
    ],
    serial: false,
    smoke: false,
    note: '后台自动抓取默认关闭、手动 fetch 可用、开关打开后抓取、多库失败聚合成一条通知、时间显示'
  },
  {
    name: 'e2e-excalidraw-inline.mjs',
    area: 'excalidraw',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/deskImageView.ts',
      'apps/desk/src/renderer/src/editor/excalidraw/**',
      'apps/desk/src/renderer/src/editor/markdown/canvasImage*.ts',
      'packages/ui/src/excalidraw/exporter.ts',
      'packages/ui/src/excalidraw/fonts.ts'
    ],
    serial: false,
    smoke: false,
    note: '笔记里的画布图：按图片处理（拖拽/描述/对齐）、「编辑」开标签页、编辑期间实时预览与「编辑中」'
  },
  {
    name: 'e2e-excalidraw-insert.mjs',
    area: 'excalidraw',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/markdownInputRules.ts',
      'apps/desk/src/renderer/src/markdown/slashMenu.ts',
      'apps/desk/src/renderer/src/editor/excalidraw/**',
      'apps/desk/src/main/ipc/excalidraw.ts',
      'packages/kb/src/excalidraw.ts'
    ],
    serial: false,
    smoke: true,
    note: '斜杠插入画布：主进程建 .excalidraw + 同名占位 .svg → 插入图片引用 → 打开标签页'
  },
  {
    name: 'e2e-excalidraw-tab.mjs',
    area: 'excalidraw',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor-groups/ExcalidrawTabPane.vue',
      'apps/desk/src/renderer/src/editor-groups/KbAssetsPane.vue',
      'apps/desk/src/renderer/src/editor-groups/kbAssetsReasons.ts',
      'apps/desk/src/renderer/src/editor/excalidraw/**',
      'apps/desk/src/renderer/src/stores/**',
      'apps/desk/src/main/ipc/excalidraw.ts',
      'apps/desk/src/main/workspaceManager.ts',
      'apps/desk/src/main/assetOperations.ts',
      'apps/desk/src/main/assetWriteGate.ts',
      'packages/kb/src/excalidraw.ts',
      'packages/kb/src/asset-scan/**'
    ],
    serial: false,
    smoke: false,
    note: '画布标签：自动写盘、失效态、资源面板保护、关标签/退出前 flush'
  },
  {
    name: 'e2e-editor-focus.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue',
      'apps/desk/src/renderer/src/markdown/milkdownMarkdownEditor.scoped.css',
      'apps/desk/src/renderer/src/markdown/editorFocusReclaim.ts',
      'apps/desk/src/renderer/src/markdown/rawBlockInteractions.ts',
      'apps/desk/src/renderer/src/editor-groups/NoteTabPane.vue',
      'apps/desk/src/renderer/src/editor-groups/FormatOverflowBar.vue'
    ],
    serial: false,
    locks: ['focus'],
    smoke: true,
    note: '死光标回归：可编辑区铺满、空白点击收回焦点、失焦不留虚拟光标（1800×1100 大窗口）'
  },
  {
    name: 'e2e-mindmap.mjs',
    area: 'mindmap',
    tier: 'manual',
    globs: [
      'apps/desk/src/renderer/src/markdown/deskRawBlockView/**',
      'apps/desk/src/renderer/src/editor/markdown/diagramRenderer.ts',
      'apps/desk/src/renderer/src/editor/markdown/componentPreview.ts',
      'packages/ui/src/components/Mindmap/**'
    ],
    serial: true,
    smoke: false,
    note: '人工观察工具：无任何断言，只启动→截图→dump 像素（固定 profile /tmp）'
  },
  {
    name: 'e2e-note-header.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor-groups/NoteTabPane.vue',
      'apps/desk/src/renderer/src/editor-groups/FormatOverflowBar.vue',
      'apps/desk/src/renderer/src/editor-groups/overflowFit.ts',
      'apps/desk/src/renderer/src/stores/workspace/**',
      'apps/desk/src/main/workspace/noteIo.ts',
      'apps/desk/src/main/ipc/notes.ts'
    ],
    serial: false,
    smoke: false,
    note: '笔记头行内几何 + 重命名同步文件名/TOC/标签（1600×1000）'
  },
  {
    name: 'e2e-numbered-tabs.mjs',
    area: 'tabs',
    tier: 'regression',
    globs: [
      'apps/desk/src/main/tabShortcuts.ts',
      'apps/desk/src/main/index.ts',
      'apps/desk/src/main/webContentsManager.ts',
      'apps/desk/src/renderer/src/App.vue',
      'apps/desk/src/renderer/src/editor-groups/layoutModel.ts',
      'apps/desk/src/renderer/src/editor-groups/EditorGroup.vue',
      'apps/desk/src/renderer/src/editor-groups/WebTabPane.vue'
    ],
    serial: false,
    locks: ['focus'],
    smoke: true,
    note: 'Cmd/Ctrl+数字切「当前分屏组」标签（原生 before-input-event，CDP 无法替代）'
  },
  {
    name: 'e2e-quit-flush.mjs',
    area: 'window',
    tier: 'regression',
    globs: [
      'apps/desk/src/main/closeGuard.ts',
      'apps/desk/src/main/closeGuards.ts',
      'apps/desk/src/main/index.ts',
      'apps/desk/src/renderer/src/App.vue',
      'apps/desk/src/renderer/src/stores/workspace/**'
    ],
    serial: false,
    smoke: true,
    note: '关窗/退出前先 flush 未保存内容（会真的退出应用）'
  },
  {
    name: 'e2e-tab-drag.mjs',
    area: 'tabs',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor-groups/tabDrag.ts',
      'apps/desk/src/renderer/src/editor-groups/EditorGroup.vue',
      'apps/desk/src/renderer/src/editor-groups/layoutModel.ts'
    ],
    serial: false,
    locks: ['focus'],
    smoke: true,
    note: '标签真实拖拽：半区预览、拆分搬原标签、跨组合并'
  },
  {
    name: 'e2e-typography.mjs',
    area: 'typography',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/assets/fonts.css',
      'apps/desk/src/renderer/src/assets/fonts/inter/**',
      'packages/ui/src/styles/**',
      'apps/desk/src/renderer/src/markdown/milkdownMarkdownEditor.scoped.css',
      'packages/ui/src/components/Mermaid/**'
    ],
    serial: false,
    smoke: true,
    note: 'Inter 子集离线加载 + 标题/正文/callout 排印与主题色（真实字形）'
  },
  {
    name: 'e2e-fidelity.mjs',
    area: 'fidelity',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/editor/markdown/projectionFidelity.ts',
      'apps/desk/src/renderer/src/editor/markdown/projectionFidelity.cases.ts',
      'apps/desk/src/renderer/src/editor/markdown/rawBlockProjection.ts',
      'apps/desk/src/renderer/src/editor/markdown/sourcePreservation.ts',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue',
      'apps/desk/src/renderer/src/markdown/createDeskRawBlockView.ts',
      'apps/desk/src/renderer/src/markdown/milkdownMarkdownEditor.scoped.css'
    ],
    serial: false,
    smoke: false,
    note: '渲染忠实性：结构性不忠实的区域降级为「按原文显示」，无关内容照常渲染，切视图不改磁盘'
  },
  {
    name: 'e2e-selection-toolbar.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/main/settings.ts',
      'apps/desk/src/shared/contracts.ts',
      'apps/desk/src/renderer/src/markdown/deskEditor.ts',
      'apps/desk/src/renderer/src/markdown/crepePort/toolbar/**',
      'apps/desk/src/renderer/src/markdown/MilkdownMarkdownEditor.vue',
      'apps/desk/src/renderer/src/components/SettingsPanel.vue',
      'apps/desk/src/renderer/src/components/settings/EditorSettings.vue'
    ],
    serial: false,
    smoke: false,
    note: '选区浮动工具条开关：默认关闭不弹且不拦截指针事件、设置面板可开、重启后保持、改回关闭后不再出现'
  },
  {
    name: 'e2e-background-failure-visibility.mjs',
    area: 'git',
    tier: 'regression',
    globs: [
      'apps/desk/src/main/backgroundFailureLog.ts',
      'apps/desk/src/main/backgroundGitFailure.ts',
      'apps/desk/src/main/ipc/commandTask.ts',
      'apps/desk/src/renderer/src/components/settings/GitSettings.vue',
      'apps/desk/src/renderer/src/stores/backgroundFailure.ts'
    ],
    serial: false,
    smoke: false,
    note: '面板容量满额时后台失败仍可见：不占标签、设置里有汇总与真实错误详情、同原因只累加计数'
  },
  {
    name: 'e2e-image-copy-plain-text.mjs',
    area: 'editor',
    tier: 'regression',
    globs: [
      'apps/desk/src/renderer/src/markdown/imageCopyText.ts',
      'apps/desk/src/renderer/src/markdown/clipboardNewline.ts',
      'apps/desk/src/main/ipc/clipboard.ts',
      'apps/desk/src/renderer/src/editor/markdown/deskImageView.ts'
    ],
    serial: false,
    locks: ['clipboard'],
    smoke: false,
    note: '复制图片时系统剪贴板 text/plain 必须是 alt：单张/无 alt/图文混选/多图/粘回 Desk 全覆盖'
  },
  {
    name: 'e2e-packaged-smoke.mjs',
    area: 'packaged',
    tier: 'manual',
    globs: ['apps/desk/electron-builder.cjs', 'apps/desk/src/main/**', 'apps/desk/src/preload/**'],
    serial: true,
    smoke: false,
    note: '打包产物冒烟：.app 里编辑器可用 + 站点预览真能出页面（验 asar 关闭与平台二进制裁剪）'
  }
]
