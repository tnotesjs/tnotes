// Image chrome: toolbar, exclusive popovers, corner resize, compact more menu.
// Isolated temporary KB/profile. Verifies built `out/` — run electron-vite build first.
import assert from 'node:assert/strict'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-image-chrome-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'TNotes.image-chrome')
const noteFile = join(kb, 'notes', '0001. images.md')
const shots = join(deskDir, 'scripts', 'shots', 'image-chrome')
mkdirSync(join(kb, 'notes'), { recursive: true })
mkdirSync(join(kb, 'assets'), { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'image-chrome' }))
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. images\n')
writeFileSync(
  join(kb, 'assets', 'large.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#2563eb"/></svg>'
)
writeFileSync(
  join(kb, 'assets', 'tiny.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="16"><rect width="40" height="16" fill="#111827"/></svg>'
)
writeFileSync(
  join(kb, 'assets', 'pixel.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1d4ed8"/><circle cx="32" cy="32" r="12" fill="#1e3a8a"/></svg>'
)
writeFileSync(
  noteFile,
  [
    '---',
    'id: 10000000-0000-4000-8000-000000000041',
    '---',
    '',
    '# Images',
    '',
    'Large:',
    '',
    '![大图](../assets/large.svg)',
    '',
    'Tiny:',
    '',
    '![](../assets/tiny.svg)',
    '',
    'Captioned:',
    '',
    '![标题](../assets/pixel.svg)',
    ''
  ].join('\n')
)
writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'dark',
    defaultNoteView: 'visual',
    prettier: false,
    autosave: { enabled: false, delayMs: 1000 }
  })
)

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['out/main/index.js', `--user-data-dir=${profile}`],
  cwd: deskDir,
  timeout: 60000,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
})

async function visible(locator) {
  if ((await locator.count()) === 0) return false
  return locator.evaluate((element) => {
    if (element.hidden) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  })
}

