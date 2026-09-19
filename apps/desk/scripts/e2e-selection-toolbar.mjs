// 第 5 项验收：选区浮动工具条（`.milkdown-toolbar`）开关，默认关闭。
//
// 覆盖：
//   0. 老 profile（配置文件里没有 `editor` 分组）→ 新字段落到默认 false（升级路径）；
//   1. 默认关闭：选中正文后浮条不出现，而且浮层不占位、不拦截指针事件；
//   2. 设置面板「编辑器」组里的开关默认未勾选，打开后写入配置文件；
//   3. 打开后：选中正文 → 浮条出现；
//   4. 重启同一个 fixture/profile → 开关仍为开、浮条仍出现；
//   5. 改回关闭 → 持久化为 false，选中正文不再出现浮条。
//
// 全程使用隔离的临时工作区与隔离 profile，不碰用户真实数据。
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-selection-toolbar.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createFixture, createRecorder, launchDesk, openNote } from './e2e-lib.mjs'

const rec = createRecorder()
const NOTE_TITLE = '选区工具条'
const fixture = createFixture('selection-toolbar', {
  notes: [
    {
      index: '0001',
      title: NOTE_TITLE,
      body: `# 0001. ${NOTE_TITLE}\n\n这是一段用于验证选区浮动工具条的中文正文内容，足够长以便选中。\n`
    }
  ]
})

const configPath = join(fixture.profile, '.tn-desk-config.json')
const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'))

// 自计时上限（macOS 没有 timeout 命令）：跑飞时必须留下已通过的部分并强制收尾。
const HARD_LIMIT_MS = 5 * 60_000
let hardLimitHit = false
let forceExitTimer = null
const hardLimitTimer = setTimeout(() => {
  hardLimitHit = true
  console.log(`FAIL  自计时上限 ${HARD_LIMIT_MS}ms 到了，强制收尾`)
  forceExitTimer = setTimeout(() => {
    console.log('FAIL  收尾超时，强制退出')
    process.exit(1)
  }, 20_000)
}, HARD_LIMIT_MS)

/** 与 e2e-lib 的 waitFor 同语义，额外遵守自计时上限。 */
async function waitFor(check, timeoutMs = 10_000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (hardLimitHit) return null
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function openExample() {
  const app = await launchDesk(fixture)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await openNote(page, { kbName: fixture.kbName, title: NOTE_TITLE })
  await page.locator('.ProseMirror p').first().waitFor({ timeout: 20_000 })
  return { app, page }
}

/** 真实鼠标三击选中正文段落，返回选区文本与编辑器焦点状态。 */
async function selectBodyText(page) {
  const paragraph = page.locator('.ProseMirror p').first()
  await paragraph.click({ clickCount: 3 })
  await page.waitForTimeout(150)
  return page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror')
    return {
      text: window.getSelection()?.toString() ?? '',
      focused: Boolean(pm?.classList.contains('ProseMirror-focused'))
    }
  })
}

/**
 * 浮条的「实际可见性」：不只看 DOM 是否存在，而是看计算样式与尺寸 ——
 * `display:none` 的元素既不可见，也不会参与命中测试（不会拦截指针事件）。
 */
const toolbarState = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.milkdown-toolbar')
    if (!el) {
      return {
        present: false,
        dataShow: null,
        display: null,
        visibility: null,
        width: 0,
        height: 0,
        visible: false
      }
    }
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      present: true,
      dataShow: el.getAttribute('data-show'),
      display: style.display,
      visibility: style.visibility,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible:
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
    }
  })

/** 浮条是否真的会吃掉它覆盖位置上的指针事件。 */
const toolbarHitTestable = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.milkdown-toolbar')
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
    const hit = document.elementFromPoint(x, y)
    return Boolean(hit && (hit === el || el.contains(hit)))
  })

const toolbarCheckbox = (page) =>
  page.locator('[data-setting="selection-toolbar"] input[type="checkbox"]')

async function openEditorSettings(page) {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  const palette = page.locator('.command-palette__input')
  await palette.waitFor({ timeout: 15_000 })
  await palette.fill('>open-settings')
  await page.locator('.command-palette__item', { hasText: '设置' }).first().click()
  await page.locator('.settings-panel').waitFor({ timeout: 15_000 })
  await page.locator('.settings-nav .nav-item', { hasText: '编辑器' }).click()
  await page.locator('[data-setting="selection-toolbar"]').waitFor({ timeout: 10_000 })
}

