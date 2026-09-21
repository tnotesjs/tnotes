// 源码视图（Monaco）跨行选区背景越界：反向跨行选择时，选区起点**左侧 10px** 会露出一块
// 选区蓝色，盖住本来没被选中的字。
//
// 根因（Monaco 源码 + 界面实测，本套件自己就能复现对照）：
// `SelectionsOverlay` 画选区圆角时，会先在范围左侧多画 10px 的**选区色块**
// （`.cslr.selected-text`，`ROUNDED_PIECE_WIDTH = 10`），再用一个带
// `monaco-editor-background` 类的**遮罩**（`.cslr.monaco-editor-background`，反圆角）盖住多余部分。
// Desk 的 `.markdown-source-editor :deep(.monaco-editor .monaco-editor-background) { background: inherit }`
// 把遮罩一起变成透明（计算值 `rgba(0, 0, 0, 0)`），于是那 10px 蓝块原样露出来。
// 修法：把覆盖收窄成 `:not(.cslr)`，遮罩保留主题背景色。
//
// 断言用**像素**（sharp 解 Playwright 截图）+ 计算样式，并按验收要求做前后对照：
// 运行中临时注入旧的覆盖样式，蓝块必须复现；移除后必须消失。
//
// Run: node apps/desk/scripts/e2e-source-selection-background.mjs
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import sharp from 'sharp'

import {
  createFixture,
  createRecorder,
  deskDir,
  launchDesk,
  openNote,
  trackPageErrors,
  waitFor
} from './e2e-lib.mjs'

const rec = createRecorder()

/**
 * 用户复现里的那一段。首行是**中英混排长句**（在标准页宽下折行，覆盖换行边界），
 * 放在选区上方：`ArrowUp/Down` 走的是**可见行**，长句若夹在选区里会让"按几次方向键"
 * 落点不可预测（实测会多选出一个折行段）。
 */
const BODY = [
  'A very long mixed line with 中文与 English 混排，用来把可见行折成多段以覆盖换行边界。',
  '输入: num = 38',
  '输出: 2',
  '解释: 各位相加的过程为：',
  '38 --> 3 + 8 --> 11',
  '11 --> 1 + 1 --> 2',
  '由于 2 是一位数，所以返回 2。',
  ''
]
/**
 * 反向（下→上）选择落在「输出: 2」行**末尾**：那一行的字**不在**选区里
 * （用户复现里"实际选区不包含首行的 2"就是这个意思），所以期望文本少一行字。
 * 正向（上→下）从行首开始，包含这一行。
 */
const BACKWARD_SELECTED = `\n${BODY.slice(3, 7).join('\n')}`
const FORWARD_SELECTED = BODY.slice(2, 7).join('\n')

const fixture = createFixture('src-selection-bg', {
  notes: [{ index: '0001', title: '选择', body: BODY.join('\n') }]
})
const noteFile = fixture.notePath('0001', '选择')
const shots = join(deskDir, 'scripts', 'shots', 'source-selection-background')
mkdirSync(shots, { recursive: true })

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

/** 反向选择：光标放到最后一行末尾，再 Shift+Up 到「输出: 2」那一行 */
const selectBackward = async () => {
  const lastLine = page
    .locator('.markdown-source-editor .view-line', { hasText: '由于 2 是一位数' })
    .first()
  await lastLine.click()
  await page.keyboard.press('End')
  await page.keyboard.down('Shift')
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowUp')
  await page.keyboard.up('Shift')
  await page.waitForTimeout(300)
}

/** 正向选择：「输出: 2」行首 → 向下 4 行到行末 */
const selectForward = async () => {
  const first = page.locator('.markdown-source-editor .view-line', { hasText: '输出: 2' }).first()
  await first.click()
  await page.keyboard.press('Home')
  await page.keyboard.down('Shift')
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.up('Shift')
  await page.waitForTimeout(300)
}

