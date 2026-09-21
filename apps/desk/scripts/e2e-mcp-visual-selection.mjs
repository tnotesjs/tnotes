// 本机 MCP 选区上下文服务：**可视化视图 + 快照生命周期**验收（阶段 B）。
//
// 全程走真实 MCP 协议链路（官方 SDK 客户端 → 本机 Streamable HTTP 服务 → 主进程快照），
// 断言的是"外部 Agent 实际读到的东西"，不是内部函数：
//   - 可视化视图：段落内 / 跨段落 / 普通代码块内 / 代码组面板内 / 整块特殊组件（NodeSelection）；
//   - 内容来源与版本（contentSource / revision / mapping）；
//   - 失焦后 DOM 选区变化不算取消；非正文输入不冒充正文选区；
//   - 多个编辑器分组：只有活动编辑器能更新，后台分组不能覆盖；
//   - 大选区可控失败（context_too_large，不静默截断）；
//   - 设置界面：开关 / 地址 / 状态 / 令牌 / 配置示例，端口占用明确报错、不偷偷换端口。
//
// Run: node apps/desk/scripts/e2e-mcp-visual-selection.mjs
import assert from 'node:assert/strict'

import { createServer as createHttpServer } from 'node:http'
import { readFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createFixture, createRecorder, launchDesk, openNote, waitFor } from './e2e-lib.mjs'

const rec = createRecorder()
const TOOL = 'get_current_selection'
const PORT = 39500 + Math.floor(Math.random() * 400)
/** 故意被占用的端口：验证"明确报错、不偷偷换端口" */
const BUSY_PORT = PORT + 500

const body = [
  '# 视觉选区', // 1
  '', // 2
  '第一段句子甲。', // 3
  '', // 4
  '第二段句子乙，用于跨段落选择。', // 5
  '', // 6
  '```js', // 7
  'const plain = 1', // 8
  '```', // 9
  '', // 10
  '::: code-group', // 11
  '', // 12
  '```js [a.js]', // 13
  'groupA = 1', // 14
  '```', // 15
  '', // 16
  '```ts [b.ts]', // 17
  'groupB = 2', // 18
  '```', // 19
  '', // 20
  ':::', // 21
  '', // 22
  '```mindmap', // 23
  '- 前端', // 24
  '- 后端', // 25
  '```', // 26
  '', // 27
  '最后一段。', // 28
  ''
].join('\n')

/**
 * 巨块笔记：**一整段** 65k 字符（单行、没有空行）。
 * 在里面只选两个字符时，选字远小于 20k，但"相关块 Markdown"超过 60k —— 专门验块内容上限。
 */
const giantBlockBody = `# 巨块\n\n${'长'.repeat(65_000)}\n`

/** 超长笔记：单块、约 25.5k 字符（超过 20k 的选字上限） */
const longBody = `# 超长\n\n${Array.from({ length: 3 }, () => '长'.repeat(8500)).join('\n')}\n`

const fixture = createFixture('mcp-visual', {
  notes: [
    { index: '0001', title: '视觉选区', body },
    { index: '0002', title: '另一篇', body: '# 另一篇\n\n别的正文。\n' },
    { index: '0003', title: '超长', body: longBody },
    { index: '0004', title: '巨块', body: giantBlockBody }
  ]
})
fixture.writeProfileConfig({ mcp: { enabled: true, port: PORT } })
const noteFile = fixture.notePath('0001', '视觉选区')
const noteBytesBefore = readFileSync(noteFile, 'utf8')

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error?.stack ?? String(error)))

const settle = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )

const mcpStatus = async () =>
  page.evaluate(async () => {
    const result = await window.desk.mcp.status()
    return result.ok ? result.value : { error: result.error.message }
  })

const connect = async (token) => {
  const client = new Client({ name: 'desk-e2e-visual', version: '0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  return client
}

const readSelection = async (client) => {
  const result = await client.callTool({ name: TOOL, arguments: {} })
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '{}'
  return JSON.parse(text)
}

/** 等一个新的 ok 快照（可选谓词），避免读到上一步的旧快照 */
const waitOk = (client, predicate = () => true) =>
  waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'ok' && predicate(value) ? value : null
  }, 10000)

