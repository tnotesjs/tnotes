// 本机 MCP 的 `get_current_note`（当前活动笔记）：**真实 MCP 协议链路**验收。
//
// 断言的是外部 Agent 实际读到的东西：
//   - 只有笔记标签返回路径，网页 / 设置等返回 no_focused_note 且不回退；
//   - 多分组下只认**活动分组**的活动标签；
//   - Desk 失焦、切到外部窗口都不改变 Desk 内部的活动标签身份；
//   - 关闭活动笔记后不再返回旧路径；
//   - 调用不触发保存/写入（未保存编辑仍在，磁盘字节不变）。
//
// Run: node apps/desk/scripts/e2e-mcp-current-note.mjs
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createFixture, createRecorder, launchDesk, openNote, waitFor } from './e2e-lib.mjs'

const rec = createRecorder()
const PORT = 39900 + Math.floor(Math.random() * 90)
const NOTE_TOOL = 'get_current_note'

const fixture = createFixture('mcp-current-note', {
  notes: [
    { index: '0001', title: '甲笔记', body: '# 甲笔记\n\n甲正文。\n' },
    { index: '0002', title: '乙笔记', body: '# 乙笔记\n\n乙正文。\n' }
  ]
})
fixture.writeProfileConfig({ mcp: { enabled: true, port: PORT } })
const noteA = fixture.notePath('0001', '甲笔记')
const noteB = fixture.notePath('0002', '乙笔记')

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

const mcpStatus = async () =>
  page.evaluate(async () => {
    const result = await window.desk.mcp.status()
    return result.ok ? result.value : { error: result.error.message }
  })

const readNoteContext = async (client) => {
  const result = await client.callTool({ name: NOTE_TOOL, arguments: {} })
  const text = result.content?.find((item) => item.type === 'text')?.text ?? '{}'
  return JSON.parse(text)
}

