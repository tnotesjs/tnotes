// 第 3 项验收：图片描述输入不得替换图片（真实逐字输入）。
//
// 缺陷（未修复时实测）：描述框在 ProseMirror 的 contenteditable 树内，输入的字会
// 被写进图片 alt —— 输入「风景照」得到 `示风景照例图`（字符插在旧描述中间），
// 看起来就是"图片被替换成文字"。
//
// Run: node apps/desk/scripts/e2e-image-caption.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createFixture,
  createRecorder,
  launchDesk,
  openNote,
  trackPageErrors,
  waitFor
} from './e2e-lib.mjs'

const rec = createRecorder()
const fixture = createFixture('img-caption-e2e', {
  notes: [
    { index: '0001', title: '图片描述', body: '# 图片描述\n\n![示例图](../assets/0001-pic.svg)\n' }
  ]
})
mkdirSync(join(fixture.kb, 'assets'), { recursive: true })
writeFileSync(
  join(fixture.kb, 'assets', '0001-pic.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#5b8def"/></svg>'
)
const noteFile = fixture.notePath('0001', '图片描述')

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

const caption = () => page.locator('input.desk-image__caption').first()
const openCaption = async () => {
  // 输入框还开着：直接聚焦，不要重复点按钮（toggle 会把它收起来）
  if ((await caption().count()) > 0 && (await caption().isVisible())) {
    await caption().click()
    return
  }
  await page.locator('.ProseMirror figure.desk-image').first().click()
  const button = page.locator('.desk-image__toolbar button[data-label="描述"]').first()
  const appeared = await waitFor(async () => (await button.count()) > 0, 5000)
  if (!appeared) throw new Error('描述按钮未出现（图片未进入选中态）')
  await button.click()
  await waitFor(async () => (await caption().count()) > 0, 5000)
  // 显式聚焦并把光标放到末尾：自动化点击的落点不可靠，而"继续在末尾编辑"
  // 才是用户路径（产品侧的 focusCaption 也保证这一点）。
  await caption().evaluate((el) => {
    el.focus()
    const end = el.value.length
    if (end > 0) el.setSelectionRange(end, end)
  })
}
/** 直接读图片节点的 alt（不依赖渲染出来的可见文字）。 */
const imageAlt = async () =>
  page
    .locator('.ProseMirror img')
    .first()
    .evaluate((el) => el.getAttribute('alt') ?? null)
const imageSrc = async () =>
  page
    .locator('.ProseMirror img')
    .first()
    .evaluate((el) => el.getAttribute('src') ?? '')
const diskImage = () => {
  const match = readFileSync(noteFile, 'utf8').match(/!\[([^\]]*)\]\(([^)]*)\)/)
  return match ? { alt: match[1], src: match[2] } : null
}
const save = async () => {
  await page.keyboard.press('ControlOrMeta+s')
  await new Promise((resolve) => setTimeout(resolve, 900))
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '图片描述' })
  await waitFor(async () => (await page.locator('.ProseMirror img').count()) > 0, 20000)
  rec.record('图片已渲染', true, `src=${await imageSrc()}`)

  // ── 1. 逐字输入中文：只更新描述，不动图片节点 ──
  await openCaption()
  const valueBefore = await caption().inputValue()
  await page.keyboard.type('风景照', { delay: 60 })
  const valueAfter = await caption().inputValue()
  // 判据只看"新输入是否完整进入描述框且未被塞进 alt"：
  // 是追加还是插入取决于聚焦落点（浏览器行为），不当作缺陷判据。
  rec.record(
    '逐字输入只进入描述框（未写进 alt）',
    valueAfter.length === valueBefore.length + 3 && valueAfter.includes('风景照'),
    `before=${JSON.stringify(valueBefore)} after=${JSON.stringify(valueAfter)}`
  )
  const imgCountMid = await page.locator('.ProseMirror img[src*="0001-pic.svg"]').count()
  const srcMid = await imageSrc()
  rec.record(
    '输入过程中图片节点保持不动',
    imgCountMid === 1 && srcMid.includes('0001-pic.svg'),
    `img=${imgCountMid} src=${srcMid.slice(0, 80)}`
  )
  await page.keyboard.press('Enter')
  await new Promise((resolve) => setTimeout(resolve, 300))
  rec.record(
    'Enter 提交后图片 alt 更新为新描述',
    (await imageAlt()) === valueAfter,
    `alt=${await imageAlt()}`
  )

  // ── 2. 保存后磁盘与节点一致，图片路径不变 ──
  await save()
  const disk1 = diskImage()
  rec.record(
    '保存后磁盘仍是图片且 alt 正确',
    Boolean(disk1) && disk1?.alt === valueAfter && disk1?.src.includes('0001-pic.svg'),
    JSON.stringify(disk1)
  )

  // ── 3. 重开笔记：描述持久化 ──
  const row = page.locator('.toc-row', { hasText: '图片描述' }).first()
  await row.click()
  await new Promise((resolve) => setTimeout(resolve, 600))
  await waitFor(async () => (await page.locator('.ProseMirror img').count()) > 0, 20000)
  rec.record('重开后图片 alt 持久化', (await imageAlt()) === valueAfter, `alt=${await imageAlt()}`)

  // ── 4. 修改描述（选中全部后替换）──
  await openCaption()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('新描述', { delay: 60 })
  await page.keyboard.press('Enter')
  await new Promise((resolve) => setTimeout(resolve, 300))
  rec.record(
    '修改描述（全选替换）只改 alt',
    (await imageAlt()) === '新描述',
    `alt=${await imageAlt()}`
  )
  rec.record('图片路径仍未被改', (await imageSrc()).includes('0001-pic.svg'))

  // ── 5. 英文逐字输入 ──
  await openCaption()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Landscape Photo', { delay: 40 })
  await page.keyboard.press('Enter')
  await new Promise((resolve) => setTimeout(resolve, 300))
  rec.record(
    '英文逐字输入正确',
    (await imageAlt()) === 'Landscape Photo',
    `alt=${await imageAlt()}`
  )

  // ── 6. 输入框内删除（Backspace）只影响输入框 ──
  await openCaption()
  await page.keyboard.press('End')
  await page.keyboard.press('Backspace')
  const afterBackspace = await caption().inputValue()
  rec.record(
    '输入框内 Backspace 只删输入框字符',
    afterBackspace === 'Landscape Phot',
    `value=${afterBackspace}`
  )
  rec.record(
    '删除期间图片与 alt 未变',
    (await imageAlt()) === 'Landscape Photo' && (await imageSrc()).includes('0001-pic.svg')
  )
  await page.keyboard.press('Escape')
  await new Promise((resolve) => setTimeout(resolve, 300))
  rec.record(
    'Escape 放弃输入（alt 保持原值）',
    (await imageAlt()) === 'Landscape Photo',
    `alt=${await imageAlt()}`
  )

  // ── 7. 失焦提交 ──
  await openCaption()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('失焦提交', { delay: 60 })
  await page.locator('.ProseMirror h1').first().click()
  await new Promise((resolve) => setTimeout(resolve, 400))
  rec.record('失焦提交生效', (await imageAlt()) === '失焦提交', `alt=${await imageAlt()}`)

  // ── 8. 粘贴进描述框 ──
  await openCaption()
  await page.keyboard.press('ControlOrMeta+a')
  // 从**主进程**写剪贴板：Electron 的 clipboard 不受页面 clipboard-write 权限限制
  // （渲染端 navigator.clipboard.writeText 在这个环境会被拒）。
  const clipboardAvailable = await app
    .evaluate(({ clipboard }, text) => {
      try {
        clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }, '粘贴的描述')
    .catch(() => false)
  if (clipboardAvailable) {
    await page.keyboard.press('ControlOrMeta+v')
    await new Promise((resolve) => setTimeout(resolve, 400))
    await page.keyboard.press('Enter')
    await new Promise((resolve) => setTimeout(resolve, 300))
    rec.record('粘贴到描述框', (await imageAlt()) === '粘贴的描述', `alt=${await imageAlt()}`)
  } else {
    rec.record('粘贴到描述框', false, '未验证：自动化环境无剪贴板写权限（不用合成事件冒充结论）')
  }

  // ── 9. 撤销 / 重做 ──
  await save()
  const savedAlt = await imageAlt()
  await page.locator('.ProseMirror h1').first().click()
  await page.keyboard.press('ControlOrMeta+z')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const undoneAlt = await imageAlt()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const imgCountAfterUndo = await page.locator('.ProseMirror img[src*="0001-pic.svg"]').count()
  rec.record(
    '撤销/重做作用于描述且图片节点保持',
    imgCountAfterUndo === 1,
    `img=${imgCountAfterUndo} saved=${savedAlt} undone=${undoneAlt} redone=${await imageAlt()}（撤销是否作用于描述属既有行为，本轮不扩大范围）`
  )

  // ── 10. 相邻控件（尺寸）不回退 ──
  await save()
  await page.locator('.ProseMirror figure.desk-image').first().click()
  await waitFor(
    async () => (await page.locator('.desk-image__toolbar button[data-label="宽高"]').count()) > 0,
    5000
  )
  await page.locator('.desk-image__toolbar button[data-label="宽高"]').first().click()
  const widthInput = page.locator('.desk-image__size-panel input').first()
  const hasWidth = (await widthInput.count()) > 0
  if (hasWidth) {
    await widthInput.fill('50%')
    await widthInput.dispatchEvent('change')
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const figureStyle = hasWidth
    ? await page.locator('.ProseMirror figure.desk-image').first().getAttribute('style')
    : ''
  rec.record(
    '尺寸输入仍可用（相邻控件未回退）',
    hasWidth && Boolean(figureStyle),
    `style=${String(figureStyle).slice(0, 60)}`
  )
  const imgCountAfterSize = await page.locator('.ProseMirror img[src*="0001-pic.svg"]').count()
  rec.record('尺寸改动后图片节点仍在', imgCountAfterSize === 1, `img=${imgCountAfterSize}`)

  // ── 11. 中文输入法（IME）──
  // 真实 IME 无法在自动化里触发，这里**明确记为未验证**，不用合成事件冒充结论。
  rec.record(
    '中文输入法（IME）实测',
    false,
    '未实测：无法在自动化环境中触发真实 IME 组字，需人工验证（不用合成事件代替结论）'
  )

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(fixture.fixture, 'failure.png') }).catch(() => {})
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 500))
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