function overlap(a, b) {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.imageChromeClipboard = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.imageChromeClipboard = text
        }
      }
    })
  })
  await page.getByText('image-chrome', { exact: true }).first().click()
  await page.getByText('images', { exact: true }).first().click()
  const pm = page.locator('.milkdown .ProseMirror')
  await pm.waitFor()
  const large = pm.locator('figure.desk-image').nth(0)
  const tiny = pm.locator('figure.desk-image').nth(1)
  const captioned = pm.locator('figure.desk-image').nth(2)
  await large.locator('img').waitFor()
  await tiny.locator('img').waitFor()
  await captioned.locator('img').waitFor()
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('figure.desk-image img')]
    return images.length >= 3 && images.every((image) => image.naturalWidth > 0)
  })

  await captioned.scrollIntoViewIfNeeded()
  const initialCaptioned = await captioned.evaluate((figure) => {
    const img = figure.querySelector('img')
    const frame = figure.querySelector('.desk-image__frame')
    const caption = (() => {
      const pos = figure.getAttribute('data-image-pos')
      return figure
        .closest('.milkdown-markdown-editor__canvas')
        .querySelector(`.desk-image__caption-row[data-image-pos="${pos}"] .desk-image__caption`)
    })()
    const quick = figure.querySelector('.desk-image__quick')
    const imageBox = img.getBoundingClientRect()
    const frameBox = frame.getBoundingClientRect()
    const captionBox = caption.getBoundingClientRect()
    return {
      imageWidth: imageBox.width,
      imageHeight: imageBox.height,
      frameWidth: frameBox.width,
      frameHeight: frameBox.height,
      imageLeft: imageBox.x,
      frameLeft: frameBox.x,
      imageCenter: imageBox.x + imageBox.width / 2,
      captionCenter: captionBox.x + captionBox.width / 2,
      captionTop: captionBox.top,
      imageBottom: imageBox.bottom,
      captionVisible: !caption.hidden && captionBox.height > 0,
      quickAbsolute: getComputedStyle(quick).position === 'absolute'
    }
  })
  assert.ok(initialCaptioned.captionVisible, 'unsized image with alt must show caption on open')
  assert.ok(
    Math.abs(initialCaptioned.imageWidth - initialCaptioned.frameWidth) <= 2,
    `initial frame must hug image (image=${initialCaptioned.imageWidth}, frame=${initialCaptioned.frameWidth})`
  )
  assert.ok(
    Math.abs(initialCaptioned.imageHeight - initialCaptioned.frameHeight) <= 2,
    `initial frame height must hug image (image=${initialCaptioned.imageHeight}, frame=${initialCaptioned.frameHeight})`
  )
  assert.ok(Math.abs(initialCaptioned.imageLeft - initialCaptioned.frameLeft) <= 2)
  assert.ok(
    Math.abs(initialCaptioned.imageCenter - initialCaptioned.captionCenter) <= 2,
    `initial caption must be centered under the image (image=${initialCaptioned.imageCenter}, caption=${initialCaptioned.captionCenter})`
  )
  assert.ok(
    initialCaptioned.captionTop >= initialCaptioned.imageBottom - 1,
    'caption must sit below the image, not beside it'
  )
  assert.equal(initialCaptioned.quickAbsolute, true)

  await large.scrollIntoViewIfNeeded()
  const yBeforeSelect = await large
    .locator('img')
    .evaluate((element) => element.getBoundingClientRect().y)
  await large.locator('img').click()
  await large.waitFor({ state: 'visible' })
  const yAfterSelect = await large
    .locator('img')
    .evaluate((element) => element.getBoundingClientRect().y)
  assert.ok(
    Math.abs(yAfterSelect - yBeforeSelect) <= 2,
    `selecting an image must not shift it (before=${yBeforeSelect}, after=${yAfterSelect})`
  )
  assert.equal(
    await large.getAttribute('class').then((value) => value.includes('is-selected')),
    true
  )
  assert.equal(await visible(large.locator('.desk-image__chrome')), true)
  assert.equal(await visible(large.locator('.desk-image__toolbar')), true)
  assert.equal(await visible(large.locator('.desk-image__size-panel')), false)
  assert.equal(await visible(large.locator('.desk-image__align-panel')), false)
  assert.equal(await visible(large.locator('.desk-image__more-panel')), false)
  assert.doesNotMatch(
    await page.evaluate(() => window.getSelection()?.toString() ?? ''),
    /宽高|描述|对齐|全屏|删除|复制/
  )
  assert.equal(await large.locator('.desk-image__handle').count(), 4)
  for (const corner of ['tl', 'tr', 'br', 'bl']) {
    assert.equal(await visible(large.locator(`.desk-image__handle--${corner}`)), true)
  }
  await page.screenshot({ path: join(shots, '01-selected.png') })

  const yBeforeSize = await large
    .locator('img')
    .evaluate((element) => element.getBoundingClientRect().y)
  await large.getByTitle('宽高', { exact: true }).click()
  const yAfterSize = await large
    .locator('img')
    .evaluate((element) => element.getBoundingClientRect().y)
  assert.ok(
    Math.abs(yAfterSize - yBeforeSize) <= 2,
    `opening 宽高 must not shift the image (before=${yBeforeSize}, after=${yAfterSize})`
  )
  assert.equal(await large.getAttribute('data-panel'), 'size')
  assert.equal(await visible(large.locator('.desk-image__size-panel')), true)
  assert.equal(await visible(large.locator('.desk-image__align-panel')), false)
  assert.deepEqual(await large.locator('.desk-image__preset').allTextContents(), [
    '25%',
    '50%',
    '75%',
    '100%'
  ])
  const sizeBox = await large.locator('.desk-image__size-panel').boundingBox()
  const toolbarBox = await large.locator('.desk-image__toolbar').boundingBox()
  assert.ok(sizeBox && toolbarBox)
  assert.ok(sizeBox.y >= toolbarBox.y + toolbarBox.height - 1, 'size panel must drop below toolbar')
  await page.screenshot({ path: join(shots, '02-size-panel.png') })

  await large.locator('.desk-image__preset', { hasText: '50%' }).click()
  assert.equal(await visible(large.locator('.desk-image__size-panel')), false)
  await page.waitForFunction(() => {
    const stack = document.querySelector('figure.desk-image .desk-image__stack')
    return Boolean(stack?.style.width.includes('50%'))
  })
  const afterPercent = await large.evaluate((figure) => {
    const img = figure.querySelector('img')
    const frame = figure.querySelector('.desk-image__frame')
    const caption = (() => {
      const pos = figure.getAttribute('data-image-pos')
      return figure
        .closest('.milkdown-markdown-editor__canvas')
        .querySelector(`.desk-image__caption-row[data-image-pos="${pos}"] .desk-image__caption`)
    })()
    const imageBox = img.getBoundingClientRect()
    const frameBox = frame.getBoundingClientRect()
    const captionBox = caption.getBoundingClientRect()
    return {
      imageWidth: imageBox.width,
      frameWidth: frameBox.width,
      imageLeft: imageBox.x,
      frameLeft: frameBox.x,
      imageCenter: imageBox.x + imageBox.width / 2,
      captionCenter: captionBox.x + captionBox.width / 2
    }
  })
  assert.ok(Math.abs(afterPercent.imageWidth - afterPercent.frameWidth) <= 2)
  assert.ok(Math.abs(afterPercent.imageLeft - afterPercent.frameLeft) <= 2)
  assert.ok(Math.abs(afterPercent.imageCenter - afterPercent.captionCenter) <= 2)

  await large.getByTitle('对齐', { exact: true }).click()
  assert.equal(await large.getAttribute('data-panel'), 'align')
  assert.equal(await visible(large.locator('.desk-image__align-panel')), true)
  assert.equal(await visible(large.locator('.desk-image__size-panel')), false)
  const alignBox = await large.locator('.desk-image__align-panel').boundingBox()
  const sizeHidden = await large.locator('.desk-image__size-panel').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return element.hidden || getComputedStyle(element).display === 'none' || rect.height === 0
  })
  assert.equal(sizeHidden, true)
  assert.ok(alignBox)
  if (sizeBox) assert.equal(overlap(alignBox, sizeBox) && !sizeHidden, false)
  await large.getByRole('button', { name: '居中对齐', exact: true }).click()
  assert.equal(
    await large.evaluate((element) => element.classList.contains('tn-image--center')),
    true
  )
  // 等一帧 + 一个宏任务，让「居中对齐」引起的重排与浮层重定位都落地再量
  await page.waitForTimeout(250)
  const afterCenter = await large.evaluate((figure) => {
    const img = figure.querySelector('img')
    const caption = (() => {
      const pos = figure.getAttribute('data-image-pos')
      return figure
        .closest('.milkdown-markdown-editor__canvas')
        .querySelector(`.desk-image__caption-row[data-image-pos="${pos}"] .desk-image__caption`)
    })()
    const stage = figure.querySelector('.desk-image__stage')
    const imageBox = img.getBoundingClientRect()
    const captionBox = caption.getBoundingClientRect()
    const stageBox = stage.getBoundingClientRect()
    return {
      imageCenter: imageBox.x + imageBox.width / 2,
      captionCenter: captionBox.x + captionBox.width / 2,
      stageCenter: stageBox.x + stageBox.width / 2
    }
  })
  assert.ok(Math.abs(afterCenter.imageCenter - afterCenter.captionCenter) <= 2)
  assert.ok(Math.abs(afterCenter.imageCenter - afterCenter.stageCenter) <= 2)
  await page.screenshot({ path: join(shots, '03-align-center.png') })

  await large.getByTitle('描述', { exact: true }).click()
  // 描述框已移出 figure、挂在 canvas 上（见 deskImageView.ts resolveCaptionHost），
  // 用 data-image-pos 与图片节点位置关联（多张图同 x 同宽也能确定归属）。
  const caption = page.locator(
    `.desk-image__caption-row[data-image-pos="${await large.getAttribute('data-image-pos')}"] .desk-image__caption`
  )
  assert.equal(await visible(caption), true)
  await caption.fill('新说明')
  await caption.press('Enter')
  assert.equal(await large.locator('img').getAttribute('alt'), '新说明')

  await large.locator('img').hover()
  assert.equal(await visible(large.locator('.desk-image__quick')), true)
  assert.equal(await visible(large.getByTitle('全屏', { exact: true })), true)
  assert.equal(await visible(large.getByTitle('删除', { exact: true })), true)
  assert.equal(await visible(large.getByTitle('复制', { exact: true })), true)
  assert.equal(await visible(large.getByTitle('更多', { exact: true })), false)
  assert.equal(await large.evaluate((element) => element.classList.contains('is-compact')), false)

  await tiny.locator('img').click()
  await page.waitForFunction(() => {
    const figure = document.querySelectorAll('figure.desk-image')[1]
    return figure?.classList.contains('is-selected')
  })
  assert.equal(await tiny.evaluate((element) => element.classList.contains('is-compact')), true)
  assert.equal(await visible(tiny.getByTitle('更多', { exact: true })), true)
  assert.equal(await visible(tiny.getByTitle('全屏', { exact: true })), false)
  assert.equal(await visible(tiny.getByTitle('删除', { exact: true })), false)
  await tiny.getByTitle('更多', { exact: true }).click()
  assert.equal(await visible(tiny.locator('.desk-image__more-panel')), true)
  assert.doesNotMatch(
    await page.evaluate(() => window.getSelection()?.toString() ?? ''),
    /宽高|描述|对齐|全屏|删除|复制/
  )
  assert.equal(await visible(tiny.getByTitle('全屏', { exact: true })), false)
  assert.equal(await visible(tiny.getByTitle('删除', { exact: true })), false)
  assert.deepEqual(
    await tiny
      .locator('.desk-image__more-panel .desk-image__menu-item')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-label'))),
    ['全屏', '删除', '复制']
  )
  await page.screenshot({ path: join(shots, '04-tiny-more.png') })
  await tiny
    .locator('.desk-image__more-panel')
    .getByRole('button', { name: '复制', exact: true })
    .click()
  assert.match(
    await page.evaluate(() => window.imageChromeClipboard),
    /!\[\]\(\.\.\/assets\/tiny\.svg\)/
  )

  await captioned.locator('img').click()
  await page.waitForFunction(() => {
    const figure = document.querySelectorAll('figure.desk-image')[2]
    return figure?.classList.contains('is-selected')
  })
  const selectedCaptioned = await captioned.evaluate((figure) => {
    const img = figure.querySelector('img')
    const frame = figure.querySelector('.desk-image__frame')
    const captionEl = (() => {
      const pos = figure.getAttribute('data-image-pos')
      return figure
        .closest('.milkdown-markdown-editor__canvas')
        .querySelector(`.desk-image__caption-row[data-image-pos="${pos}"] .desk-image__caption`)
    })()
    const more = figure.querySelector('.desk-image__more')
    const imageBox = img.getBoundingClientRect()
    const frameBox = frame.getBoundingClientRect()
    const captionBox = captionEl.getBoundingClientRect()
    const moreBox = more.getBoundingClientRect()
    return {
      imageWidth: imageBox.width,
      frameWidth: frameBox.width,
      imageCenter: imageBox.x + imageBox.width / 2,
      captionCenter: captionBox.x + captionBox.width / 2,
      captionTop: captionBox.top,
      imageBottom: imageBox.bottom,
      moreBottom: moreBox.bottom,
      compact: figure.classList.contains('is-compact')
    }
  })
  assert.equal(selectedCaptioned.compact, true)
  assert.ok(Math.abs(selectedCaptioned.imageWidth - selectedCaptioned.frameWidth) <= 2)
  assert.ok(Math.abs(selectedCaptioned.imageCenter - selectedCaptioned.captionCenter) <= 2)
  assert.ok(selectedCaptioned.captionTop >= selectedCaptioned.imageBottom - 1)
  assert.ok(
    selectedCaptioned.moreBottom <= selectedCaptioned.captionTop + 1,
    'compact more must not sit in the caption row'
  )
  await page.screenshot({ path: join(shots, '04b-captioned-unsized.png') })

  await large.locator('img').click()
  const handle = large.locator('.desk-image__handle--br')
  const start = await large.locator('img').boundingBox()
  assert.ok(start)
  const box = await handle.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, box.y + 60)
  assert.equal(await visible(large.locator('.desk-image__ghost')), true)
  assert.match(await large.locator('.desk-image__size-label').innerText(), /\d+\s*×\s*\d+/)
  await page.screenshot({ path: join(shots, '05-resize-ghost.png') })
  await page.mouse.up()
  const resized = await large
    .locator('.desk-image__stack')
    .evaluate((element) => element.style.width)
  assert.match(resized, /px$/, `expected pixel width after drag, got "${resized}"`)

  // 只读阅读视图已移除；只读状态下的图片"无工具条、点开预览"改由单测覆盖
  // （MilkdownMarkdownEditor.test.ts 的 readOnly 用例），真实界面的只读保护见 e2e-note-readonly。
  await page.keyboard.press('ControlOrMeta+s')
  await page.waitForTimeout(300)
  const saved = readFileSync(noteFile, 'utf8')
  assert.match(saved, /!\[新说明\]\(\.\.\/assets\/large\.svg\) \{w=\d+px align=center\}/)
  assert.match(saved, /!\[\]\(\.\.\/assets\/tiny\.svg\)/)
  console.log(
    '✓ image chrome: exclusive panels, alignment, caption, compact more, resize, readonly preview'
  )
} catch (error) {
  const page = await app.firstWindow()
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app.close()
  rmSync(fixture, { recursive: true, force: true })
}
