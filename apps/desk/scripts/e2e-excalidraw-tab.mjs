// E4 真实 Electron 端到端：笔记里的画布图 → 画布标签页 → 编辑 → 自动写盘 → 重开一致，
// 外部改名/删除只报失效，资源面板重命名后标签跟随，关闭/退出前 flush。
// 需要先构建：pnpm --filter desk exec electron-vite build
// Run: node apps/desk/scripts/e2e-excalidraw-tab.mjs
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAcceptanceKb } from './acceptance-fixture.mjs'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-canvas-tab-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'acceptance-kb')
const assets = join(kb, 'assets')
const canvasPath = join(assets, '0004-drawing.excalidraw')
const backupPath = join(fixture, 'canvas-backup.excalidraw')
const shots = join(deskDir, 'scripts', 'shots', 'excalidraw-tab')
mkdirSync(workspace, { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })
await writeAcceptanceKb(kb)
const boundaryNote = join(kb, 'notes', '0004. 边界与断链.md')
writeFileSync(
  boundaryNote,
  readFileSync(boundaryNote, 'utf8').replace(
    '![画布](../assets/0004-drawing.excalidraw)',
    '![画布](../assets/0004-drawing.svg)'
  )
)
writeFileSync(
  join(assets, '0004-drawing.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>\n'
)
copyFileSync(canvasPath, backupPath)
writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'light',
    defaultNoteView: 'visual',
    prettier: false,
    autosave: { enabled: false, delayMs: 1000 }
  })
)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 磁盘上的画布内容是唯一真相源：写没写、写了几次都以文件为准。 */
function sceneAt(path = canvasPath) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const countAt = (path = canvasPath) => sceneAt(path)?.elements?.length ?? -1

async function waitFor(check, timeoutMs = 8000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['out/main/index.js', `--user-data-dir=${profile}`],
  cwd: deskDir,
  timeout: 60000,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    ELECTRON_DISABLE_SANDBOX: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
})

const pageErrors = []

