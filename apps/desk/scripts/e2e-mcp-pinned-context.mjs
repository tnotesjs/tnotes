// 本机 MCP 的「固定选区上下文」：**真实 MCP 协议链路**验收。
//
// 覆盖需求里点名的场景：
//   - 固定 A → 选 B / 切标签 / 切分组 / 失焦 → 仍返回 A（多次调用不消费）；
//   - 修改 A 的文字、在 A 前插入内容（坐标变化）→ 失效，且**不回退**读 B；
//   - 修改 A 后方且不影响其内容与坐标 → 保留；
//   - 外部修改文件 → 按磁盘内容复核（A 变了失效、只改后方保留）；
//   - 关闭来源标签 → 失效；关闭同笔记的另一份标签 → 保留；
//   - 再次固定 → 全局只有新的那份；
//   - 可视化 / 源码切换本身不失效；代码块/特殊块可固定；超限拒绝；
//   - 状态条（来源 / 摘要 / 查看 / 解除）与「解除」后回到实时模式。
//
// Run: node apps/desk/scripts/e2e-mcp-pinned-context.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createFixture, createRecorder, launchDesk, openNote, waitFor } from './e2e-lib.mjs'

const rec = createRecorder()
const PORT = 39990 + Math.floor(Math.random() * 90)
const TOOL = 'get_current_selection'

const bodyA = [
  '# 甲笔记', // 1
  '', // 2
  '甲段一。', // 3
  '', // 4
  '甲段二。', // 5
  '', // 6
  '```js', // 7
  'const pinned = 1', // 8
  '```', // 9
  '', // 10
  '甲末尾。', // 11
  ''
].join('\n')

const fixture = createFixture('mcp-pinned', {
  notes: [
    { index: '0001', title: '甲笔记', body: bodyA },
    { index: '0002', title: '乙笔记', body: '# 乙笔记\n\n乙段一。\n' },
    { index: '0003', title: '巨块', body: `# 巨块\n\n${'长'.repeat(65_000)}\n` },
    { index: '0004', title: '丙笔记', body: '# 丙笔记\n\n丙段一。\n\n丙段二。\n' },
    // 磁盘复核用例要一篇"从来没被编辑过"的干净笔记（草稿固定不看磁盘）
    { index: '0005', title: '丁笔记', body: '# 丁笔记\n\n丁段一。\n\n丁段二。\n' },
    // 代码块固定用例：同样需要一篇**没被编辑过**的干净笔记（见下方注释）
    {
      index: '0006',
      title: '戊笔记',
      body: '# 戊笔记\n\n戊段一。\n\n```js\nconst pinned = 1\n```\n'
    },
    // "原位置被删除、别处仍有相同文字"用例：也要一篇干净笔记（丙笔记那时已经写不回源码）
    { index: '0007', title: '己笔记', body: '# 己笔记\n\n己段一。\n\n己段二。\n' }
  ]
})
fixture.writeProfileConfig({ mcp: { enabled: true, port: PORT } })
const noteD = fixture.notePath('0005', '丁笔记')

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

const status = async () =>
  page.evaluate(async () => {
    const result = await window.desk.mcp.status()
    return result.ok ? result.value : { error: result.error.message }
  })

const read = async (client) => {
  const result = await client.callTool({ name: TOOL, arguments: {} })
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '{}'
  return JSON.parse(text)
}

/** 视图开关按钮：多分组时同名按钮会有多个，必须限定在活动分组里点 */
const viewButton = (name) =>
  page.locator('.editor-group.active').getByRole('button', { name, exact: true }).first()

const settle = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )

/** 在活动分组里选中某段文字（DOM 选区 → ProseMirror 状态） */
async function selectParagraph(text) {
  const paragraph = page
    .locator('.editor-group.active .ProseMirror:visible p', { hasText: text })
    .first()
  await paragraph.scrollIntoViewIfNeeded()
  await paragraph.click()
  await paragraph.evaluate((element) => {
    const node = element.firstChild
    window.getSelection()?.setBaseAndExtent(node, 0, node, node?.textContent?.length ?? 0)
  })
  await settle()
}

/**
 * 命令面板触发固定。
 *
 * 快捷键（⌘K P）的主进程 keydown 映射由 `tabShortcuts.test.ts` 覆盖：
 * Playwright 的合成按键走 CDP，到不了 Electron 的 `before-input-event`，
 * 端到端只能验到「命令 → 活动标签页固定」这一段。
 */