/** 量取选区装饰：选区块（selected-text）、遮罩（monaco-editor-background）与主题色 */
const measure = async () =>
  page
    .locator('.markdown-source-editor')
    .first()
    .evaluate((root) => {
      const info = (el) => {
        const r = el.getBoundingClientRect()
        return {
          cls: String(el.className).replace('cslr ', ''),
          bg: getComputedStyle(el).backgroundColor,
          isMask: el.classList.contains('monaco-editor-background'),
          isSelection: el.classList.contains('selected-text'),
          left: Math.round(r.left),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
      }
      const pieces = [...root.querySelectorAll('.cslr')].map(info)
      const editor = root.querySelector('.monaco-editor')
      return {
        pieces,
        editorBg: editor ? getComputedStyle(editor).backgroundColor : null,
        selectionColor: editor
          ? getComputedStyle(editor).getPropertyValue('--vscode-editor-selectionBackground').trim()
          : ''
      }
    })

/**
 * 反向圆角带 = 10px 宽的选区色块，且**同一位置**有遮罩（`ROUNDED_PIECE_WIDTH = 10`）。
 * 这正是"多画的 10px 蓝块 + 遮罩"那一对；取它左边缘采样像素就能看出遮罩盖没盖住。
 */
const bandsOf = (measured) =>
  measured.pieces
    .filter(
      (piece) =>
        piece.isSelection &&
        piece.width === 10 &&
        measured.pieces.some(
          (other) =>
            other.isMask &&
            other.left === piece.left &&
            other.top === piece.top &&
            other.width === 10
        )
    )
    .map((piece) => {
      const mask = measured.pieces.find(
        (other) => other.isMask && other.left === piece.left && other.top === piece.top
      )
      return { ...piece, maskBg: mask?.bg ?? null }
    })

const rawShot = async () => {
  const shot = await page.screenshot()
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
  const dpr = await page.evaluate(() => window.devicePixelRatio)
  const stride = info.width * info.channels
  return {
    info,
    dpr,
    at: (x, y) => {
      const offset = Math.round(y * dpr) * stride + Math.round(x * dpr) * info.channels
      return [data[offset], data[offset + 1], data[offset + 2]]
    }
  }
}

const samplePixels = async (points) => {
  const shot = await rawShot()
  return points.map((point) => ({ ...point, rgb: shot.at(point.x, point.y) }))
}

/** 统计某个矩形里与目标色相同的像素数（用于"选区仍然画出来了"的对照） */
const countPixelsLike = async (rect, targetRgb) => {
  const shot = await rawShot()
  let count = 0
  const step = 2
  for (let y = rect.top + 1; y < rect.top + rect.height - 1; y += step) {
    for (let x = rect.left + 1; x < rect.left + rect.width - 1; x += step) {
      const rgb = shot.at(x, y)
      if (targetRgb.every((value, index) => Math.abs(value - rgb[index]) <= 2)) count += 1
    }
  }
  return count
}

const rgbOf = (css) => {
  const value = (css ?? '').trim()
  // Monaco 把主题色写成 CSS 变量，取出来可能是十六进制（实测 --vscode-editor-selectionBackground
  // 解析成 `#add6ff`），所以两种写法都要认。
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((char) => char + char)
            .join('')
        : hex[1]
    return [0, 2, 4].map((index) => Number.parseInt(digits.slice(index, index + 2), 16))
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(value)
  if (!match) return null
  const parts = match[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number)
  return parts.slice(0, 3)
}

const sameRgb = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.every((value, index) => Math.abs(value - b[index]) <= 2)

const transparent = (css) => /rgba\(0, 0, 0, 0\)|transparent/.test(css ?? '')

const setTheme = async (theme) => {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value
  }, theme)
  await page.waitForTimeout(400)
}

/** 临时把旧的覆盖样式注入回来（对照实验）；返回移除函数 */
const injectLegacyOverride = async () => {
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.id = 'e2e-legacy-selection-mask-override'
    // !important 才能压过应用里那条带 scope 属性的同族规则
    style.textContent =
      '.markdown-source-editor .monaco-editor .monaco-editor-background { background: inherit !important; }'
    document.head.append(style)
  })
  await page.waitForTimeout(400)
  return async () => {
    await page.evaluate(() =>
      document.getElementById('e2e-legacy-selection-mask-override')?.remove()
    )
    await page.waitForTimeout(400)
  }
}