try {
  const page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', (error) => pageErrors.push(String(error.message ?? error)))
  await page.waitForLoadState('domcontentloaded')

  const canvasTabs = () => page.locator('.tab', { hasText: '.excalidraw' })
  const canvasPane = () => page.locator('.excalidraw-pane:visible')
  const interactiveCanvas = () =>
    page.locator('.excalidraw-pane:visible .excalidraw__canvas.interactive')
  const paneStatus = () =>
    page.evaluate(
      () => document.querySelector('.excalidraw-pane .pane-status')?.textContent?.trim() ?? ''
    )

  const activateTab = async (label) => {
    await page.locator('.tab', { hasText: label }).first().click()
    await page.waitForTimeout(350)
  }
  const openAssetsPane = async () => {
    if (await page.locator('.kb-assets-pane:visible').count()) return
    await page.keyboard.press('ControlOrMeta+Shift+p')
    const palette = page.locator('.command-palette__input')
    await palette.waitFor({ timeout: 10000 })
    await palette.fill('>open-kb-assets')
    await page.locator('.command-palette__item', { hasText: '资源' }).first().click()
    await page.locator('.kb-assets-pane').waitFor({ timeout: 15000 })
  }
  const selectCanvasRow = async (name = '0004-drawing.excalidraw') => {
    const row = page.locator('.file-row', { hasText: `assets/${name}` }).first()
    await row.waitFor({ timeout: 30000 })
    await row.click()
  }
  const openCanvasTab = async () => {
    await page.locator('.toc-row', { hasText: '边界与断链' }).first().click()
    const editor = page.locator('.tab-content:visible .cm-content').first()
    await editor.waitFor({ timeout: 30000 })
    const image = page.locator('.tab-content:visible .cm-lp-image').first()
    await image.waitFor({ timeout: 30000 })
    await image.hover()
    const edit = page.locator('.tab-content:visible').getByRole('button', { name: '编辑', exact: true }).first()
    await edit.waitFor({ timeout: 30000 })
    await edit.click()
    await canvasPane().waitFor({ timeout: 30000 })
    await interactiveCanvas().waitFor({ timeout: 60000 })
    await page.waitForTimeout(700)
  }
  /**
   * 真实鼠标绘制。工具用工具栏按钮切换（`toolbar-rectangle`），不用快捷键：
   * 键盘路径依赖焦点，交接后的键盘撤销另有专门用例覆盖。
   *
   * 指针序列要放慢并带等待：Excalidraw 在 pointerdown 建元素、pointermove 调整
   * 尺寸、pointerup 提交，纯瞬时的合成拖拽会让 pointerup 落在提交条件之外。
   * 返回起点，方便调用方在提交前后取证据。
   */
  const beginRectangle = async (offset = 0) => {
    const box = await interactiveCanvas().boundingBox()
    const x = box.x + box.width * 0.5 + offset
    const y = box.y + box.height * 0.3 + offset
    await page.locator('[data-testid="toolbar-rectangle"]:visible').first().click({ force: true })
    await page.waitForTimeout(120)
    await page.mouse.move(x, y, { steps: 4 })
    await page.waitForTimeout(150)
    await page.mouse.down()
    await page.waitForTimeout(120)
    for (let step = 1; step <= 4; step += 1) {
      await page.mouse.move(x + step * 28, y + step * 18)
      await page.waitForTimeout(80)
    }
    return { x, y }
  }
  const drawRectangle = async (offset = 0) => {
    await beginRectangle(offset)
    await page.mouse.up()
  }
  // 打开知识库，并先开一个笔记标签备用（验证标签切换不影响画布）
  await page.getByText('acceptance-kb', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.locator('.toc-row', { hasText: '重复与合并' }).first().click()
  await page.locator('.tab-content:visible .cm-content').first().waitFor({ timeout: 30000 })

  // 1) 笔记里的画布图「编辑」→ 独立标签页 + 编辑器真正渲染
  const beforeOpen = readFileSync(canvasPath, 'utf8')
  await openCanvasTab()
  record(
    '笔记入口：.excalidraw 生成独立标签页并渲染编辑器',
    (await canvasTabs().count()) === 1 &&
      (await canvasPane().locator('.excalidraw__canvas').count()) >= 1,
    `tabs=${await canvasTabs().count()}`
  )
  await page.waitForTimeout(1200)
  record(
    '打开不做多余写盘：只读打开后文件字节不变',
    readFileSync(canvasPath, 'utf8') === beforeOpen,
    `elements=${countAt()}`
  )
  // 官方字体走本地协议：CSP 只允许 self/data，缺这一步画布文本会回退字体
  const fontProbe = await page.evaluate(async () => {
    const url = new URL(
      'fonts/Xiaolai/Xiaolai-Regular-019d66dcad46dc156b162d267f981c20.woff2',
      'tnotes-asset://app/excalidraw/'
    ).toString()
    try {
      const face = new FontFace('DeskCanvasFontProbe', `url(${url})`)
      await face.load()
      return { loaded: true, url }
    } catch (error) {
      return { loaded: false, url, error: String(error) }
    }
  })
  record(
    '画布字体走本地资源协议（离线可用，不依赖 CDN）',
    fontProbe.loaded === true,
    JSON.stringify(fontProbe)
  )
  // 跟随应用主题：切到深色后画布容器带 theme--dark，且主题不进持久化内容
  const canvasHasDarkTheme = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.excalidraw-pane .excalidraw')].some((node) =>
        node.classList.contains('theme--dark')
      )
    )
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.waitForTimeout(600)
  const darkTheme = await canvasHasDarkTheme()
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await page.waitForTimeout(600)
  const lightTheme = await canvasHasDarkTheme()
  record(
    '跟随应用主题：切深色画布跟到 theme--dark，切回浅色恢复',
    darkTheme === true && lightTheme === false,
    `dark=${darkTheme} light=${lightTheme}`
  )
  record('主题切换不写盘（主题不属于持久化内容）', readFileSync(canvasPath, 'utf8') === beforeOpen)
  await page.screenshot({ path: join(shots, 'opened.png') })

  // 2) 同一文件再次从笔记「编辑」→ 定位已有标签，不产生第二个会话
  await openCanvasTab()
  record(
    '同一文件去重：再次打开仍是 1 个画布标签页',
    (await canvasTabs().count()) === 1,
    `tabs=${await canvasTabs().count()}`
  )

  // 3) 画一个矩形 → 自动写盘（没有保存按钮）
  await activateTab('.excalidraw')
  await drawRectangle()
  const drawn = await waitFor(() => countAt() === 2)
  record(
    '编辑自动写盘：画布变化后 assets/*.excalidraw 立即更新（元素 1 → 2）',
    Boolean(drawn),
    `elements=${countAt()}`
  )
  // 磁盘已经写完了，状态条文案可能还停在「待写入…」：等它变成已保存再断言（CI 上偶发差一拍）
  const savedStatus = await waitFor(async () => (await paneStatus()).includes('已自动保存'), 8000)
  record('状态条显示已自动保存', Boolean(savedStatus), `状态=${JSON.stringify(await paneStatus())}`)
  await page.screenshot({ path: join(shots, 'drawn.png') })

  // 4) 关闭再打开：重开后继续画 → 3 个元素，说明旧内容被正确载入
  await page.locator('.tab', { hasText: '.excalidraw' }).first().locator('.tab-close').click()
  await waitFor(async () => (await canvasTabs().count()) === 0)
  await openCanvasTab()
  await drawRectangle(40)
  const reopened = await waitFor(() => countAt() === 3)
  record(
    '重开内容一致：重新打开后继续编辑，之前的元素仍在（2 → 3）',
    Boolean(reopened),
    `elements=${countAt()}`
  )

  // 5) 切到笔记再切回：场景与撤销历史都要保留（宿主交接 + 键盘焦点重建）
  await activateTab('重复与合并')
  await page.locator('.milkdown:visible').first().waitFor({ timeout: 30000 })
  await activateTab('.excalidraw')
  await page.waitForTimeout(400)
  await page.keyboard.press('ControlOrMeta+z')
  let undoRoute = 'CDP 键盘 Cmd+Z'
  let undoneByKeyboard = await waitFor(() => countAt(canvasPath) === 2, 3000)
  if (!undoneByKeyboard) {
    // 原生输入路径：应用菜单里的 role:'undo' 会抢 Cmd+Z，这里分辨是「焦点没送到」
    // 还是「只有合成事件能到」
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      contents?.focus()
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
      contents?.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers })
      contents?.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers })
    })
    if (await waitFor(() => countAt(canvasPath) === 2, 3000)) {
      undoneByKeyboard = true
      undoRoute = '原生输入 Cmd+Z'
    }
  }
  record(
    '标签切换后交接：键盘快捷键送达画布（焦点重建到位，3 → 2）',
    Boolean(undoneByKeyboard),
    `elements=${countAt(canvasPath)}，生效路径：${undoRoute}`
  )

  // 历史本身：交接后再画一笔，用工具栏撤销按钮确认历史没被重建清掉
  await drawRectangle(200)
  await waitFor(() => countAt(canvasPath) === 3)
  const undoButton = page.locator('[data-testid="button-undo"]:visible').first()
  let undoneByButton = false
  if ((await undoButton.count()) > 0 && (await undoButton.isEnabled())) {
    await undoButton.click()
    undoneByButton = Boolean(await waitFor(() => countAt(canvasPath) === 2, 5000))
  }
  record(
    '交接后撤销历史仍在（工具栏按钮可撤销交接前的绘制）',
    undoneByButton,
    `elements=${countAt(canvasPath)}`
  )

  // 5b) 拆分不复制画布标签：同一文件永远只有一个编辑会话（单文件单写者）
  await page.getByRole('button', { name: '向右拆分当前标签', exact: true }).click()
  await page.waitForTimeout(800)
  await interactiveCanvas().waitFor({ timeout: 30000 })
  record(
    '拆分画布标签：只搬移不复制（全窗口仍然只有一个画布标签）',
    (await canvasTabs().count()) === 1,
    `tabs=${await canvasTabs().count()}`
  )

  // 6) 外部改名：只报失效，不按旧路径重建
  const renamedByHand = join(assets, '0004-drawing-renamed.excalidraw')
  renameSync(canvasPath, renamedByHand)
  await activateTab('重复与合并')
  await activateTab('.excalidraw')
  const invalidOnRename = await waitFor(
    async () => (await canvasPane().innerText()).includes('无法打开画布'),
    8000
  )
  record(
    '外部改名：画布标签显示失效状态（不自动重建空画布）',
    Boolean(invalidOnRename) && !existsSync(canvasPath),
    `旧路径存在=${existsSync(canvasPath)}`
  )
  await page.screenshot({ path: join(shots, 'invalid-after-rename.png') })
  renameSync(renamedByHand, canvasPath)

  // 7) 外部删除：同样只报失效
  rmSync(canvasPath)
  await activateTab('重复与合并')
  await activateTab('.excalidraw')
  const invalidOnDelete = await waitFor(
    async () => (await canvasPane().innerText()).includes('无法打开画布'),
    8000
  )
  record('外部删除：显示失效状态且不重建文件', Boolean(invalidOnDelete) && !existsSync(canvasPath))

  // 失效状态不可编辑：画布区域被占位层覆盖，拖拽不产生写入
  const invalidBox = await interactiveCanvas()
    .boundingBox()
    .catch(() => null)
  if (invalidBox) {
    await page.mouse.move(
      invalidBox.x + invalidBox.width * 0.5,
      invalidBox.y + invalidBox.height * 0.3
    )
    await page.mouse.down()
    await page.mouse.move(
      invalidBox.x + invalidBox.width * 0.5 + 80,
      invalidBox.y + invalidBox.height * 0.4
    )
    await page.mouse.up()
    await page.waitForTimeout(600)
  }
  record(
    '失效状态不可编辑：拖拽不写入、文件仍不存在',
    !existsSync(canvasPath),
    `文件存在=${existsSync(canvasPath)}`
  )
  copyFileSync(backupPath, canvasPath)

  // 失效标签要恢复编辑必须重新打开（产品路径：文件回来后重开标签）
  await page.locator('.tab', { hasText: '.excalidraw' }).first().locator('.tab-close').click()
  await waitFor(async () => (await canvasTabs().count()) === 0)
  await openCanvasTab()

  // 8) 资源面板对画布源文件保持保护：重命名入口直接置灰（不再让人填完表单才被拒），
  //    回收仍走计划并在预览里明确拒绝，两条路都不会悄悄移动文件、让已打开的标签指向
  //    一个不存在的路径
  await openAssetsPane()
  await selectCanvasRow()
  const renameState = await page.locator('[data-asset-rename-state]').innerText()
  const renameReason = (await page.locator('[data-asset-rename]').getAttribute('title')) ?? ''
  const renameDisabled = await page.locator('[data-asset-rename]').isDisabled()
  record(
    '资源面板保护画布真相源：重命名入口置灰且说明原因',
    renameDisabled && renameState.includes('已阻止') && renameReason.includes('归属编号'),
    `禁用=${renameDisabled} 状态=${JSON.stringify(renameState.trim().slice(0, 40))} 原因=${JSON.stringify(renameReason.slice(0, 40))}`
  )
  await page.getByRole('button', { name: '移入回收区', exact: true }).click()
  // 回收对话框打开即已在主进程生成计划（没有单独的「预览」按钮），拒绝原因直接列出
  const blockedText = await page
    .locator('.kb-assets-dialog .blocked')
    .innerText({ timeout: 15000 })
    .catch(() => '')
  const applyDisabled = await page
    .locator('.kb-assets-dialog footer .save-button')
    .first()
    .isDisabled()
    .catch(() => true)
  await page.getByRole('button', { name: '关闭', exact: true }).first().click()
  record(
    '资源面板保护画布真相源：回收被明确拒绝（不会移动文件）',
    blockedText.includes('Excalidraw 真相源') && applyDisabled,
    `blocked=${JSON.stringify(blockedText.slice(0, 60))} 执行禁用=${applyDisabled}`
  )
  await page.locator('.kb-assets-dialog').waitFor({ state: 'detached', timeout: 10000 })
  record(
    '被拒绝后文件与标签仍在原路径，内容可继续编辑',
    existsSync(canvasPath) && (await canvasTabs().count()) === 1
  )
  await page.screenshot({ path: join(shots, 'rename-blocked.png') })

  // 9) 关闭标签前 flush：防抖未到点也要写出去，且不弹保存确认
  await activateTab('.excalidraw')
  let pendingOnClose = null
  let closedFlush = false
  for (let attempt = 0; attempt < 3 && !closedFlush; attempt += 1) {
    const before = countAt(canvasPath)
    await beginRectangle(160 + attempt * 40)
    await page.mouse.up()
    const status = await paneStatus()
    pendingOnClose = { before, status }
    if (countAt(canvasPath) !== before) continue // 防抖已落盘：再画一笔重来
    await page.locator('.tab', { hasText: '.excalidraw' }).first().locator('.tab-close').click()
    const written = await waitFor(() => countAt(canvasPath) === before + 1, 8000)
    closedFlush = Boolean(written) && (await canvasTabs().count()) === 0
  }
  record(
    '关闭画布标签：未写完的内容先 flush 落盘再关闭（无保存确认）',
    closedFlush,
    `关闭前=${pendingOnClose?.before} 状态「${pendingOnClose?.status}」→ elements=${countAt(canvasPath)}`
  )

  // 10) 退出：仍在待写的内容必须落盘，且不弹「未保存」对话框
  await openCanvasTab('0004-drawing.excalidraw')
  let quitFlush = false
  let pendingOnQuit = null
  let dialogCount = -1
  let windowsLeft = 1
  for (let attempt = 0; attempt < 3 && !quitFlush; attempt += 1) {
    const before = countAt(canvasPath)
    await beginRectangle(200 + attempt * 40)
    await page.mouse.up()
    const status = await paneStatus()
    pendingOnQuit = { before, status }
    if (countAt(canvasPath) !== before) continue // 防抖已落盘：再画一笔重来
    await app.evaluate(({ BrowserWindow, dialog }) => {
      const calls = { count: 0 }
      dialog.showMessageBox = async () => {
        calls.count += 1
        return { response: 1, checkboxChecked: false }
      }
      globalThis.__canvasDialogCalls = calls
      BrowserWindow.getAllWindows()[0]?.close()
    })
    const written = await waitFor(() => countAt(canvasPath) === before + 1, 15000)
    for (let poll = 0; poll < 40 && windowsLeft > 0; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      windowsLeft = await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
        .catch(() => 0)
    }
    dialogCount = await app
      .evaluate(() => globalThis.__canvasDialogCalls?.count ?? -1)
      .catch(() => -1)
    quitFlush = Boolean(written)
  }
  record(
    '退出前 flush：待写内容落盘（关闭标签与退出都不会丢）',
    quitFlush,
    `退出前=${pendingOnQuit?.before} 状态「${pendingOnQuit?.status}」→ elements=${countAt(canvasPath)}`
  )
  record(
    '正常自动写盘不弹保存确认，退出不被对话框拦住',
    dialogCount === 0 && windowsLeft === 0,
    `对话框次数=${dialogCount}，剩余窗口=${windowsLeft}`
  )
  record('全流程无页面错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
} catch (error) {
  record('运行未完成（未捕获异常）', false, String(error).split('\n')[0])
  throw error
} finally {
  await app.close().catch(() => {})
  if (!process.env.KEEP_FIXTURE) rmSync(fixture, { recursive: true, force: true })
  const passed = results.length > 0 && results.every((item) => item.ok)
  console.log(`\n${passed ? 'ALL PASS' : 'HAS FAILURES'}（${results.length} 项）`)
  console.log(`screenshots: ${shots}`)
  process.exitCode = passed ? 0 : 1
}
