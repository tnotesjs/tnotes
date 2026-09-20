// 0.10.1 回归验收：复制图片时系统剪贴板的 text/plain 必须是图片的 alt。
//
// 回归由来：6dc6d04 把图片描述 <input> 移出 contenteditable 后，选区里只剩 <img>，
// 而图片节点不贡献纯文本 → 复制图片后粘到只认 text/plain 的地方得到空。
//
// 覆盖（按验收清单）：
//  1) 单张有 alt：text/plain === alt，粘到页面内普通文本框有内容；
//  2) 单张无 alt：明确预期（空），且不能因此被误判成"复制失败"（html/引用仍完整）；
//  3) 图片与正文混选：text/plain 保留文字顺序，不丢正文、不重复描述；
//  4) 多张图片：每张各出一次 alt，顺序与文档一致；
//  5) 粘回 Desk：图片仍在、路径与描述正确；
//  6) 复制出的合法代码/正文的纯文本完整性不回归（代码块的独立格式标记仍在）。
//
// Run: node apps/desk/scripts/e2e-image-copy-plain-text.mjs
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
const SVG = (name, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="${color}"/></svg>`
const NOTE_BODY = [
  '# 图片复制',
  '',
  '前段文字',
  '',
  '![画布甲](../assets/0001-甲.svg)',
  '',
  '![画布乙](../assets/0001-乙.svg)',
  '',
  '![](../assets/0001-丙.svg)',
  '',
  '尾段文字',
  '',
  '```js',
  'const keep = 1',
  '```',
  ''
].join('\n')

const fixture = createFixture('image-copy-plain', {
  notes: [
    { index: '0001', title: '图片复制', body: NOTE_BODY },
    { index: '0002', title: '目标', body: ['# 目标', '', '目标正文', ''].join('\n') }
  ]
})
// 素材：三张 svg（前两张有 alt、第三张无 alt）
const assetsDir = join(fixture.kb, 'assets')
mkdirSync(assetsDir, { recursive: true })
writeFileSync(join(assetsDir, '0001-甲.svg'), SVG('甲', '#112233'))
writeFileSync(join(assetsDir, '0001-乙.svg'), SVG('乙', '#223344'))
writeFileSync(join(assetsDir, '0001-丙.svg'), SVG('丙', '#334455'))
const noteFile = fixture.notePath('0001', '图片复制')
const targetNoteFile = fixture.notePath('0002', '目标')

const app = await launchDesk(fixture, { env: { DESK_E2E_EXPOSE_INTERNALS: '1' } })
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

const clipboard = () =>
  app.evaluate(({ clipboard }) => ({
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    formats: clipboard.availableFormats()
  }))
const clearClipboard = () => app.evaluate(({ clipboard }) => clipboard.clear())
const normalize = (value) => (value ?? '').replace(/\r\n?/g, '\n')
const pane = () => page.locator('.milkdown:visible .ProseMirror').first()

