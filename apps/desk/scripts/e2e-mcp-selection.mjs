// 本机 MCP 选区上下文服务：**真实 MCP 协议链路**验收（阶段 A 端到端闭环）。
//
// 用官方 SDK 的客户端（Streamable HTTP）连 Desk 主进程起的本机服务：
//   initialize → tools/list → tools/call get_current_selection
// 断言：初始化与工具调用走通、返回真实笔记身份与精确选区、失焦后仍可读、
//       无令牌 / 错误令牌被拒、无选区是结构化结果、切笔记后旧快照失效、
//       工具调用前后磁盘文件与编辑状态不变。
//
// Run: node apps/desk/scripts/e2e-mcp-selection.mjs
import assert from 'node:assert/strict'

import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createFixture, createRecorder, launchDesk, openNote, waitFor } from './e2e-lib.mjs'

const rec = createRecorder()
/** 便于在断言失败信息里看清原始状态码 */
const spoofedHostHost = (status) => status
const PORT = 39000 + Math.floor(Math.random() * 500)
const TOOL = 'get_current_selection'

const body = [
  '# 选区验收', // 1
  '', // 2
  '第一段中文，带 emoji 🎯 与末尾空格 ', // 3
  '', // 4
  '第二段用于跨段选择。', // 5
  '', // 6
  '```js', // 7
  'const answer = 42', // 8
  '```', // 9
  '', // 10
  '最后一段。', // 11
  ''
].join('\n')

const fixture = createFixture('mcp-selection', {
  notes: [
    { index: '0001', title: '选区', body },
    { index: '0002', title: '另一篇', body: '# 另一篇\n\n别的正文\n' }
  ]
})
// 打开「本机 MCP」开关（默认关闭），端口固定
fixture.writeProfileConfig({ mcp: { enabled: true, port: PORT } })
const noteFile = fixture.notePath('0001', '选区')

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

/** 从渲染端拿服务状态（地址 + 令牌）：设置界面就是这么展示的 */
const mcpStatus = async () =>
  page.evaluate(async () => {
    const result = await window.desk.mcp.status()
    return result.ok ? result.value : { error: result.error.message }
  })

/** 走真实 HTTP：不带 / 带错令牌都要被拒 */
const rawCall = async (headers, path = '/mcp', method = 'POST', payload) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: payload ? JSON.stringify(payload) : undefined
  })
  return response.status
}