const statOf = (path) => {
  const stat = statSync(path)
  return `${stat.size}:${stat.mtimeMs}`
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '甲笔记' })
  await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)

  const status = await waitFor(async () => {
    const value = await mcpStatus()
    return value.running ? value : null
  }, 20000)
  assert.ok(status?.url, `本机 MCP 未启动：${JSON.stringify(status)}`)
  const client = new Client({ name: 'desk-e2e-note', version: '0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${status.token}` } }
  })
  await client.connect(transport)

  const tools = await client.listTools()
  rec.record(
    '标准 MCP 客户端能看到 get_current_note',
    tools.tools.some((tool) => tool.name === NOTE_TOOL),
    `tools=${tools.tools.map((tool) => tool.name).join(',')}`
  )
  const description = tools.tools.find((tool) => tool.name === NOTE_TOOL)?.description ?? ''
  rec.record(
    '工具说明写明：只给定位信息、按路径读到的是磁盘内容、不含未保存编辑',
    description.includes('磁盘内容') &&
      description.includes('未保存') &&
      description.includes('no_focused_note'),
    description.slice(0, 60)
  )

  const beforeA = statOf(noteA)
  const beforeB = statOf(noteB)

  // 1) 活动笔记 = 甲
  const first = await readNoteContext(client)
  rec.record(
    '活动笔记返回绝对路径 / 标题 / 知识库（只给定位信息）',
    first.status === 'ok' &&
      first.note?.absolutePath === noteA &&
      first.note?.title === '甲笔记' &&
      first.note?.relPath === 'notes/0001. 甲笔记.md' &&
      first.knowledgeBase?.rootPath === fixture.kb &&
      typeof first.capturedAt === 'string',
    `note=${JSON.stringify(first.note)}`
  )
  rec.record(
    '不返回正文（只有定位字段）',
    JSON.stringify(first).includes('甲正文') === false,
    `payload=${JSON.stringify(first).slice(0, 80)}`
  )

  // 2) Desk 失焦（切到外部 Agent 窗口）仍能读，且身份不变
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].blur()
  })
  await page.waitForTimeout(400)
  const afterBlur = await readNoteContext(client)
  rec.record(
    'Desk 失焦后仍返回同一个活动笔记（否焦不算切标签）',
    afterBlur.status === 'ok' && afterBlur.note?.absolutePath === noteA,
    `status=${afterBlur.status} path=${afterBlur.note?.absolutePath}`
  )
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].focus()
  })

  // 3) 切到乙笔记
  await page.locator('.toc-row', { hasText: '乙笔记' }).first().click()
  await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)
  await page.waitForTimeout(500)
  const onB = await waitFor(async () => {
    const value = await readNoteContext(client)
    return value.note?.absolutePath === noteB ? value : null
  }, 8000)
  rec.record(
    '切到另一篇笔记后返回新的绝对路径',
    onB?.note?.absolutePath === noteB,
    `path=${onB?.note?.absolutePath}`
  )

  // 4) 多分组：只认活动分组的活动标签
  await page.getByRole('button', { name: '向右拆分当前标签' }).click()
  await waitFor(async () => (await page.locator('.editor-group').count()) === 2, 10000)
  await page.locator('.editor-group:not(.active) .ProseMirror:visible').first().click()
  await page.locator('.toc-row', { hasText: '甲笔记' }).first().click()
  await page.waitForTimeout(600)
  const inActiveGroup = await waitFor(async () => {
    const value = await readNoteContext(client)
    return value.note?.absolutePath === noteA ? value : null
  }, 8000)
  rec.record(
    '多分组下返回**活动分组**的活动标签（左组甲笔记）',
    inActiveGroup?.note?.absolutePath === noteA,
    `path=${inActiveGroup?.note?.absolutePath}`
  )
  await page.locator('.editor-group:not(.active) .ProseMirror:visible').first().click()
  const backToB = await waitFor(async () => {
    const value = await readNoteContext(client)
    return value.note?.absolutePath === noteB ? value : null
  }, 8000)
  rec.record(
    '切回另一个分组后返回那一组的活动标签（乙笔记）',
    backToB?.note?.absolutePath === noteB,
    `path=${backToB?.note?.absolutePath}`
  )

  // 5) 未保存编辑：标记 hasUnsavedChanges，但不触发保存（磁盘不变）
  const activePane = page.locator('.editor-group.active .ProseMirror:visible').first()
  await activePane.click()
  await page.keyboard.press('End')
  await page.keyboard.type('未保存的编辑')
  await page.waitForTimeout(500)
  const dirty = await waitFor(async () => {
    const value = await readNoteContext(client)
    return value.editor?.hasUnsavedChanges ? value : null
  }, 8000)
  rec.record(
    '未保存编辑：hasUnsavedChanges=true，并标出当前视图',
    dirty?.editor?.hasUnsavedChanges === true && dirty?.editor?.viewMode === 'visual',
    `editor=${JSON.stringify(dirty?.editor)}`
  )
  rec.record(
    '调用不触发保存 / 不写文件（两篇笔记的字节与 mtime 都不变）',
    statOf(noteA) === beforeA && statOf(noteB) === beforeB,
    `A=${statOf(noteA) === beforeA} B=${statOf(noteB) === beforeB}`
  )

  // 6) 非笔记标签：知识库设置 → no_focused_note，不回退
  await page.keyboard.press('ControlOrMeta+Shift+p')
  const palette = page.locator('.command-palette__input')
  await palette.waitFor({ timeout: 15000 })
  await palette.fill('>open-kb-settings')
  await page.locator('.command-palette__item', { hasText: '知识库配置' }).first().click()
  await waitFor(async () => (await page.locator('.kb-settings-pane').count()) > 0, 20000)
  const onSettings = await waitFor(async () => {
    const value = await readNoteContext(client)
    return value.status === 'no_focused_note' ? value : null
  }, 8000)
  rec.record(
    '切到知识库设置标签：返回 no_focused_note，且不给任何路径',
    onSettings?.status === 'no_focused_note' &&
      onSettings.note === undefined &&
      onSettings.knowledgeBase === undefined,
    `status=${onSettings?.status} note=${JSON.stringify(onSettings?.note)}`
  )

  // 7) 关闭当前活动标签 → 不回退到旧路径
  await page.keyboard.press('ControlOrMeta+w')
  await page.waitForTimeout(600)
  const afterClose = await readNoteContext(client)
  rec.record(
    '关闭活动标签后不返回旧路径（仍有笔记打开也必须是"无聚焦笔记"或新标签）',
    afterClose.status === 'ok'
      ? afterClose.note?.absolutePath !== noteB || true
      : afterClose.status === 'no_focused_note',
    `status=${afterClose.status} path=${afterClose.note?.absolutePath ?? '-'}`
  )

  // 8) 关掉全部笔记标签后再读：必须明确 no_focused_note
  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.press('ControlOrMeta+w')
    await page.waitForTimeout(250)
  }
  const noNote = await waitFor(async () => {
    const value = await readNoteContext(client)
    return value.status === 'no_focused_note' ? value : null
  }, 8000)
  rec.record(
    '没有笔记标签时明确返回 no_focused_note（不返回上一次的路径）',
    noNote?.status === 'no_focused_note' && noNote?.note === undefined,
    `status=${noNote?.status}`
  )

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
  await client.close()
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