/** 复制整篇笔记（Cmd+A / Cmd+C） */
const copyAll = async () => {
  await clearClipboard()
  await pane().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+c')
  await new Promise((resolve) => setTimeout(resolve, 500))
}
/** 在页面里注入一个普通文本框（代表"只认 text/plain 的地方"），粘贴并读回 */
const pasteIntoPlainInput = async () => {
  await page.evaluate(() => {
    const area = document.createElement('textarea')
    area.id = 'plain-input'
    area.style.cssText = 'position:fixed;left:8px;top:8px;width:320px;height:180px'
    document.body.append(area)
  })
  await page.locator('#plain-input').click()
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const value = await page.locator('#plain-input').inputValue()
  await page.evaluate(() => document.querySelector('#plain-input')?.remove())
  return value
}
/** 选中一个 figure（图片）并复制 */
const copyFigure = async (index) => {
  await clearClipboard()
  await page.locator('.milkdown:visible figure.desk-image').nth(index).click()
  await new Promise((resolve) => setTimeout(resolve, 250))
  await page.keyboard.press('ControlOrMeta+c')
  await new Promise((resolve) => setTimeout(resolve, 500))
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '图片复制' })
  await waitFor(async () => (await page.locator('figure.desk-image').count()) >= 3, 20000)
  rec.record(
    '夹具就位：三张图都渲染成 figure（含无 alt 那张）',
    (await page.locator('figure.desk-image').count()) >= 3,
    `figures=${await page.locator('figure.desk-image').count()}`
  )

  // ── 1) 单张有 alt ────────────────────────────────────────────────────
  await copyFigure(0)
  const one = await clipboard()
  rec.record(
    '单张图片有 alt：系统剪贴板 text/plain === alt',
    normalize(one.text) === '画布甲',
    `text=${JSON.stringify(one.text)} formats=${JSON.stringify(one.formats)}`
  )
  rec.record(
    '单张图片有 alt：text/html 仍带引用（Desk 内部粘贴要用）',
    one.html.includes('.svg'),
    `htmlHead=${JSON.stringify(one.html.slice(0, 60))}`
  )
  const onePasted = await pasteIntoPlainInput()
  rec.record(
    '单张图片有 alt：粘到页面内普通文本框有内容且等于 alt',
    normalize(onePasted) === '画布甲',
    JSON.stringify(onePasted)
  )

  // ── 2) 单张无 alt：明确预期为"空"，但不是复制失败 ─────────────────────
  const noAltAlt = await page
    .locator('.milkdown:visible figure.desk-image img')
    .nth(2)
    .getAttribute('alt')
  await copyFigure(2)
  const none = await clipboard()
  rec.record(
    '单张图片无 alt：text/plain 为空（明确预期：没有描述就没有纯文本，不是复制失败）',
    (noAltAlt ?? '') === '' && normalize(none.text) === '',
    `alt=${JSON.stringify(noAltAlt)} text=${JSON.stringify(none.text)}`
  )
  rec.record(
    '单张图片无 alt：text/html 仍带引用，说明复制本身成功',
    none.html.includes('.svg') && none.formats.includes('text/html'),
    `formats=${JSON.stringify(none.formats)} htmlHasSvg=${none.html.includes('.svg')}`
  )

  // ── 3) 图片与正文混选：顺序保留、不丢正文、不重复描述 ────────────────
  await copyAll()
  const mixed = await clipboard()
  const lines = normalize(mixed.text)
    .split('\n')
    .filter((line) => line.trim() !== '')
  rec.record(
    '图文混选：text/plain 按文档顺序包含正文与各图 alt',
    JSON.stringify(lines) ===
      JSON.stringify(['图片复制', '前段文字', '画布甲', '画布乙', '尾段文字', 'const keep = 1']),
    JSON.stringify(lines)
  )
  rec.record(
    '图文混选：正文没有被丢掉（前段/尾段都在）',
    mixed.text.includes('前段文字') && mixed.text.includes('尾段文字'),
    JSON.stringify(mixed.text.slice(0, 80))
  )
  rec.record(
    '图文混选：描述没有被重复（每张图各出现一次）',
    (mixed.text.match(/画布甲/g) ?? []).length === 1 &&
      (mixed.text.match(/画布乙/g) ?? []).length === 1,
    `甲=${(mixed.text.match(/画布甲/g) ?? []).length} 乙=${(mixed.text.match(/画布乙/g) ?? []).length}`
  )

  // ── 4) 多张图片各自出一次 alt（上面已含 3 张），单独再断言顺序 ────────
  // 无 alt 的图不贡献文本，所以顺序只断言有 alt 的那两张
  const altOrder = ['画布甲', '画布乙'].map((alt) => normalize(mixed.text).indexOf(alt))
  rec.record(
    '多张图片：alt 出现顺序与文档顺序一致',
    altOrder.every((index, i) => index >= 0 && (i === 0 || index > altOrder[i - 1])),
    JSON.stringify(altOrder)
  )

  // ── 5) 粘回 Desk（另一篇笔记）：图片、路径、描述都正确 ───────────────
  await copyAll()
  const sourceBefore = readFileSync(noteFile, 'utf8')
  await openNote(page, { kbName: fixture.kbName, title: '目标' })
  await waitFor(
    async () =>
      (await page.locator('.milkdown:visible .ProseMirror').first().innerText()).includes(
        '目标正文'
      ),
    20000
  )
  await page.locator('.milkdown:visible .ProseMirror').first().click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const pastedFigures = await page.locator('.milkdown:visible figure.desk-image').count()
  const pastedAlts = await page
    .locator('.milkdown:visible figure.desk-image img')
    .evaluateAll((nodes) => nodes.map((img) => img.getAttribute('alt')))
  rec.record(
    '粘回 Desk（另一篇笔记）：三张图都粘进来了',
    pastedFigures >= 3,
    `figures=${pastedFigures} alts=${JSON.stringify(pastedAlts)}`
  )
  rec.record(
    '粘回 Desk：描述（alt）保持正确',
    pastedAlts.filter(Boolean).includes('画布甲') && pastedAlts.filter(Boolean).includes('画布乙'),
    JSON.stringify(pastedAlts)
  )
  await page.keyboard.press('ControlOrMeta+s')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const targetDisk = readFileSync(targetNoteFile, 'utf8')
  // 目标笔记在 notes/ 下，所以引用是 `assets/...`（不是 `../assets/...`）
  const targetRefs = targetDisk.match(/!\[[^\]]*\]\((?:[./]*\/?assets\/0001-[^)]+\.svg)\)/g) ?? []
  rec.record(
    '粘回 Desk 后落盘：目标笔记里是相对路径引用（不是代理 URL），三张图都在',
    !targetDisk.includes('tnotes-asset://') && targetRefs.length >= 3,
    `refs=${targetRefs.length} ${JSON.stringify(targetDisk.slice(targetDisk.indexOf('目标正文'), targetDisk.indexOf('目标正文') + 140))}`
  )
  rec.record('粘回 Desk：源笔记内容未被改写', readFileSync(noteFile, 'utf8') === sourceBefore, '')

  // ── 6) 不回归：代码块的纯文本与独立格式标记 ──────────────────────────
  await clearClipboard()
  const codeBlock = page.locator('.milkdown-code-block').first()
  if ((await codeBlock.count()) > 0) {
    await codeBlock
      .locator('.preview-toggle-button')
      .first()
      .click()
      .catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 350))
    const cm = codeBlock.locator('.cm-content').first()
    await cm.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+c')
    await new Promise((resolve) => setTimeout(resolve, 450))
    const code = await clipboard()
    rec.record(
      '代码复制不回归：纯文本仍是代码原文',
      normalize(code.text) === 'const keep = 1',
      JSON.stringify(code.text)
    )
    rec.record(
      '代码复制不回归：独立来源格式仍在（未被图片逻辑覆盖）',
      code.formats.includes('application/x-desk-code'),
      JSON.stringify(code.formats)
    )
  }

  // ── 7) 不回归：图片描述仍可编辑且不写坏 alt ───────────────────────────
  const captionInput = () => page.locator('input.desk-image__caption').first()
  await page.locator('.ProseMirror figure.desk-image').first().click()
  const captionButton = page.locator('.desk-image__toolbar button[data-label="描述"]').first()
  const captionAppeared = await waitFor(async () => (await captionButton.count()) > 0, 5000)
  rec.record('图片描述：选中图片后「描述」按钮出现', captionAppeared, '')
  if (captionAppeared) {
    await page.locator('.milkdown:visible figure.desk-image').first().click()
    await captionButton.click()
    await waitFor(async () => (await captionInput().count()) > 0, 5000)
    await captionInput().click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await captionInput().pressSequentially('新描述', { delay: 60 })
    await page.keyboard.press('Enter')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const altNow = await page.locator('figure.desk-image img').first().getAttribute('alt')
    rec.record(
      '图片描述编辑不回归：逐字输入后 alt 正确',
      altNow === '新描述',
      JSON.stringify(altNow)
    )
  }

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 500))
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