async function closeSettings(page) {
  await page.locator('[aria-label="关闭设置"]').click()
  await page.locator('.settings-panel').waitFor({ state: 'detached', timeout: 10_000 })
}

const configFlag = () => {
  try {
    return readConfig()?.editor?.selectionToolbar
  } catch {
    return undefined
  }
}

let app = null
try {
  // 阶段 0：升级等价场景 —— profile 里没有 editor 分组。
  rec.record(
    '升级等价场景：老 profile 配置里没有 editor 分组',
    !('editor' in readConfig()),
    `editor=${JSON.stringify(readConfig().editor ?? null)}`
  )

  let instance = await openExample()
  app = instance.app
  let page = instance.page

  // 阶段 1：默认关闭。
  let selected = await selectBodyText(page)
  await page.waitForTimeout(900) // 若开关其实生效，这点时间足够浮条弹出
  let state = await toolbarState(page)
  rec.record(
    '默认关闭：选中正文文字后选区浮条不出现（computed visibility）',
    selected.text.length > 0 && selected.focused && !state.visible,
    `选中「${selected.text.slice(0, 10)}」 focused=${selected.focused} state=${JSON.stringify(state)}`
  )
  rec.record(
    '默认关闭：浮条不占位也不拦截指针事件',
    (state.display === 'none' || !state.present) && !(await toolbarHitTestable(page)),
    `present=${state.present} display=${state.display} 可命中=${await toolbarHitTestable(page)}`
  )
  rec.record(
    '默认关闭：data-show 不是 true',
    state.dataShow !== 'true',
    `data-show=${state.dataShow}`
  )

  await openEditorSettings(page)
  const defaultChecked = await toolbarCheckbox(page).isChecked()
  rec.record('设置面板「编辑器」组的开关默认未勾选', !defaultChecked, `checked=${defaultChecked}`)

  // 阶段 2：打开开关（走真实设置 UI）。
  await toolbarCheckbox(page).check()
  const persistedOn = await waitFor(() => configFlag() === true, 10_000)
  rec.record(
    '打开开关后立即持久化到配置文件',
    Boolean(persistedOn),
    `editor=${JSON.stringify(readConfig().editor)}`
  )
  await closeSettings(page)

  selected = await selectBodyText(page)
  const shownAfterEnable = await waitFor(async () => (await toolbarState(page)).visible, 8_000)
  rec.record(
    '开启后：选中文字 → 浮条出现',
    Boolean(shownAfterEnable) && selected.text.length > 0,
    `选中「${selected.text.slice(0, 10)}」 state=${JSON.stringify(await toolbarState(page))}`
  )

  // 阶段 3：重启同一个 fixture/profile。
  await app.close()
  instance = await openExample()
  app = instance.app
  page = instance.page

  await openEditorSettings(page)
  const checkedAfterRestart = await toolbarCheckbox(page).isChecked()
  rec.record('重启后设置面板里的开关仍为开', checkedAfterRestart, `checked=${checkedAfterRestart}`)
  await closeSettings(page)

  selected = await selectBodyText(page)
  const shownAfterRestart = await waitFor(async () => (await toolbarState(page)).visible, 8_000)
  rec.record(
    '重启后：选中文字 → 浮条仍出现（开关已持久化）',
    Boolean(shownAfterRestart),
    `state=${JSON.stringify(await toolbarState(page))}`
  )

  // 阶段 4：改回关闭。
  await openEditorSettings(page)
  await toolbarCheckbox(page).uncheck()
  const persistedOff = await waitFor(() => configFlag() === false, 10_000)
  rec.record(
    '改回关闭后持久化为 false',
    Boolean(persistedOff),
    `editor=${JSON.stringify(readConfig().editor)}`
  )
  await closeSettings(page)

  // 关掉开关后即使不重新选区，也不应该还挂着上一次选区留下的浮条。
  state = await toolbarState(page)
  rec.record(
    '改回关闭后：未重新选区时已显示的浮条也收起了',
    !state.visible,
    `state=${JSON.stringify(state)}`
  )

  selected = await selectBodyText(page)
  await page.waitForTimeout(900)
  state = await toolbarState(page)
  rec.record(
    '改回关闭后：选中文字 → 浮条不再出现',
    selected.text.length > 0 && !state.visible,
    `选中「${selected.text.slice(0, 10)}」 state=${JSON.stringify(state)}`
  )

  await app.close()
  app = null
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
} finally {
  clearTimeout(hardLimitTimer)
  if (forceExitTimer) clearTimeout(forceExitTimer)
  if (app) await app.close().catch(() => undefined)
  fixture.cleanup()
}

rec.finish()