const checkScenario = async (theme, select, expectedSelectionText) => {
  await setTheme(theme)
  await select()
  const measured = await measure()
  const bands = bandsOf(measured)
  rec.record(
    `${theme}：反向圆角带（10px 选区块 + 遮罩成对）已被触发`,
    bands.length > 0,
    `bands=${bands.length} pieces=${measured.pieces.length}`
  )

  rec.record(
    `${theme}：遮罩保留主题背景色（不是透明）`,
    bands.length > 0 && bands.every((band) => !transparent(band.maskBg)),
    `maskBg=${JSON.stringify([...new Set(bands.map((band) => band.maskBg))])}`
  )

  const editorBg = rgbOf(measured.editorBg)
  const selectionBg = rgbOf(measured.selectionColor)
  const samples = await samplePixels(
    bands.map((band) => ({
      name: `band@${band.left},${band.top}`,
      x: band.left + 2,
      y: band.top + band.height / 2
    }))
  )
  rec.record(
    `${theme}：蓝块不再露出（带子左边缘像素 = 编辑器背景）`,
    samples.length > 0 && samples.every((sample) => sameRgb(sample.rgb, editorBg)),
    `editor=${JSON.stringify(editorBg)} samples=${JSON.stringify(samples.map((s) => s.rgb))}`
  )

  // 对照：选区内部仍然是选区色（改遮罩不能把选区本身弄丢）
  const selectionPieces = measured.pieces.filter(
    (piece) => piece.isSelection && piece.width > 10 && piece.height > 10
  )
  const widest = selectionPieces.reduce(
    (best, piece) => (piece.width > (best?.width ?? 0) ? piece : best),
    null
  )
  const painted = widest ? await countPixelsLike(widest, selectionBg) : 0
  rec.record(
    `${theme}：选区内部仍然是选区色`,
    painted > 50,
    `selection=${JSON.stringify(selectionBg)} 命中像素=${painted}`
  )

  // 前后对照：临时恢复旧的覆盖样式，蓝块必须复现
  const uninstall = await injectLegacyOverride()
  const legacy = await measure()
  const legacyBands = bandsOf(legacy)
  const legacySamples = await samplePixels(
    legacyBands.map((band) => ({
      name: `legacy@${band.left},${band.top}`,
      x: band.left + 2,
      y: band.top + band.height / 2
    }))
  )
  rec.record(
    `${theme}：对照实验 —— 恢复旧覆盖后蓝块复现（证明根因）`,
    legacyBands.length > 0 &&
      legacyBands.every((band) => transparent(band.maskBg)) &&
      legacySamples.some((sample) => sameRgb(sample.rgb, selectionBg)),
    `maskBg=${JSON.stringify([...new Set(legacyBands.map((band) => band.maskBg))])} pixels=${JSON.stringify(legacySamples.map((s) => s.rgb))}`
  )
  await uninstall()

  await page.screenshot({ path: join(shots, `selection-${theme}.png`) })

  if (!expectedSelectionText) return
  // 剪切 / 撤销必须严格对应实际选区（改的是 CSS，编辑语义不许受影响）
  await page.keyboard.press('ControlOrMeta+x')
  const cutText = await waitFor(
    async () => app.evaluate(({ clipboard }) => clipboard.readText()),
    5000
  )
  rec.record(
    `${theme}：剪切内容严格等于实际选区`,
    cutText === expectedSelectionText,
    `len=${cutText?.length} expected=${expectedSelectionText.length} tail=${JSON.stringify(cutText?.slice(-12))}`
  )
  await page.keyboard.press('ControlOrMeta+z')
  await page.waitForTimeout(600)
  const restored = await page
    .locator('.markdown-source-editor')
    .first()
    .evaluate((root) =>
      [...root.querySelectorAll('.view-line')]
        .map((node) => (node.textContent ?? '').replace(/\u00a0/g, ' '))
        .join('\n')
    )
  rec.record(
    `${theme}：一次撤销恢复整段内容`,
    restored.includes('输出: 2') && restored.includes('由于 2 是一位数'),
    `hasOutput=${restored.includes('输出: 2')} 前 80 字=${JSON.stringify(restored.slice(0, 80))}`
  )
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '选择' })
  await page
    .getByRole('button', { name: '源码视图', exact: true })
    .filter({ visible: true })
    .first()
    .click()
  const ready = await waitFor(
    async () => (await page.locator('.markdown-source-editor .view-lines').count()) > 0,
    20000
  )
  rec.record('源码视图已打开（Monaco 文本层就绪）', Boolean(ready))

  const before = readFileSync(noteFile, 'utf8')
  await checkScenario('light', selectBackward, BACKWARD_SELECTED)
  await checkScenario('dark', selectForward, FORWARD_SELECTED)

  rec.record(
    '选择 / 剪切 / 撤销之后磁盘文件未被改写',
    readFileSync(noteFile, 'utf8') === before,
    `chars=${before.length}`
  )
  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(shots, 'selection-failure.png') }).catch(() => {})
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
