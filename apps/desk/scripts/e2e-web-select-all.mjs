// 第 8 项界面验证：网页标签里的 Cmd+A 作用于该网页，不被笔记抢走。
//
// 全部依赖**本地 HTTP 测试页**（不访问外网）：
//   /body   正文可选中
//   /input  含输入框
//
// 路径是真实的：原生 WebContents 上触发 before-input-event → 主进程转发（带来源）→
// 渲染端按来源定位 → web.selectAll(该标签)。
//
// Run: node apps/desk/scripts/e2e-web-select-all.mjs
import { createServer } from 'node:http'
import { createFixture, createRecorder, launchDesk, openNote, trackPageErrors } from './e2e-lib.mjs'

const rec = createRecorder()

const PAGES = {
  '/body': `<!doctype html><html><body style="font-size:20px">
    <h1>WEB_TITLE</h1><p id="p">WEB_BODY_TEXT_SHOULD_BE_SELECTED</p>
  </body></html>`,
  '/input': `<!doctype html><html><body>
    <h1>INPUT_PAGE</h1>
    <input id="field" value="INPUT_VALUE_TEXT" />
  </body></html>`
}

const server = createServer((request, response) => {
  const page = PAGES[request.url] ?? '<!doctype html><html><body>EMPTY</body></html>'
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = (path) => `http://127.0.0.1:${port}${path}`

const fixture = createFixture('web-select-all', {
  notes: [
    { index: '0001', title: '甲', body: '# 甲\n\nNOTE_TEXT_A_SHOULD_BE_SELECTED\n' },
    { index: '0002', title: '乙', body: '# 乙\n\nNOTE_TEXT_B\n' }
  ]
})

const app = await launchDesk(fixture, { env: { DESK_E2E_EXPOSE_INTERNALS: '1' } })
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

/** 在原生网页视图上触发一次真实的 Cmd+A（走 before-input-event） */
const pressSelectAllInWeb = async (tabId) =>
  app.evaluate((_electron, id) => {
    const manager = globalThis.__deskWebContentsManager
    const contents = manager?.debugWebContents?.(id)
    if (!contents) return 'no-contents'
    contents.emit(
      'before-input-event',
      { preventDefault: () => undefined },
      {
        type: 'keyDown',
        key: 'a',
        meta: process.platform === 'darwin',
        control: process.platform !== 'darwin',
        alt: false,
        shift: false,
        isComposing: false
      }
    )
    return 'sent'
  }, tabId)

/** 网页视图内的选区信息（在主进程里对原生 WebContents 求值） */
const webSelection = async (tabId) =>
  app.evaluate(async (_electron, id) => {
    const manager = globalThis.__deskWebContentsManager
    const contents = manager?.debugWebContents?.(id)
    if (!contents) return null
    return contents.executeJavaScript(
      `(() => {
        const sel = document.getSelection();
        const active = document.activeElement;
        return {
          activeTag: active ? active.tagName : null,
          activeId: active && active.id ? active.id : null,
          selected: sel ? sel.toString().trim() : '',
          inputSelected: active && active.tagName === 'INPUT'
            ? active.value.substring(active.selectionStart, active.selectionEnd)
            : null
        };
      })()`
    )
  }, tabId)

/** 网页视图里聚焦某个元素（模拟"点击网页内容/输入框"） */
const focusInWeb = async (tabId, selector) =>
  app.evaluate(
    async (_electron, { id, sel }) => {
      const manager = globalThis.__deskWebContentsManager
      const contents = manager?.debugWebContents?.(id)
      if (!contents) return false
      await contents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) { el.focus(); } return Boolean(el); })()`
      )
      return true
    },
    { id: tabId, sel: selector }
  )

/** 渲染端笔记编辑器里的选区长度（判断有没有被误选） */
const noteSelectionLength = async () =>
  page.evaluate(() => {
    const sel = document.getSelection()
    if (!sel || !sel.anchorNode) return 0
    const root = document.querySelector('.ProseMirror')
    if (!root || !root.contains(sel.anchorNode)) return 0
    return sel.toString().trim().length
  })

const activeTabId = async () =>
  page.locator('.tab.selected, .tab[aria-selected="true"]').first().getAttribute('data-tab-id')

/** 新建网页标签（走真实界面按钮），返回 tabId */
const createWebTab = async () => {
  const newWeb = page.locator('button[aria-label="新建网页标签"]').first()
  await newWeb.click()
  await new Promise((resolve) => setTimeout(resolve, 1200))
  return activeTabId()
}

/** 在该网页标签里打开本地页（走渲染端的 web.navigate IPC） */
const navigateWeb = async (tabId, path) => {
  const result = await page.evaluate(
    async ({ id, target }) => {
      const res = await window.desk.web.navigate({ tabId: id, url: target })
      return res.ok ? 'ok' : res.error.message
    },
    { id: tabId, target: url(path) }
  )
  await new Promise((resolve) => setTimeout(resolve, 1200))
  return result
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '甲' })
  rec.record('笔记已打开', (await page.locator('.ProseMirror').count()) > 0)

  // ── 0. 先在笔记里建立基线：Cmd+A 全选笔记（回归）──
  await page.locator('.ProseMirror').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  const noteBefore = await noteSelectionLength()
  rec.record('笔记里 Cmd+A 仍全选笔记（回归）', noteBefore > 0, `noteSel=${noteBefore}`)

  // ── 1. 网页正文：Cmd+A 选中网页正文，不落到笔记 ──
  const bodyTab = await createWebTab()
  const loadBody = await navigateWeb(bodyTab, '/body')
  rec.record('本地测试页已加载（网页正文）', loadBody === 'ok', `tabId=${bodyTab} load=${loadBody}`)

  await focusInWeb(bodyTab, '#p')
  const sent1 = await pressSelectAllInWeb(bodyTab)
  await new Promise((resolve) => setTimeout(resolve, 700))
  const webBody = await webSelection(bodyTab)
  const noteAfter1 = await noteSelectionLength()
  rec.record(
    '网页正文：Cmd+A 选中网页正文',
    Boolean(webBody?.selected?.includes('WEB_BODY_TEXT')),
    `sent=${sent1} selected=${JSON.stringify(webBody?.selected?.slice(0, 60))}`
  )
  rec.record('网页正文：笔记没有被误选', noteAfter1 === 0, `noteSel=${noteAfter1}`)

  // ── 2. 网页输入框：Cmd+A 作用于输入框 ──
  const loadInput = await navigateWeb(bodyTab, '/input')
  rec.record('本地测试页已加载（输入框）', loadInput === 'ok', `load=${loadInput}`)
  await focusInWeb(bodyTab, '#field')
  const sent2 = await pressSelectAllInWeb(bodyTab)
  await new Promise((resolve) => setTimeout(resolve, 700))
  const webInput = await webSelection(bodyTab)
  const noteAfter2 = await noteSelectionLength()
  rec.record(
    '网页输入框：Cmd+A 选中输入框内容',
    webInput?.inputSelected === 'INPUT_VALUE_TEXT',
    `sent=${sent2} active=${webInput?.activeTag}#${webInput?.activeId} inputSel=${JSON.stringify(webInput?.inputSelected)}`
  )
  rec.record('网页输入框：笔记没有被误选', noteAfter2 === 0, `noteSel=${noteAfter2}`)

  // ── 3. 分屏：网页与笔记同时打开，全选各归其位 ──
  await navigateWeb(bodyTab, '/body')
  await page.locator('.toc-row', { hasText: '乙' }).first().click()
  await new Promise((resolve) => setTimeout(resolve, 600))
  const splitRight = page.locator('button[aria-label="向右拆分当前标签"]').first()
  if ((await splitRight.count()) > 0) {
    await splitRight.click()
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  const groupCount = await page.locator('.editor-group').count()
  rec.record('已进入分屏（两个编辑组）', groupCount >= 2, `groups=${groupCount}`)

  await focusInWeb(bodyTab, '#p')
  const sent3 = await pressSelectAllInWeb(bodyTab)
  await new Promise((resolve) => setTimeout(resolve, 700))
  const webSplit = await webSelection(bodyTab)
  const noteAfter3 = await noteSelectionLength()
  rec.record(
    '分屏：网页的 Cmd+A 仍作用于该网页',
    Boolean(webSplit?.selected?.includes('WEB_BODY_TEXT')),
    `sent=${sent3} selected=${JSON.stringify(webSplit?.selected?.slice(0, 40))}`
  )
  rec.record('分屏：笔记没有被误选', noteAfter3 === 0, `noteSel=${noteAfter3}`)

  // ── 4. 切换分组后：来源标签仍被正确定位 ──
  const noteTab = page.locator('.tab:has-text("乙")').first()
  if ((await noteTab.count()) > 0) {
    await noteTab.click()
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  await focusInWeb(bodyTab, '#p')
  const sent4 = await pressSelectAllInWeb(bodyTab)
  await new Promise((resolve) => setTimeout(resolve, 700))
  const webSwitched = await webSelection(bodyTab)
  const noteAfter4 = await noteSelectionLength()
  rec.record(
    '切换分组后：网页 Cmd+A 仍按来源定位',
    Boolean(webSwitched?.selected?.includes('WEB_BODY_TEXT')),
    `sent=${sent4} selected=${JSON.stringify(webSwitched?.selected?.slice(0, 40))}`
  )
  rec.record('切换分组后：笔记没有被误选', noteAfter4 === 0, `noteSel=${noteAfter4}`)

  // CSP 会拦本地页的 favicon 请求：那是 Chromium 对网页内部请求的噪音，
  // 与本次验证的"全选目标"无关，单独排除（其余异常仍算失败）。
  const realErrors = pageErrors.filter((text) => !text.includes('favicon.ico'))
  rec.record(
    '无未捕获页面异常（favicon CSP 噪音除外）',
    realErrors.length === 0,
    realErrors.join(' | ').slice(0, 200)
  )
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 500))
} finally {
  await app.close()
  server.closeAllConnections?.()
  server.close()
  fixture.cleanup()
}

rec.finish()