/** 在某个编辑器分组里选普通文本（可视化视图：DOM 选区 → ProseMirror 状态） */
const selectInParagraph = async (scope, hasText, from = 0, to = null) => {
  const paragraph = scope.locator('p', { hasText }).first()
  await paragraph.scrollIntoViewIfNeeded()
  await paragraph.click()
  await paragraph.evaluate(
    (element, [start, end]) => {
      const node = element.firstChild
      const text = node?.textContent ?? ''
      window.getSelection()?.setBaseAndExtent(node, start, node, end == null ? text.length : end)
    },
    [from, to]
  )
  await settle()
}

/**
 * 在 CodeMirror（代码块 / 代码组面板）里选中一整行。
 *
 * 用键盘而不是设 DOM 选区：CM 会把一行拆成多个 token span，按文本节点下标设置
 * 选区很容易越界；Home / Shift+End 由 CM 自己的键盘映射处理，语义稳定。
 */
const selectInCodeMirror = async (container, lineText) => {
  const line = container.locator('.cm-line', { hasText: lineText }).first()
  await line.waitFor({ timeout: 10000 })
  await line.click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await settle()
}

const groups = page.locator('.editor-group')

try {
  await openNote(page, { kbName: fixture.kbName, title: '视觉选区' })
  await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)

  const status = await waitFor(async () => {
    const value = await mcpStatus()
    return value.running ? value : null
  }, 20000)
  assert.ok(status?.url, `本机 MCP 未启动：${JSON.stringify(status)}`)
  const token = status.token
  const client = await connect(token)

  /* ── 可视化视图：段落内选择 ── */
  await selectInParagraph(groups.first(), '第一段句子甲。')
  const paragraphSnapshot = await waitOk(client, (value) => value.selection?.selectedText)
  rec.record(
    '可视化视图段落内选择：给出选中文本 + 块级上下文',
    paragraphSnapshot?.selection?.selectedText === '第一段句子甲。' &&
      paragraphSnapshot?.selection?.mapping === 'block' &&
      paragraphSnapshot?.editor?.viewMode === 'visual' &&
      paragraphSnapshot?.editor?.collector === 'visual',
    `text=${JSON.stringify(paragraphSnapshot?.selection?.selectedText)} mapping=${paragraphSnapshot?.selection?.mapping} collector=${paragraphSnapshot?.editor?.collector}`
  )
  rec.record(
    '相关块只含涉及的块（不含整篇笔记 / 其它段落）',
    paragraphSnapshot?.selection?.blocks?.length === 1 &&
      paragraphSnapshot.selection.blocks[0].kind === 'paragraph' &&
      paragraphSnapshot.selection.blocks[0].markdown.includes('第一段句子甲。') &&
      paragraphSnapshot.selection.blocks.every((block) => !block.markdown.includes('最后一段。')),
    `blocks=${JSON.stringify(paragraphSnapshot?.selection?.blocks)}`
  )
  rec.record(
    '可视化视图的块标注为重新序列化（不是逐字原文）',
    paragraphSnapshot?.selection?.blocks?.[0]?.source === 'reserialized',
    `source=${paragraphSnapshot?.selection?.blocks?.[0]?.source}`
  )

  /* ── 可视化视图：跨段落选择 ── */
  await page.evaluate(
    ([fromText, toText]) => {
      const paragraphs = [...document.querySelectorAll('.milkdown .ProseMirror p')]
      const from = paragraphs.find((item) => item.textContent?.includes(fromText))
      const to = paragraphs.find((item) => item.textContent?.includes(toText))
      const fromNode = from?.firstChild
      const toNode = to?.firstChild
      if (!fromNode || !toNode) throw new Error('找不到用于跨段选择的段落')
      window
        .getSelection()
        ?.setBaseAndExtent(fromNode, 0, toNode, (toNode.textContent ?? '').length)
    },
    ['第一段句子甲。', '第二段句子乙']
  )
  await settle()
  const crossSnapshot = await waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'ok' && value.selection?.selectedText?.includes('第二段') ? value : null
  }, 10000)
  rec.record(
    '跨段落选择：文本准确（按块换行连接）且两块都在上下文里',
    crossSnapshot?.selection?.selectedText === '第一段句子甲。\n第二段句子乙，用于跨段落选择。' &&
      (crossSnapshot?.selection?.blocks?.length ?? 0) >= 2 &&
      crossSnapshot.selection.blocks
        .map((block) => block.markdown)
        .join('\n')
        .includes('第二段句子乙，用于跨段落选择。'),
    `text=${JSON.stringify(crossSnapshot?.selection?.selectedText)} blocks=${crossSnapshot?.selection?.blocks?.length}`
  )

  /* ── 非正文输入不冒充正文选区（搜索框里全选） ── */
  const beforeSearch = await readSelection(client)
  const search = page.locator('input[type="search"][placeholder="搜索标题和正文"]').first()
  await search.click()
  await search.fill('第一段')
  await page.keyboard.press('Meta+a')
  await page.waitForTimeout(500)
  const duringSearch = await readSelection(client)
  rec.record(
    '搜索框等非正文输入被选中时，不冒充正文选区（快照不变）',
    duringSearch.status === beforeSearch.status &&
      duringSearch.snapshotId === beforeSearch.snapshotId &&
      duringSearch.selection?.selectedText === beforeSearch.selection?.selectedText,
    `before=${beforeSearch.snapshotId} during=${duringSearch.snapshotId}`
  )
  await search.fill('')
  await page.waitForTimeout(300)

  /* ── 普通代码块内部选择 ── */
  const codeBlock = page.locator('.milkdown-code-block').first()
  await selectInCodeMirror(codeBlock, 'const plain = 1')
  const codeSnapshot = await waitOk(
    client,
    (value) => value.selection?.selectedText === 'const plain = 1'
  )
  rec.record(
    '普通代码块内选择：文本精确、块级上下文带上该代码块',
    codeSnapshot?.selection?.selectedText === 'const plain = 1' &&
      (codeSnapshot?.selection?.blocks?.[0]?.kind ?? '').includes('code') &&
      (codeSnapshot?.selection?.blocks?.[0]?.markdown ?? '').includes('const plain = 1'),
    `text=${JSON.stringify(codeSnapshot?.selection?.selectedText)} kind=${codeSnapshot?.selection?.blocks?.[0]?.kind}`
  )

  /* ── 代码组面板内选择（活动面板） ── */
  const codeGroup = page.locator('.desk-raw-block--code-group-editable, .code-group').first()
  await codeGroup.locator('.code-group-tab').first().click()
  await page.waitForTimeout(300)
  await selectInCodeMirror(codeGroup, 'groupA = 1')
  const groupSnapshot = await waitOk(
    client,
    (value) => value.selection?.selectedText === 'groupA = 1'
  )
  const groupBlock = groupSnapshot?.selection?.blocks?.[0]
  rec.record(
    '代码组面板内选择：给出可识别类型与完整组件源码（逐字原文）',
    groupSnapshot?.selection?.selectedText === 'groupA = 1' &&
      groupBlock?.kind === 'raw-block:code-group' &&
      groupBlock?.source === 'raw' &&
      groupBlock.markdown.includes('groupA = 1') &&
      groupBlock.markdown.includes('groupB = 2'),
    `kind=${groupBlock?.kind} source=${groupBlock?.source} text=${JSON.stringify(groupSnapshot?.selection?.selectedText)}`
  )

  /* ── 整块特殊组件（NodeSelection）：思维导图 ── */
  await page
    .locator('.editor-group.active p', { hasText: '最后一段。' })
    .first()
    .scrollIntoViewIfNeeded()
  await page.waitForTimeout(800)
  const mindmap = page.locator('.desk-diagram__mindmap, .mindmap-preview').first()
  await mindmap.waitFor({ timeout: 20000 })
  const mindmapBox = await mindmap.boundingBox()
  // 点画布中部（避开顶部工具栏/标签），让可视化块进入整块选中态
  await page.mouse.click(
    (mindmapBox?.x ?? 0) + (mindmapBox?.width ?? 100) / 2,
    (mindmapBox?.y ?? 0) + (mindmapBox?.height ?? 100) * 0.7
  )
  await page.waitForTimeout(800)
  const mindmapSnapshot = await waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'ok' &&
      (value.selection?.blocks?.[0]?.markdown ?? '').includes('```mindmap')
      ? value
      : null
  }, 10000)
  const mindmapBlock = mindmapSnapshot?.selection?.blocks?.[0]
  rec.record(
    '整块特殊组件选中：给出类型 + 完整组件源码（不编造坐标）',
    mindmapBlock?.kind === 'raw-block:mindmap' &&
      mindmapBlock?.source === 'raw' &&
      mindmapBlock.markdown.startsWith('```mindmap') &&
      mindmapBlock.markdown.includes('- 前端') &&
      mindmapSnapshot?.selection?.mapping === 'block' &&
      mindmapSnapshot?.selection?.sourceRange === undefined,
    `kind=${mindmapBlock?.kind} mapping=${mindmapSnapshot?.selection?.mapping} markdown=${JSON.stringify(mindmapBlock?.markdown?.slice(0, 24))}`
  )

  /* ── 失焦后 DOM 选区变化不算"取消选区" ── */
  await selectInParagraph(groups.first(), '第一段句子甲。')
  const beforeBlur = await waitOk(
    client,
    (value) => value.selection?.selectedText === '第一段句子甲。'
  )
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].blur()
  })
  // 失焦后直接把 DOM 选区清掉：这不是用户取消选区（编辑器状态没变）
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.waitForTimeout(500)
  const afterBlur = await readSelection(client)
  rec.record(
    'Desk 失焦后 DOM 选区被清掉，也不会被当成取消选区（快照保持）',
    afterBlur.status === 'ok' &&
      afterBlur.snapshotId === beforeBlur?.snapshotId &&
      afterBlur.selection?.selectedText === '第一段句子甲。',
    `status=${afterBlur.status} same=${afterBlur.snapshotId === beforeBlur?.snapshotId}`
  )
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].focus()
  })

  /* ── 未保存草稿：contentSource=draft ── */
  await selectInParagraph(groups.first(), '最后一段。')
  await page.keyboard.press('Meta+ArrowRight')
  await page.keyboard.type('X')
  await page.waitForTimeout(400)
  await selectInParagraph(groups.first(), '第一段句子甲。')
  const draftSnapshot = await waitOk(client, (value) => value.editor?.contentSource === 'draft')
  rec.record(
    '未保存草稿标明 contentSource=draft / hasUnsavedChanges=true',
    draftSnapshot?.editor?.contentSource === 'draft' &&
      draftSnapshot?.editor?.hasUnsavedChanges === true &&
      typeof draftSnapshot?.editor?.revision === 'string' &&
      draftSnapshot.editor.revision.length > 0,
    `source=${draftSnapshot?.editor?.contentSource} revision=${draftSnapshot?.editor?.revision}`
  )
  await page.keyboard.press('Meta+z') // 尽力还原；后续断言不依赖它
  await page.waitForTimeout(300)

  /* ── 相关块内容超限：选字很小，但相关块 Markdown 超过 60k ── */
  await page.locator('.toc-row', { hasText: '巨块' }).first().click()
  const giantPane = page.locator('.editor-group.active .ProseMirror:visible').first()
  await waitFor(async () => {
    if ((await giantPane.count()) === 0) return false
    return (await giantPane.textContent())?.includes('长长长长长') ?? false
  }, 30000)
  // 只在巨块段落里选 2 个字符：选字远小于 20k，但相关块 Markdown 超过 60k
  await selectInParagraph(
    page.locator('.editor-group.active .ProseMirror:visible', { hasText: '长长长长长' }).first(),
    '长长长长长',
    0,
    2
  )
  const blockLimit = await waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'context_too_large' && String(value.message).includes('相关块内容过长')
      ? value
      : null
  }, 15000)
  rec.record(
    '相关块内容超限（>60k）明确失效，不返回旧正文（IPC 边界没有被 schema 提前拒收）',
    blockLimit?.status === 'context_too_large' &&
      blockLimit.selection === undefined &&
      blockLimit.snapshotId === null &&
      String(blockLimit.message).includes('上限'),
    `status=${blockLimit?.status} message=${blockLimit?.message}`
  )

  // 缩到正常范围（换到小笔记里选一段）→ 恢复 ok
  await page.locator('.toc-row', { hasText: '视觉选区' }).first().click()
  await page.waitForTimeout(900)
  await selectInParagraph(
    page.locator('.editor-group.active .ProseMirror:visible', { hasText: '第二段句子乙' }).first(),
    '第二段句子乙，用于跨段落选择。'
  )
  const recoveredAfterBlockLimit = await waitOk(
    client,
    (value) => value.selection?.selectedText === '第二段句子乙，用于跨段落选择。'
  )
  rec.record(
    '缩小到正常选区后恢复 ok（超限状态不残留）',
    recoveredAfterBlockLimit?.status === 'ok' &&
      recoveredAfterBlockLimit?.selection?.selectedText === '第二段句子乙，用于跨段落选择。',
    `status=${recoveredAfterBlockLimit?.status}`
  )

  /* ── 多个编辑器分组：只有活动编辑器能更新 ── */
  await page.getByRole('button', { name: '向右拆分当前标签' }).click()
  await waitFor(async () => (await groups.count()) === 2, 10000)
  /** 布局快照：DOM 顺序不保证，一律用 `.active` 实时判断（失败时也便于诊断） */
  const layout = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.editor-group')].map((group, index) => ({
        index,
        active: group.classList.contains('active'),
        panes: [...group.querySelectorAll('.ProseMirror')].map((pane) =>
          (pane.textContent ?? '').slice(0, 20)
        )
      }))
    )
  const split = await layout()
  rec.record(
    '拆分出两个编辑器分组（一个活动、一个后台）',
    split.length === 2 && split.filter((entry) => entry.active).length === 1,
    JSON.stringify(split)
  )

  // 活动分组里打开另一篇：快照换成它的身份与文本
  await page.locator('.editor-group.active .ProseMirror:visible').first().click()
  await page.locator('.toc-row', { hasText: '另一篇' }).first().click()
  await page.waitForTimeout(800)
  await selectInParagraph(
    page.locator('.editor-group.active .ProseMirror:visible', { hasText: '别的正文。' }).first(),
    '别的正文。'
  )
  const otherSnapshot = await waitOk(
    client,
    (value) => value.note?.title === '另一篇' && value.selection?.selectedText === '别的正文。'
  )
  rec.record(
    '活动分组里换笔记：快照身份与文本都跟着活动编辑器（不夹带另一篇以外的内容）',
    otherSnapshot?.note?.title === '另一篇' &&
      otherSnapshot?.note?.absolutePath.endsWith('0002. 另一篇.md') &&
      otherSnapshot?.selection?.selectedText === '别的正文。',
    `note=${otherSnapshot?.note?.title} path=${otherSnapshot?.note?.absolutePath} text=${JSON.stringify(otherSnapshot?.selection?.selectedText)}`
  )

  // 切到另一个分组（它显示的是 0001）：快照换成那个分组的笔记与选区
  await page.locator('.editor-group:not(.active) .ProseMirror:visible').first().click()
  await selectInParagraph(
    page.locator('.editor-group.active .ProseMirror:visible', { hasText: '最后一段。' }).first(),
    '最后一段。'
  )
  const switched = await waitOk(
    client,
    (value) => value.note?.title === '视觉选区' && value.selection?.selectedText === '最后一段。'
  )
  rec.record(
    '切到另一个分组后，快照换成那个分组的笔记与选区（不跨分组混用身份与文本）',
    switched?.note?.title === '视觉选区' &&
      switched?.note?.absolutePath.endsWith('0001. 视觉选区.md') &&
      switched?.selection?.selectedText === '最后一段。',
    `note=${switched?.note?.title} text=${JSON.stringify(switched?.selection?.selectedText)}`
  )

  // 再切回原来的分组：点它的标签栏（不点正文，编辑器里的选区还在），
  // 新活动编辑器应当重新采集自己的选区（旧分组的失效不许抹掉新采集）
  const otherTab = page.locator('.editor-group:not(.active) .tab', { hasText: '另一篇' }).first()
  if ((await otherTab.count()) > 0) {
    await otherTab.click()
  } else {
    await page.locator('.editor-group:not(.active) .ProseMirror:visible').first().click()
    await selectInParagraph(
      page.locator('.editor-group.active .ProseMirror:visible', { hasText: '别的正文。' }).first(),
      '别的正文。'
    )
  }
  const restored = await waitOk(client, (value) => value.note?.title === '另一篇')
  rec.record(
    '切回原分组后，活动编辑器重新采集自己的选区（快照回到它）',
    restored?.note?.title === '另一篇' && restored?.selection?.selectedText === '别的正文。',
    `note=${restored?.note?.title} text=${JSON.stringify(restored?.selection?.selectedText)}`
  )

  /* ── 大选区：可控失败（context_too_large，不静默截断） ── */
  await page.locator('.editor-group.active .ProseMirror:visible').first().click()
  await page.locator('.toc-row', { hasText: '超长' }).first().click()
  await page.waitForTimeout(1000)
  // 在可视化视图里全选整篇（25k+ 字符）→ 请求的选区超过上限
  await page.locator('.editor-group.active .ProseMirror:visible').first().click()
  await page.keyboard.press('Meta+a')
  await page.waitForTimeout(500)
  const tooLarge = await waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'context_too_large' ? value : null
  }, 10000)
  rec.record(
    '大选区明确拒绝（context_too_large + 原因），不截断、不回退成上一次的选区',
    tooLarge?.status === 'context_too_large' &&
      tooLarge.selection === undefined &&
      tooLarge.snapshotId === null &&
      tooLarge.message.includes('上限') &&
      tooLarge.limits?.maxSelectedChars === 20000,
    `status=${tooLarge?.status} message=${tooLarge?.message}`
  )
  // 取消选择后回到 no_selection（不会卡在 too_large）
  await page.keyboard.press('ArrowRight')
  const afterCancelLarge = await waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'no_selection' ? value : null
  }, 8000)
  rec.record(
    '大选区之后取消选择 → 回到 no_selection（状态不残留）',
    afterCancelLarge?.status === 'no_selection',
    `status=${afterCancelLarge?.status}`
  )

  /* ── 关闭笔记标签 → 旧快照失效（不泄露已关闭笔记的内容） ── */
  // 换成小笔记，选一段有效选区，再关掉这个标签
  await page.locator('.toc-row', { hasText: '视觉选区' }).first().click()
  await page.waitForTimeout(900)
  await selectInParagraph(
    page
      .locator('.editor-group.active .ProseMirror:visible', { hasText: '第一段句子甲。' })
      .first(),
    '第一段句子甲。'
  )
  const beforeClose = await waitOk(
    client,
    (value) => value.selection?.selectedText === '第一段句子甲。'
  )
  await page.locator('.editor-group.active .tab.selected .tab-close').first().click()
  const afterClose = await waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'selection_invalidated' ? value : null
  }, 10000)
  rec.record(
    '关闭笔记标签后旧快照失效（selection_invalidated）',
    afterClose?.status === 'selection_invalidated' &&
      afterClose.selection === undefined &&
      Boolean(beforeClose?.snapshotId),
    `before=${beforeClose?.status} after=${afterClose?.status}`
  )

  /* ── 只读：工具调用前后磁盘字节不变 ── */
  rec.record(
    '只读：全程工具调用没有改动磁盘文件',
    readFileSync(noteFile, 'utf8') === noteBytesBefore,
    `bytes=${Buffer.byteLength(readFileSync(noteFile, 'utf8'))}`
  )

  /* ── 设置界面：开关 / 地址 / 状态 / 令牌 / 配置示例 ── */
  await page.getByRole('button', { name: '打开设置' }).click()
  await page.locator('.settings-nav .nav-item', { hasText: '本机 MCP' }).first().click()
  await page.waitForTimeout(400)
  const endpoint = page.getByTestId('mcp-endpoint')
  const state = page.getByTestId('mcp-state')
  const tokenInput = page.getByTestId('mcp-token')
  rec.record(
    '设置里展示实际地址与运行状态',
    (await endpoint.inputValue()) === `http://127.0.0.1:${PORT}/mcp` &&
      (await state.inputValue()) === '运行中',
    `url=${await endpoint.inputValue()} state=${await state.inputValue()}`
  )
  rec.record(
    '设置里展示当前令牌（可复制，不放 URL）',
    (await tokenInput.inputValue()) === token && !(await endpoint.inputValue()).includes(token),
    `tokenLen=${(await tokenInput.inputValue()).length}`
  )
  await page.locator('.mcp-example summary').click()
  await page.waitForTimeout(200)
  const configText = await page.getByTestId('mcp-config').innerText()
  rec.record(
    '提供客户端配置示例（Streamable HTTP + Bearer 头）与"先调用工具"约定',
    configText.includes('streamable-http') &&
      configText.includes(`http://127.0.0.1:${PORT}/mcp`) &&
      configText.includes('Bearer') &&
      (await page.locator('.mcp-example').innerText()).includes('get_current_selection'),
    configText.slice(0, 80).replace(/\n/g, ' ')
  )

  /* ── 设置界面：关闭 → 端口释放；再打开 → 恢复 ── */
  await page.getByTestId('mcp-enabled').click()
  const disabled = await waitFor(async () => {
    const value = await mcpStatus()
    return value.running === false ? value : null
  }, 10000)
  const released = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST' }).then(
    () => 'still-open',
    () => 'released'
  )
  rec.record(
    '关闭开关后服务停止、端口释放',
    disabled?.running === false && released === 'released',
    `running=${disabled?.running} port=${released}`
  )

  await page.getByTestId('mcp-enabled').click()
  const reenabled = await waitFor(async () => {
    const value = await mcpStatus()
    return value.running ? value : null
  }, 10000)
  rec.record(
    '重新打开开关后按同一地址恢复监听',
    reenabled?.url === `http://127.0.0.1:${PORT}/mcp`,
    `url=${reenabled?.url}`
  )

  /* ── 端口占用：明确报错，不偷偷换端口 ── */
  const busy = createHttpServer((_request, response) => response.end('busy'))
  await new Promise((resolve) => busy.listen(BUSY_PORT, '127.0.0.1', resolve))
  const portInput = page.getByTestId('mcp-port')
  await portInput.fill(String(BUSY_PORT))
  const conflicted = await waitFor(async () => {
    const value = await mcpStatus()
    return value.error ? value : null
  }, 10000)
  rec.record(
    '端口被占用时明确报错（不静默换端口）',
    typeof conflicted?.error === 'string' &&
      conflicted.error.includes('端口') &&
      conflicted.error.includes(String(BUSY_PORT)) &&
      conflicted.running === false &&
      (await state.inputValue()) === '启动失败',
    `error=${conflicted?.error} state=${await state.inputValue()}`
  )
  // 改回原端口 → 恢复监听；端口占用方的地址也没被顶掉
  await portInput.fill(String(PORT))
  const recovered = await waitFor(async () => {
    const value = await mcpStatus()
    return value.running ? value : null
  }, 10000)
  const busyAlive = await fetch(`http://127.0.0.1:${BUSY_PORT}/`).then(
    (response) => response.text(),
    () => 'dead'
  )
  rec.record(
    '换回可用端口后恢复；被占用的端口没有被顶掉',
    recovered?.url === `http://127.0.0.1:${PORT}/mcp` && busyAlive === 'busy',
    `url=${recovered?.url} busy=${busyAlive}`
  )
  await new Promise((resolve) => busy.close(resolve))

  if (pageErrors.length > 0) console.log('PAGE ERRORS:\n' + pageErrors.join('\n---\n'))
  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