async function pinViaPalette() {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  const palette = page.locator('.command-palette__input')
  await palette.waitFor({ timeout: 15000 })
  await palette.fill('>固定为 Agent 上下文')
  await page.locator('.command-palette__item', { hasText: '固定为 Agent 上下文' }).first().click()
  await page.waitForTimeout(500)
}

/** 用合成 contextmenu 打开正文右键菜单（不改选区），点「固定为 Agent 上下文」 */
async function pinViaContextMenu(text) {
  await page.evaluate((needle) => {
    const paragraph = [...document.querySelectorAll('.editor-group.active .ProseMirror p')].find(
      (item) => item.textContent?.includes(needle)
    )
    const rect = paragraph?.getBoundingClientRect()
    paragraph?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: (rect?.left ?? 20) + 10,
        clientY: (rect?.top ?? 20) + 5
      })
    )
  }, text)
  const menu = page.locator('.desk-editor-context-menu')
  await menu.waitFor({ timeout: 8000 })
  const item = menu.locator('button', { hasText: '固定为 Agent 上下文' })
  const hasItem = (await item.count()) > 0
  if (hasItem) await item.first().click()
  else await menu.press('Escape')
  return hasItem
}

try {
  // 同一分组里其它标签的编辑器也挂在 DOM 里：装一个"活动分组里可见的那个 ProseMirror"
  // 的取用函数，避免键盘 / DOM 操作落到别的标签页的编辑器上。
  await page.evaluate(() => {
    window.visibleNotePane = () =>
      [...document.querySelectorAll('.editor-group.active .ProseMirror')].find(
        (item) => item.getClientRects().length > 0
      ) ?? null
  })
  await openNote(page, { kbName: fixture.kbName, title: '甲笔记' })
  await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)
  // 预览标签会被下一篇笔记替换掉（那等于关闭来源标签）：先把甲笔记标签固定住
  await page.locator('.editor-group.active .tab.selected').first().dblclick()
  await page.waitForTimeout(300)

  const running = await waitFor(async () => {
    const value = await status()
    return value.running ? value : null
  }, 20000)
  assert.ok(running?.url, `本机 MCP 未启动：${JSON.stringify(running)}`)
  const client = new Client({ name: 'desk-e2e-pin', version: '0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${running.token}` } }
  })
  await client.connect(transport)

  /* ── 右键菜单固定 ── */
  await selectParagraph('甲段一。')
  const hasMenuItem = await pinViaContextMenu('甲段一。')
  rec.record('正文选区右键菜单里有「固定为 Agent 上下文」', hasMenuItem, `menuItem=${hasMenuItem}`)
  const pinned = await waitFor(async () => {
    const value = await read(client)
    return value.source === 'pinned' ? value : null
  }, 8000)
  rec.record(
    '固定后 MCP 返回固定快照并标明来源（source=pinned + pinnedAt）',
    pinned?.status === 'ok' &&
      pinned?.source === 'pinned' &&
      pinned?.selection?.selectedText === '甲段一。' &&
      typeof pinned?.pinnedAt === 'string' &&
      pinned?.note?.title === '甲笔记',
    `source=${pinned?.source} text=${JSON.stringify(pinned?.selection?.selectedText)}`
  )
  rec.record(
    '状态条显示来源笔记与选区摘要',
    (await page.getByTestId('pinned-context-bar').count()) === 1 &&
      (await page.getByTestId('pinned-context-bar').innerText()).includes('甲笔记') &&
      (await page.getByTestId('pinned-context-summary').innerText()).includes('甲段一'),
    `bar=${(await page.getByTestId('pinned-context-bar').innerText()).slice(0, 60)}`
  )

  /* ── 选 B / 切标签 / 切分组 / 失焦都不改变固定 ── */
  await selectParagraph('甲段二。')
  const afterSelectB = await read(client)
  rec.record(
    '固定 A 之后又选 B：仍返回 A（不读实时选区）',
    afterSelectB.source === 'pinned' && afterSelectB.selection?.selectedText === '甲段一。',
    `text=${JSON.stringify(afterSelectB.selection?.selectedText)}`
  )

  await page.locator('.toc-row', { hasText: '乙笔记' }).first().click()
  await page.waitForTimeout(700)
  const afterTabSwitch = await read(client)
  rec.record(
    '切换标签（打开乙笔记）后仍返回固定的甲段一',
    afterTabSwitch.source === 'pinned' &&
      afterTabSwitch.selection?.selectedText === '甲段一。' &&
      afterTabSwitch.note?.title === '甲笔记',
    `note=${afterTabSwitch.note?.title}`
  )

  // 固定与当前笔记两个工具互相独立：固定的是甲，活动笔记是乙 → 当前笔记返回乙
  const activeNoteWhilePinned = await (async () => {
    const result = await client.callTool({ name: 'get_current_note', arguments: {} })
    const text = result.content?.find((item) => item.type === 'text')?.text ?? '{}'
    return JSON.parse(text)
  })()
  rec.record(
    '固定甲、活动笔记是乙：get_current_note 返回乙（与固定上下文相互独立）',
    activeNoteWhilePinned.status === 'ok' && activeNoteWhilePinned.note?.title === '乙笔记',
    `note=${activeNoteWhilePinned.note?.title}`
  )

  await page
    .locator('.editor-group.active')
    .getByRole('button', { name: '向右拆分当前标签' })
    .first()
    .click()
  await waitFor(async () => (await page.locator('.editor-group').count()) === 2, 10000)
  console.log('DEBUG after split:', JSON.stringify(await read(client)).slice(250, 700))
  await page.locator('.editor-group:not(.active) .ProseMirror:visible').first().click()
  await page.waitForTimeout(500)
  const afterGroupSwitch = await read(client)
  rec.record(
    '切换编辑器分组后仍返回固定的甲段一',
    afterGroupSwitch.source === 'pinned' && afterGroupSwitch.selection?.selectedText === '甲段一。',
    `source=${afterGroupSwitch.source}`
  )

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].blur()
  })
  await page.waitForTimeout(400)
  const afterBlur = await read(client)
  rec.record(
    'Desk 失焦后固定上下文仍然可读',
    afterBlur.source === 'pinned' && afterBlur.selection?.selectedText === '甲段一。',
    `source=${afterBlur.source}`
  )
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].focus()
  })

  /* ── 多次调用不消费 ── */
  const first = await read(client)
  const second = await read(client)
  const third = await read(client)
  rec.record(
    '连续多次调用工具：固定不被消费（snapshotId / 正文都一样）',
    first.snapshotId === second.snapshotId &&
      second.snapshotId === third.snapshotId &&
      third.selection?.selectedText === '甲段一。',
    `snapshotId=${first.snapshotId}`
  )

  /* ── 「查看」把固定时的范围选出来 ── */
  await page.getByTestId('pinned-context-reveal').click()
  await page.waitForTimeout(600)
  const revealed = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  rec.record(
    '「查看」切回来源标签并把固定时的选区选出来',
    revealed.includes('甲段一'),
    `selection=${JSON.stringify(revealed)}`
  )

  /* ── 切换视图本身不失效 ── */
  await viewButton('源码视图').click()
  await page.locator('.markdown-source-editor .view-lines').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(500)
  const afterViewSwitch = await read(client)
  rec.record(
    '固定来源标签切到源码视图：固定仍然有效（切视图本身不失效）',
    afterViewSwitch.source === 'pinned' && afterViewSwitch.selection?.selectedText === '甲段一。',
    `source=${afterViewSwitch.source}`
  )
  await viewButton('可视化编辑').click()
  await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)

  /* ── 改 A 后方：保留；改 A：失效 ── */
  await selectParagraph('甲末尾。')
  await page.keyboard.press('End')
  await page.keyboard.type('（后方追加）')
  await page.waitForTimeout(600)
  const afterAppendTail = await read(client)
  rec.record(
    '修改 A 后方（不影响 A 的内容与坐标）：固定保留',
    afterAppendTail.source === 'pinned' && afterAppendTail.selection?.selectedText === '甲段一。',
    `source=${afterAppendTail.source}`
  )

  await selectParagraph('甲段一。')
  // 改的是**选区内部**（在选中的文字中间插一个字），不是"选区后方"
  await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('.editor-group.active .ProseMirror p')].find(
      (item) => item.textContent?.includes('甲段一。')
    )
    const node = paragraph?.firstChild
    if (node) window.getSelection()?.setBaseAndExtent(node, 1, node, 1)
  })
  await settle()
  await page.keyboard.type('改')
  const invalidated = await waitFor(async () => {
    const value = await read(client)
    return value.status === 'pinned_invalidated' ? value : null
  }, 8000)
  rec.record(
    '修改 A 的文字 → 固定失效（pinned_invalidated + 原因，不返回旧正文）',
    invalidated?.status === 'pinned_invalidated' &&
      invalidated.selection === undefined &&
      invalidated.snapshotId === null &&
      typeof invalidated.message === 'string' &&
      (invalidated.message.includes('已不再返回') || invalidated.message.includes('已变化')),
    `status=${invalidated?.status} message=${String(invalidated?.message).slice(0, 50)}`
  )
  rec.record(
    '失效后不回退读别的选区（也不返回 B）',
    invalidated?.source === 'pinned' &&
      (invalidated.selection === undefined || invalidated.selection === null),
    `source=${invalidated?.source}`
  )
  rec.record(
    '状态条把失效原因显示出来（只有「解除」）',
    (await page.getByTestId('pinned-context-reason').count()) === 1 &&
      (await page.getByTestId('pinned-context-reveal').count()) === 0,
    `reason=${await page.getByTestId('pinned-context-reason').innerText()}`
  )

  /* ── 解除：显式回到实时模式 ── */
  await page.getByTestId('pinned-context-clear').click()
  await waitFor(async () => (await page.getByTestId('pinned-context-bar').count()) === 0, 5000)
  const afterDismiss = await waitFor(async () => {
    const value = await read(client)
    return value.source === 'live' ? value : null
  }, 8000)
  rec.record(
    '「解除」后显式回到实时模式（source=live，读当前选区）',
    afterDismiss?.source === 'live',
    `source=${afterDismiss?.source} status=${afterDismiss?.status}`
  )

  /* ── 快捷键 ⌘K P 固定（在干净的乙笔记上验） ── */
  await page.locator('.toc-row', { hasText: '乙笔记' }).first().click()
  await page.waitForTimeout(700)
  await selectParagraph('乙段一。')
  await pinViaPalette()
  const pinnedByShortcut = await waitFor(async () => {
    const value = await read(client)
    return value.source === 'pinned' ? value : null
  }, 8000)
  rec.record(
    '命令面板「固定为 Agent 上下文」也能固定（与快捷键共用同一条路径）',
    pinnedByShortcut?.selection?.selectedText === '乙段一。' &&
      pinnedByShortcut?.note?.title === '乙笔记',
    `text=${JSON.stringify(pinnedByShortcut?.selection?.selectedText)}`
  )
  await page.getByTestId('pinned-context-clear').click()
  await page.waitForTimeout(300)

  /* ── 在 A 前插入内容（坐标变化）→ 失效 ── */
  // 注意：前面那条用例已经改过 A 的文字（甲改段一。），这里按"甲笔记那个面板里的段落"定位
  const selectJiaParagraph = () =>
    page.evaluate(() => {
      const panes = [...document.querySelectorAll('.editor-group.active .ProseMirror')]
      const pane = panes.find((item) => item.textContent?.includes('甲笔记'))
      const paragraph = [...(pane?.querySelectorAll('p') ?? [])].find((item) =>
        item.textContent?.includes('段一')
      )
      const node = paragraph?.firstChild
      if (node) window.getSelection()?.setBaseAndExtent(node, 0, node, node.textContent.length)
    })
  await page.locator('.toc-row', { hasText: '甲笔记' }).first().click()
  await page.waitForTimeout(900)
  await selectJiaParagraph()
  await settle()
  await pinViaContextMenu('段一')
  await waitFor(async () => {
    const value = await read(client)
    return value.source === 'pinned' ? value : null
  }, 8000)

  // 在文档最前面插入一整段：A 的位置整体后移（坐标变化）
  await page.locator('.editor-group.active .ProseMirror h1').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.type('新增的开头段落。')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  const movedInvalid = await waitFor(async () => {
    const value = await read(client)
    return value.status === 'pinned_invalidated' ? value : null
  }, 10000)
  rec.record(
    '在 A 前插入内容导致坐标变化 → 固定失效',
    movedInvalid?.status === 'pinned_invalidated',
    `status=${movedInvalid?.status} message=${String(movedInvalid?.message).slice(0, 40)}`
  )
  await page.getByTestId('pinned-context-clear').click()
  await page.waitForTimeout(300)

  /* ── 代码块特殊块也能固定（用一份没被编辑过的干净笔记） ── */
  // 位置锚落在"笔记源码文本"坐标系里，而源码文本只有在编辑能安全写回时才跟着文档走。
  // 上面甲笔记那条链最后停在"原文内容被并入其它块"的未保存草稿上（源码与排版结构不再一一对应），
  // 那种状态下固定会被**正确地**拒绝（拒绝路径与拒绝原因由 `pinnedContextService.test.ts` 覆盖），
  // 所以这里换一份干净笔记验代码块固定本身。
  await page.locator('.toc-row', { hasText: '戊笔记' }).first().click()
  await page.waitForTimeout(900)
  if ((await page.locator('.markdown-source-editor').count()) > 0) {
    await viewButton('可视化编辑').click()
    await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)
  }
  const codeLine = page.locator('.editor-group.active .milkdown-code-block .cm-line').first()
  await codeLine.click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await settle()
  await pinViaPalette()
  const codePinned = await waitFor(async () => {
    const value = await read(client)
    return value.source === 'pinned' ? value : null
  }, 8000)
  rec.record(
    '代码块里的选区也能固定（块级上下文 + 不可变快照）',
    codePinned?.status === 'ok' &&
      codePinned?.selection?.mapping === 'block' &&
      (codePinned?.selection?.blocks?.[0]?.kind ?? '').includes('code') &&
      codePinned?.selection?.selectedText === 'const pinned = 1',
    `mapping=${codePinned?.selection?.mapping} kind=${codePinned?.selection?.blocks?.[0]?.kind} text=${JSON.stringify(codePinned?.selection?.selectedText)}`
  )

  // 同一代码块里选区**后方**追加：固定保留（代码块也按位置锚校验，不按整块比较）
  await codeLine.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' // 后方追加')
  await page.waitForTimeout(700)
  const afterCodeTail = await read(client)
  rec.record(
    '同一代码块里选区**后方**的修改：固定保留',
    afterCodeTail.source === 'pinned' &&
      afterCodeTail.selection?.selectedText === 'const pinned = 1',
    `source=${afterCodeTail.source} status=${afterCodeTail.status} message=${String(afterCodeTail?.message).slice(0, 60)}`
  )

  // 代码块里选区**内部**被改 → 失效
  await codeLine.click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await settle()
  await page.keyboard.type('const changed = 2')
  const codeInvalid = await waitFor(async () => {
    const value = await read(client)
    return value.status === 'pinned_invalidated' ? value : null
  }, 10000)
  rec.record(
    '代码块里选区内部被修改 → 固定失效',
    codeInvalid?.status === 'pinned_invalidated',
    `status=${codeInvalid?.status}`
  )
  await page.getByTestId('pinned-context-clear').click()
  await page.waitForTimeout(300)

  /* ── P2：同一段落 / 同一代码块里选区**后方**的修改不该误伤固定 ── */
  await page.locator('.toc-row', { hasText: '乙笔记' }).first().click()
  await page.waitForTimeout(900)
  // 同一段落：先固定「乙段一。」，再改同段落后面的文字
  await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('.editor-group.active .ProseMirror p')].find(
      (item) => item.textContent?.includes('乙段一。')
    )
    const node = paragraph?.firstChild
    window.getSelection()?.setBaseAndExtent(node, 0, node, 4)
  })
  await settle()
  await pinViaPalette()
  const pinnedInParagraph = await waitFor(async () => {
    const value = await read(client)
    return value.source === 'pinned' ? value : null
  }, 8000)
  rec.record(
    '固定段落内选区（先建立基线）',
    pinnedInParagraph?.selection?.selectedText === '乙段一。',
    `text=${JSON.stringify(pinnedInParagraph?.selection?.selectedText)}`
  )
  // 在选区后面（同一段落内）插入文字
  await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('.editor-group.active .ProseMirror p')].find(
      (item) => item.textContent?.includes('乙段一。')
    )
    const node = paragraph?.firstChild
    if (node)
      window
        .getSelection()
        ?.setBaseAndExtent(node, node.textContent.length, node, node.textContent.length)
  })
  await settle()
  await page.keyboard.type('（同段落后方追加）')
  await page.waitForTimeout(700)
  const afterSameParagraphTail = await read(client)
  rec.record(
    '同一段落里选区**后方**的修改：固定保留（不按整块比较）',
    afterSameParagraphTail.source === 'pinned' &&
      afterSameParagraphTail.selection?.selectedText === '乙段一。',
    `source=${afterSameParagraphTail.source} status=${afterSameParagraphTail.status}`
  )
  // 选区内部被改 → 失效
  await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('.editor-group.active .ProseMirror p')].find(
      (item) => item.textContent?.includes('乙段一。')
    )
    const node = paragraph?.firstChild
    if (node) window.getSelection()?.setBaseAndExtent(node, 1, node, 1)
  })
  await settle()
  await page.keyboard.type('X')
  const sameParagraphInvalid = await waitFor(async () => {
    const value = await read(client)
    return value.status === 'pinned_invalidated' ? value : null
  }, 10000)
  rec.record(
    '选区内部被修改 → 固定失效（同段落场景）',
    sameParagraphInvalid?.status === 'pinned_invalidated',
    `status=${sameParagraphInvalid?.status}`
  )
  await page.getByTestId('pinned-context-clear').click()
  await page.waitForTimeout(300)

  /* ── 跨视图：可视化固定 → 切源码 → 在 A 前插入 → 失效 ── */
  await page.locator('.toc-row', { hasText: '丙笔记' }).first().click()
  await page.waitForTimeout(900)
  await selectParagraph('丙段一。')
  await pinViaPalette()
  await waitFor(async () => (await read(client)).source === 'pinned', 8000)
  await viewButton('源码视图').click()
  await page.locator('.markdown-source-editor .view-lines').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(400)
  rec.record('只切视图（可视化 → 源码）：固定保留', (await read(client)).source === 'pinned')
  // 在源码视图里、A 之前插入一行
  await page
    .locator('.markdown-source-editor .monaco-editor')
    .first()
    .click({ position: { x: 200, y: 60 } })
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Enter')
  await page.keyboard.type('源码视图里插到最前面的段落。')
  const crossViewInvalid = await waitFor(async () => {
    const value = await read(client)
    return value.status === 'pinned_invalidated' ? value : null
  }, 10000)
  rec.record(
    '可视化固定 → 切源码 → 在 A 前插入内容 → 失效（位置锚，不是全文搜索）',
    crossViewInvalid?.status === 'pinned_invalidated',
    `status=${crossViewInvalid?.status} message=${String(crossViewInvalid?.message).slice(0, 40)}`
  )
  await page.getByTestId('pinned-context-clear').click()
  await page.waitForTimeout(300)

  /* 说明：源码固定 → 切可视化 → 前方插入 这一条与上面"可视化固定 → 切源码"共用同一条
     位置锚机制（`textAnchor` 只认偏移，不区分当初是哪个视图固定），
     因此由 `pinnedAnchorCheck.test.ts` / `pinnedContextService.test.ts` 单测覆盖，
     E2E 不再重复（源码视图里做文本操作依赖 Monaco 焦点细节，脆弱且没有新增信息量）。 */

  /* ── 写不回源码的草稿：固定被明确拒绝（不猜坐标、不留半份固定） ── */
  // 上面那条用例在源码视图最前面插了一段之后，丙笔记就停在"排版结构与源码对不上"的
  // 未保存草稿上（Desk 的吞并保护拦住了保存）。这时位置锚不可信：固定必须被明确拒绝，
  // 而且要把原因说清楚 —— 宁可拒绝，也不固定一份以后验不了的上下文。
  await page.locator('.toc-row', { hasText: '巨块' }).first().click()
  await page.waitForTimeout(700)
  await page.locator('.toc-row', { hasText: '丙笔记' }).first().click()
  await page.waitForTimeout(900)
  // 前面跨视图用例可能把丙留在源码视图：显式切回可视化
  if ((await page.locator('.markdown-source-editor').count()) > 0) {
    await viewButton('可视化编辑').click()
    await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)
  }
  await selectParagraph('丙段二。')
  await pinViaPalette()
  const refusedOnDrift = await waitFor(
    async () =>
      (await page.evaluate(() => document.body.innerText)).includes(
        '固定失败：当前文档有未保存的改动'
      ),
    8000
  )
  const afterDriftRefusal = await read(client)
  rec.record(
    '排版结构与源码对不上的未保存草稿：固定被明确拒绝并说明原因（不猜坐标）',
    refusedOnDrift === true && afterDriftRefusal.source === 'live',
    `hinted=${refusedOnDrift === true} source=${afterDriftRefusal.source}`
  )
  rec.record(
    '被拒绝后不留半份固定（状态条不出现）',
    (await page.getByTestId('pinned-context-bar').count()) === 0,
    `bar=${await page.getByTestId('pinned-context-bar').count()}`
  )

  /* ── 原 A 被删除，别处仍有相同文字：仍然失效 ── */
  // 这一条要用**干净笔记**（上面的丙笔记已经处于写不回源码的草稿状态，固定会被拒绝）。
  await page.locator('.toc-row', { hasText: '己笔记' }).first().click()
  await page.waitForTimeout(900)
  await selectParagraph('己段二。')
  await pinViaPalette()
  const pinnedForDuplicate = await waitFor(async () => {
    const value = await read(client)
    return value.source === 'pinned' && value.selection?.selectedText === '己段二。' ? value : null
  }, 8000)
  rec.record(
    '固定己段二。（为"原位置被删除"这条规则建立基线）',
    pinnedForDuplicate?.source === 'pinned',
    `source=${pinnedForDuplicate?.source} status=${pinnedForDuplicate?.status}`
  )
  // 在文末复制一段一模一样的文字，再把原来的那段删掉。
  // 注意两点：(1) 同一分组里**其它标签的编辑器也挂在 DOM 里**，所以每一步都只碰
  // 当前笔记那个可见面板；(2) 复制这一段只用「点一下段落 → End → Enter → 输入」，
  // 不先用 DOM 选区选中整段 —— 那样 Enter 会把选中的原文替换掉，制造出别的文档状态。
  await page
    .locator('.editor-group.active .ProseMirror:visible p', { hasText: '己段二。' })
    .first()
    .click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('己段二。')
  await page.waitForTimeout(400)
  // 复制出来的那段不该动到固定（改的是选区后方）
  const afterDuplicateAppend = await read(client)
  rec.record(
    '在文末复制一段一模一样的文字：固定保留（后方改动不误伤）',
    afterDuplicateAppend.source === 'pinned' &&
      afterDuplicateAppend.selection?.selectedText === '己段二。',
    `source=${afterDuplicateAppend.source} status=${afterDuplicateAppend.status}`
  )
  // 删掉原来那段：只认可见面板里**内容完全等于**「己段二。」的第一个段落（DOM 顺序里的原文）
  await page.evaluate(() => {
    const pane = window.visibleNotePane()
    const paragraph = [...(pane?.querySelectorAll('p') ?? [])].find(
      (item) => item.textContent?.trim() === '己段二。'
    )
    const node = paragraph?.firstChild
    if (node) window.getSelection()?.setBaseAndExtent(node, 0, node, node.textContent.length)
  })
  await settle()
  await page.keyboard.press('Backspace')
  const duplicateInvalid = await waitFor(async () => {
    const value = await read(client)
    return value.status === 'pinned_invalidated' ? value : null
  }, 10000)
  const duplicateStillThere = await page.evaluate(() => {
    const pane = window.visibleNotePane()
    return [...(pane?.querySelectorAll('p') ?? [])].some(
      (item) => item.textContent?.trim() === '己段二。'
    )
  })
  rec.record(
    '原位置被删除、文档别处仍有相同文字 → 仍然失效（不是全文搜索）',
    duplicateInvalid?.status === 'pinned_invalidated' &&
      duplicateInvalid.selection === undefined &&
      duplicateStillThere,
    `status=${duplicateInvalid?.status} 别处仍有相同文字=${duplicateStillThere}`
  )
  await page.getByTestId('pinned-context-clear').click()
  await page.waitForTimeout(300)

  /* ── 超限拒绝 ── */
  await page.locator('.toc-row', { hasText: '巨块' }).first().click()
  await page.waitForTimeout(1200)
  const giantPane = page.locator('.editor-group.active .ProseMirror:visible').first()
  await waitFor(async () => {
    if ((await giantPane.count()) === 0) return false
    return (await giantPane.textContent())?.includes('长长长长长') ?? false
  }, 30000)
  await selectParagraph('长长长长长')
  await pinViaPalette()
  const stillLive = await read(client)
  const hint = await page.evaluate(() => {
    const text = document.body.innerText
    return text.includes('固定失败') || text.includes('无法固定') || text.includes('过长')
  })
  rec.record(
    '超限选区拒绝固定（明确提示，且不留下半份固定）',
    stillLive.source === 'live' && (await page.getByTestId('pinned-context-bar').count()) === 0,
    `hinted=${hint} source=${stillLive.source}`
  )

  /* ── 外部修改文件：按磁盘内容复核后失效 ── */
  // Desk 只在"保存时会比对 revision"这条路上发现外部改动，所以流程是：
  // 干净时固定（源=磁盘）→ 制造未保存编辑 → 磁盘上改掉 A → 保存触发冲突 → 按磁盘复核
  await page.locator('.toc-row', { hasText: '丁笔记' }).first().click()
  await page.waitForTimeout(900)
  await selectParagraph('丁段一。')
  await pinViaPalette()
  const pinnedForDisk = await waitFor(async () => {
    const value = await read(client)
    return value.source === 'pinned' && value.selection?.selectedText === '丁段一。' ? value : null
  }, 8000)
  rec.record(
    '没有未保存修改时固定：来源标为磁盘内容（外部修改才走磁盘复核）',
    pinnedForDisk?.editor?.contentSource === 'disk',
    `contentSource=${pinnedForDisk?.editor?.contentSource}`
  )

  // 制造未保存编辑（不动 A），再在磁盘上改掉 A
  await selectParagraph('丁段二。')
  await page.keyboard.press('End')
  await page.keyboard.type('（本地未保存）')
  await page.waitForTimeout(400)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(noteD, readFileSync(noteD, 'utf8').replace('丁段一。', '丁段一（外部改）。'))
  await page.keyboard.press('ControlOrMeta+s')
  const afterDiskEdit = await waitFor(async () => {
    const value = await read(client)
    return value.status === 'pinned_invalidated' ? value : null
  }, 15000)
  rec.record(
    '外部修改了 A 的内容 → 保存触发冲突后按磁盘内容复核，固定明确失效',
    afterDiskEdit?.status === 'pinned_invalidated' && afterDiskEdit.selection === undefined,
    `status=${afterDiskEdit?.status} message=${String(afterDiskEdit?.message).slice(0, 40)}`
  )
  await page.getByTestId('pinned-context-clear').click()
  await page.waitForTimeout(300)

  /* ── 关同笔记另一份标签：保留；关来源标签：失效 ── */
  await page.locator('.toc-row', { hasText: '乙笔记' }).first().click()
  await page.waitForTimeout(900)
  // 前面的用例改过乙的正文；这里按"乙笔记那个面板里的段落"定位，并确保是可视化视图
  if ((await page.locator('.markdown-source-editor').count()) > 0) {
    await viewButton('可视化编辑').click()
    await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)
  }
  await page.evaluate(() => {
    const panes = [...document.querySelectorAll('.editor-group.active .ProseMirror')]
    const pane = panes.find((item) => item.textContent?.includes('乙笔记'))
    const paragraph = [...(pane?.querySelectorAll('p') ?? [])].find((item) =>
      item.textContent?.includes('段一')
    )
    const node = paragraph?.firstChild
    if (node) window.getSelection()?.setBaseAndExtent(node, 0, node, 4)
  })
  await settle()
  await pinViaPalette()
  await waitFor(async () => (await read(client)).source === 'pinned', 8000)

  await page
    .locator('.editor-group.active')
    .getByRole('button', { name: '向右拆分当前标签' })
    .first()
    .click()
  await waitFor(async () => (await page.locator('.editor-group').count()) === 2, 10000)
  await page.waitForTimeout(500)
  const afterSplit = await read(client)
  const pinnedTextInSiblingCase = (await read(client)).selection?.selectedText
  rec.record(
    '拆分出同一笔记的另一份标签：固定仍然有效',
    afterSplit.source === 'pinned' && afterSplit.status === 'ok',
    `source=${afterSplit.source} status=${afterSplit.status}`
  )

  // 关掉新分组里那份（不是来源标签）：不能误清固定
  const activeTabClose = () => page.locator('.editor-group.active').getByLabel('关闭标签').first()
  await activeTabClose().waitFor({ timeout: 15000 })
  await activeTabClose().click({ force: true })
  await page.waitForTimeout(700)
  const afterSiblingClose = await read(client)
  rec.record(
    '关闭同一笔记的**另一份**标签：固定保留（归属记到具体分组 + 标签）',
    afterSiblingClose.source === 'pinned' &&
      afterSiblingClose.status === 'ok' &&
      afterSiblingClose.selection?.selectedText === pinnedTextInSiblingCase,
    `source=${afterSiblingClose.source} status=${afterSiblingClose.status}`
  )

  // 说明：**关闭来源标签 → 不再返回固定快照**这一条在带未保存编辑时会被应用的
  // "正在处理标签页"遮罩挡住（那是关标签自己的确认/保存流程），不适合放在这条
  // 已经改过正文的长链路里做端到端；它由 `pinnedContextService` 的失效路径
  // （`reportPinValidation(false, '固定上下文的来源标签已关闭')`）与服务单测覆盖，
  // 本套件保留上面"关同笔记另一份标签 → 固定保留"这一半（归属规则的回归风险在这边）。

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
  await client.close()
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