const connect = async (token) => {
  const client = new Client({ name: 'desk-e2e-client', version: '0.0.1' })
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

try {
  await openNote(page, { kbName: fixture.kbName, title: '选区' })
  await waitFor(async () => (await page.locator('.milkdown .ProseMirror').count()) > 0, 20000)

  // 服务状态（开关注入后应已启动）
  const status = await waitFor(async () => {
    const value = await mcpStatus()
    return value.running ? value : null
  }, 20000)
  rec.record(
    '本机 MCP 已按设置启动（回环地址 + 令牌）',
    Boolean(status?.running) &&
      String(status?.url).startsWith('http://127.0.0.1:') &&
      typeof status?.token === 'string' &&
      status.token.length >= 32,
    `url=${status?.url} error=${status?.error ?? '-'}`
  )
  assert.ok(status?.url, '服务未启动，后续断言无意义')
  const token = status.token

  // ── 鉴权：无令牌 / 错误令牌都要被拒 ──
  const initializeBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw', version: '0' }
    }
  }
  rec.record('无令牌请求被拒（401）', (await rawCall({}, '/mcp', 'POST', initializeBody)) === 401)
  rec.record(
    '错误令牌请求被拒（401）',
    (await rawCall({ authorization: 'Bearer wrong-token' }, '/mcp', 'POST', initializeBody)) === 401
  )
  rec.record(
    '伪造 Origin 被拒（403，挡 DNS rebinding / 网页侧调用）',
    (await rawCall(
      { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
      '/mcp',
      'POST',
      initializeBody
    )) === 403
  )
  // fetch 不允许自定义 Host 头（forbidden header），这里用 node:http 原样发一个
  const spoofedHostStatus = await new Promise((resolve, reject) => {
    const payload = JSON.stringify(initializeBody)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          host: 'evil.example',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
  rec.record(
    '非回环 Host 被拒（403）',
    spoofedHostHost(spoofedHostStatus) === 403,
    `status=${spoofedHostStatus}`
  )

  const client = await connect(token)
  const tools = await client.listTools()
  rec.record(
    '标准 MCP 客户端完成 initialize + tools/list（选区 + 当前笔记两个只读工具）',
    tools.tools.some((tool) => tool.name === TOOL) &&
      tools.tools.some((tool) => tool.name === 'get_current_note') &&
      tools.tools.length === 2,
    `tools=${tools.tools.map((tool) => tool.name).join(',')}`
  )
  const description = tools.tools.find((tool) => tool.name === TOOL)?.description ?? ''
  rec.record(
    '工具说明告知"草稿可能与磁盘不同、别按草稿坐标改磁盘"',
    description.includes('draft') && description.includes('磁盘'),
    `desc=${description.slice(0, 40)}…`
  )

  // 无选区：结构化结果，不是异常
  const noSelection = await readSelection(client)
  rec.record(
    '没有选区时返回 status=no_selection（结构化，不抛错）',
    noSelection.status === 'no_selection' && noSelection.snapshotId === null,
    `status=${noSelection.status}`
  )

  // ── 源码视图：精确选区 ──
  await page
    .getByRole('button', { name: '源码视图', exact: true })
    .filter({ visible: true })
    .first()
    .click()
  await waitFor(
    async () => (await page.locator('.markdown-source-editor .view-lines').count()) > 0,
    20000
  )
  await page.waitForTimeout(400)

  // 用键盘把光标放到「第一段中文」行，然后选中整行（含 emoji 与末尾空格）
  const firstLine = page
    .locator('.markdown-source-editor .view-line', { hasText: '第一段中文' })
    .first()
  await firstLine.click()
  await page.keyboard.press('Meta+ArrowLeft')
  await page.keyboard.press('Meta+Shift+ArrowRight')

  const snapshot = await waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'ok' ? value : null
  }, 10000)
  // 期望的行号 / 偏移从磁盘文件算（笔记带 frontmatter，行号不是 3）
  const diskText = readFileSync(noteFile, 'utf8')
  const expectedLine = diskText.slice(0, diskText.indexOf('第一段中文')).split('\n').length
  const expectedStart = diskText.indexOf('第一段中文')
  rec.record(
    '源码视图选区：返回真实笔记身份（标题 / 绝对路径 / 知识库）',
    Boolean(
      snapshot?.note?.title === '选区' &&
      snapshot?.note?.absolutePath.endsWith('0001. 选区.md') &&
      snapshot?.knowledgeBase?.rootPath.endsWith(fixture.kbName)
    ),
    `note=${JSON.stringify(snapshot?.note)} kb=${snapshot?.knowledgeBase?.id}`
  )
  rec.record(
    '选中文本与编辑器一致（不 trim、emoji 完整）',
    snapshot?.selection?.selectedText === '第一段中文，带 emoji 🎯 与末尾空格 ',
    `text=${JSON.stringify(snapshot?.selection?.selectedText)}`
  )
  rec.record(
    '给出精确源码范围（行列 1-based、offset 0-based、结束不含）',
    snapshot?.selection?.mapping === 'source-range' &&
      snapshot?.selection?.sourceRange?.startLine === expectedLine &&
      snapshot?.selection?.sourceRange?.endLine === expectedLine &&
      snapshot?.selection?.sourceRange?.startOffset === expectedStart &&
      snapshot?.selection?.sourceRange?.endExclusive === true &&
      snapshot?.selection?.sourceRange?.lineBase === 1 &&
      snapshot?.selection?.sourceRange?.endOffset -
        snapshot?.selection?.sourceRange?.startOffset ===
        snapshot?.selection?.selectedText.length,
    `${JSON.stringify(snapshot?.selection?.sourceRange)} expectedLine=${expectedLine} expectedStart=${expectedStart}`
  )
  rec.record(
    '相关块只含涉及的块（不附带整篇笔记）',
    Array.isArray(snapshot?.selection?.blocks) &&
      snapshot.selection.blocks.length > 0 &&
      snapshot.selection.blocks.every((block) => block.source === 'raw') &&
      snapshot.selection.blocks.some((block) => block.markdown.includes('第一段中文')) &&
      snapshot.selection.blocks.every((block) => !block.markdown.includes('最后一段。')),
    `blocks=${snapshot?.selection?.blocks?.map((block) => block.kind).join(',')}`
  )
  rec.record(
    '标识了内容版本与来源（revision / contentSource）',
    typeof snapshot?.editor?.revision === 'string' &&
      snapshot.editor.revision.length > 0 &&
      ['draft', 'disk'].includes(snapshot?.editor?.contentSource) &&
      snapshot.editor.viewMode === 'source',
    `revision=${snapshot?.editor?.revision} source=${snapshot?.editor?.contentSource} dirty=${snapshot?.editor?.hasUnsavedChanges}`
  )

  // ── 失焦（切到其它应用）后仍可读 ──
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.blur()
    return window.isFocused()
  })
  await page.waitForTimeout(400)
  const afterBlur = await readSelection(client)
  rec.record(
    'Desk 失焦（切到外部 Agent）后快照仍可读',
    afterBlur.status === 'ok' &&
      afterBlur.selection?.selectedText === snapshot.selection.selectedText,
    `status=${afterBlur.status} sameSnapshot=${afterBlur.snapshotId === snapshot.snapshotId}`
  )

  // ── 回到 Desk 并恢复焦点（失焦期间按键不会进编辑器）──
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].focus()
  })
  await firstLine.click()
  await page.keyboard.press('Meta+ArrowLeft')
  await page.keyboard.press('Meta+Shift+ArrowRight')
  await waitFor(async () => (await readSelection(client)).status === 'ok', 8000)

  // ── 用户主动取消选区 → 清除 ──
  await page.keyboard.press('ArrowRight')
  const afterCancel = await waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'no_selection' ? value : null
  }, 5000)
  rec.record(
    '主动取消选区后清除（no_selection，且不再给出旧文本）',
    afterCancel?.status === 'no_selection' && afterCancel.selection === undefined,
    `status=${afterCancel?.status}`
  )

  // ── 草稿状态：编辑后重新选中，contentSource=draft ──
  await page.keyboard.type('X')
  await page.waitForTimeout(300)
  await firstLine.click()
  await page.keyboard.press('Meta+ArrowLeft')
  await page.keyboard.press('Meta+Shift+ArrowRight')
  const draftSnapshot = await waitFor(async () => {
    const value = await readSelection(client)
    return value.status === 'ok' && value.editor?.contentSource === 'draft' ? value : null
  }, 8000)
  rec.record(
    '未保存草稿标明 contentSource=draft、hasUnsavedChanges=true',
    draftSnapshot?.editor?.contentSource === 'draft' &&
      draftSnapshot?.editor?.hasUnsavedChanges === true,
    `source=${draftSnapshot?.editor?.contentSource} dirty=${draftSnapshot?.editor?.hasUnsavedChanges}`
  )

  // ── 切笔记 → 旧快照失效（不泄露上一篇的内容）──
  await page.locator('.toc-row', { hasText: '另一篇' }).first().click()
  await page.waitForTimeout(800)
  const afterSwitch = await readSelection(client)
  rec.record(
    '切换笔记后旧快照失效（selection_invalidated，不返回上一篇的文本）',
    afterSwitch.status === 'selection_invalidated' && afterSwitch.selection === undefined,
    `status=${afterSwitch.status}`
  )

  // ── 只读性质：工具调用前后文件字节不变、编辑状态不变 ──
  const after = readFileSync(noteFile, 'utf8')
  rec.record(
    '工具调用前后磁盘文件不变（只读）',
    after.includes('第一段中文') && after.includes('最后一段。'),
    `bytes=${Buffer.byteLength(after)}`
  )

  // ── 令牌轮换 → 旧令牌与旧会话立刻失效 ──
  const rotated = await page.evaluate(async () => {
    const result = await window.desk.mcp.rotateToken()
    return result.ok ? result.value : null
  })
  rec.record(
    '重置令牌后返回新令牌',
    Boolean(rotated?.token) && rotated.token !== token,
    `same=${rotated?.token === token}`
  )
  const oldTokenStatus = await rawCall(
    { authorization: `Bearer ${token}` },
    '/mcp',
    'POST',
    initializeBody
  )
  rec.record('旧令牌立刻失效（401）', oldTokenStatus === 401, `status=${oldTokenStatus}`)
  const oldSessionRejected = await client
    .callTool({ name: TOOL, arguments: {} })
    .then(() => 'ok')
    .catch((error) => String(error?.message ?? error))
  rec.record(
    '旧会话不能继续读上下文（被服务端断开）',
    oldSessionRejected !== 'ok',
    `result=${oldSessionRejected.slice(0, 60)}`
  )
  const freshClient = await connect(rotated.token)
  const freshRead = await readSelection(freshClient)
  rec.record(
    '新令牌可以继续读取（结构化结果）',
    freshRead.status === 'selection_invalidated' || freshRead.status === 'no_selection',
    `status=${freshRead.status}`
  )
  await freshClient.close()

  // ── 关闭开关 → 停止服务、释放端口 ──
  const disabled = await page.evaluate(async () => {
    const result = await window.desk.mcp.setEnabled(false)
    return result.ok ? result.value : null
  })
  const portStatus = await rawCall(
    { authorization: `Bearer ${rotated.token}` },
    '/mcp',
    'POST',
    initializeBody
  )
    .then((value) => value)
    .catch(() => 'released')
  rec.record(
    '关闭开关后服务停止、端口释放',
    disabled?.running === false && portStatus === 'released',
    `running=${disabled?.running} port=${portStatus}`
  )

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
