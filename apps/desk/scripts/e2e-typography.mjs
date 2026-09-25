// Verify local Inter fonts and note typography without any network access.
import assert from 'node:assert/strict'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-typography-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'TNotes.typography')
const noteFile = join(kb, 'notes', '0001. typography.md')
const shots = join(deskDir, 'scripts', 'shots', 'typography')
mkdirSync(join(kb, 'notes'), { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'typography' }))
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. typography\n')
const markdown = [
  '# 0001. 使用 contextBridge 暴露 API 给渲染进程',
  '',
  '<!-- region:toc -->',
  '- [1. 本节内容](#1-本节内容)',
  '- [2. demos.1 - 使用 contextBridge 暴露 API 给渲染进程](#2-demos1---使用-contextbridge-暴露-api-给渲染进程)',
  '<!-- endregion:toc -->',
  '',
  '## 1. 本节内容',
  '',
  '这一节将介绍如何在开启 `contextIsolation` 的情况下，使用 `contextBridge` 给渲染进程暴露 Electron API，使用系统的原生能力。',
  '',
  '普通 Inter Café Ā Ω ἄ Д Ѡ ắ；**加粗 Bold**；*斜体 Italic*；**_粗斜体 Bold Italic_**。',
  '',
  '- 顶层列表',
  '  - 嵌套列表',
  '    - [三级链接列表](https://example.com/nested)',
  '- **加粗列表**',
  '- [只含链接的列表](https://example.com)',
  '',
  '## 2. demos.1 - 使用 contextBridge 暴露 API 给渲染进程',
  '',
  '```js',
  'const { contextBridge } = require("electron")',
  '```',
  '',
  '### Heading 3',
  '',
  '#### Heading 4',
  '',
  '##### Heading 5',
  '',
  '###### Heading 6',
  '',
  '::: info 提示',
  '',
  'CALLOUT-TEXT',
  '',
  '- 提示块列表',
  '  - 提示块嵌套列表',
  '',
  ':::',
  '',
  '| Column A | Column B |',
  '| --- | --- |',
  '| Cell A | Cell B |',
  '',
  '链接浮层配色：[示例链接](https://example.com/deep/path/to/page) 只是用来悬停。',
  '',
  '> 引用块第一行。',
  '> 引用块第二行。',
  '',
  '1. 有序列表项',
  '',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  ''
].join('\n')
const source = `---\nid: 10000000-0000-4000-8000-000000000072\n---\n\n${markdown}`
writeFileSync(noteFile, source)

/** WCAG 相对对比度：用来证明浮层图标不是「几乎看不见」。 */
function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const [r, g, b] = color
      .match(/\d+/g)
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const channel = value / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}
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

// Vite must emit every referenced font, and ship the license with the renderer.
const assetDir = join(deskDir, 'out/renderer/assets')
const fontFiles = readdirSync(assetDir).filter((file) => /^inter-.*\.woff2$/.test(file))
assert.equal(fontFiles.length, 14)
for (const file of fontFiles) {
  const bytes = readFileSync(join(assetDir, file))
  assert.equal(bytes.toString('ascii', 0, 4), 'wOF2')
  assert.equal(bytes.readUInt32BE(8), bytes.length)
}
assert.match(
  readFileSync(join(deskDir, 'out/renderer/licenses/Inter.txt'), 'utf8'),
  /SIL OPEN FONT LICENSE Version 1\.1/
)

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['out/main/index.js', `--user-data-dir=${profile}`],
  cwd: deskDir,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
})

try {
  await app.context().setOffline(true)
  const page = await app.firstWindow()
  // Reload after forcing offline: a font cached by the launch race cannot mask a remote dependency.
  await page.reload()
  await page.getByText('typography', { exact: true }).first().click()
  await page.locator('.toc-nodes .node-label').filter({ hasText: 'typography' }).click()
  const pm = page.locator('.milkdown .ProseMirror')
  await pm.waitFor()
  const sample = 'Inter Café Ā Ω ἄ Д Ѡ ắ'
  const fontLoads = await page.evaluate(async (sample) => {
    const faces = await Promise.all([
      document.fonts.load('400 16px Inter', sample),
      document.fonts.load('600 32px Inter', sample),
      document.fonts.load('italic 400 16px Inter', sample),
      document.fonts.load('italic 700 16px Inter', sample)
    ])
    await document.fonts.ready
    return faces.map((group) => group.map((font) => ({ family: font.family, status: font.status })))
  }, sample)
  for (const group of fontLoads) {
    assert.equal(group.length, 7)
    assert.ok(group.every((font) => font.family === 'Inter' && font.status === 'loaded'))
  }
  // file: resources are not reliably exposed in Chromium's Resource Timing API.
  // Inspect the actual font faces instead; loading above proves all are usable.
  const resources = await page.evaluate(() =>
    Array.from(document.styleSheets).flatMap((sheet) =>
      Array.from(sheet.cssRules).flatMap((rule) => {
        if (!(rule instanceof CSSFontFaceRule) || rule.style.fontFamily !== 'Inter') return []
        const src = rule.style.getPropertyValue('src')
        const url = src.match(/url\(["']?([^"')]+)["']?\)/)?.[1]
        return url ? [new URL(url, sheet.href).href] : []
      })
    )
  )
  assert.equal(resources.length, 14)
  assert.ok(resources.every((url) => url.startsWith('file:')))
  console.log('✓ all 14 normal/italic Inter subsets load from the built app while offline')

  // Check actual glyph fonts, not only a CSS family that might silently fall back.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument')
  for (const selector of [
    '.ProseMirror h1',
    '.ProseMirror h2',
    '.ProseMirror > p',
    '.ProseMirror > p strong',
    '.ProseMirror > p em'
  ]) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId, selector)
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
    assert.ok(
      fonts.some(
        (font) =>
          /^Inter(?: Variable)?$/.test(font.familyName) && font.isCustomFont && font.glyphCount > 0
      ),
      `${selector}: must render bundled Inter glyphs: ${JSON.stringify(fonts)}`
    )
    assert.equal(
      fonts.some((font) => /Times|Cambria|Noto Serif/.test(font.familyName)),
      false
    )
  }
  await cdp.detach()
  console.log(
    '✓ headings, body, bold and italic actually render bundled Inter (not a system fallback)'
  )

  for (const mode of ['可视化编辑']) {
    // 两态视图是整体开关：当前不是目标视图才点（点任意一个图标都会切走）
    const current = await page
      .locator('[data-testid="view-toggle"]')
      .first()
      .getAttribute('aria-label')
    if (current !== mode) await page.locator('[data-testid="view-toggle"]').click()
    await pm.waitFor()
    const styles = await pm.evaluate((element) => {
      const read = (selector) => {
        const el = element.querySelector(selector)
        const css = getComputedStyle(el)
        return {
          font: css.fontFamily,
          size: css.fontSize,
          weight: css.fontWeight,
          line: css.lineHeight,
          synthesis: css.fontSynthesis
        }
      }
      return {
        headings: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(read),
        body: read(':scope > p'),
        toc: read('.desk-generated-toc__link'),
        code: read(':scope > p code'),
        callout: read('.custom-block-body p'),
        table: read('td p'),
        appSize: getComputedStyle(document.documentElement).fontSize
      }
    })
    const baseFont = styles.body.font
    assert.match(baseFont, /Inter, ui-sans-serif, system-ui, sans-serif/)
    assert.equal(styles.body.size, '16px')
    assert.equal(styles.body.line, '28px')
    assert.equal(styles.body.synthesis, 'style')
    assert.equal(styles.toc.font, baseFont)
    assert.equal(styles.toc.size, '16px')
    assert.equal(styles.toc.line, '28px')
    assert.deepEqual(
      styles.headings.map((h) => h.font),
      Array(6).fill(baseFont)
    )
    assert.deepEqual(
      styles.headings.map((h) => h.size),
      ['32px', '24px', '20px', '18px', '16px', '16px']
    )
    assert.ok(styles.headings.every((h) => h.weight === '600'))
    assert.match(styles.code.font, /monospace/)
    assert.equal(styles.code.size, '14px')
    assert.equal(styles.callout.line, '24px')
    assert.equal(styles.table.line, '24px')
    assert.equal(styles.appSize, '14px')
    await page.screenshot({
      path: join(shots, mode === '可视化编辑' ? 'visual.png' : 'readonly.png')
    })
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      // 复选框有 `transition: all .3s`：切换主题后要等过渡结束再读计算样式，
      // 否则拿到的是上一套主题的中间态。
      await page.waitForTimeout(400)
      const markers = await pm.evaluate((element) => ({
        body: getComputedStyle(element.querySelector(':scope > p')).color,
        bullets: Array.from(element.querySelectorAll('.label.bullet svg'))
          // callout 正文里的列表现在也是 .label.bullet：这里只统计文档自身的三级列表，
          // callout 的 bullet 归下面的 callout 断言单独管。
          .filter((svg) => !svg.closest('.custom-block-body'))
          .map((svg) => ({
            fill: getComputedStyle(svg).fill,
            glyphs: Array.from(svg.querySelectorAll('path, circle')).map(
              (glyph) => getComputedStyle(glyph).fill
            )
          })),
        // callout 的 li 外面套了一层 div.milkdown-list-item-block，`ul > li` 选不到。
        callout: Array.from(element.querySelectorAll('.custom-block-body ul li')).map((li) => ({
          text: getComputedStyle(li).color,
          marker: getComputedStyle(li, '::before').color
        }))
      }))
      const label = `${mode}/${theme}`
      assert.equal(markers.body, theme === 'dark' ? 'rgb(223, 223, 214)' : 'rgb(60, 60, 67)')
      assert.equal(markers.bullets.length, 5, `${label}: all three list levels are covered`)
      for (const bullet of markers.bullets) {
        assert.equal(
          bullet.fill,
          markers.body,
          `${label}: bullet must match body, even beside links`
        )
        assert.ok(bullet.glyphs.length > 0)
        assert.ok(
          bullet.glyphs.every((fill) => fill === markers.body),
          label
        )
      }
      assert.equal(markers.callout.length, 2)
      for (const callout of markers.callout) {
        assert.equal(callout.marker, callout.text, `${label}: callout bullet must match its text`)
      }
      // 引用块必须与站点（prose.css 的 `.vp-doc` 规则）逐项一致：Crepe 默认给的是 4px
      // 主题色圆角竖条 + 40px 缩进 + 4px 间距，站点是 2px 分隔线 + 16px 缩进 + 16px 间距。
      // 这里把同一份 prose.css 的站点规则套在一个离屏 `.vp-doc` 上直接比计算样式。
      const quote = await pm.evaluate((element) => {
        const host = document.createElement('div')
        host.className = 'vp-doc'
        host.style.cssText = 'position:absolute;left:-10000px;top:0;width:600px'
        host.innerHTML = '<blockquote><p>引用块第一行。</p></blockquote>'
        document.body.append(host)
        const read = (node) => {
          const css = getComputedStyle(node)
          const before = getComputedStyle(node, '::before')
          const text = getComputedStyle(node.querySelector('p'))
          return {
            borderLeft: `${css.borderLeftWidth} ${css.borderLeftStyle} ${css.borderLeftColor}`,
            padding: `${css.paddingTop} ${css.paddingRight} ${css.paddingBottom} ${css.paddingLeft}`,
            margin: `${css.marginTop} ${css.marginRight} ${css.marginBottom} ${css.marginLeft}`,
            boxSizing: css.boxSizing,
            before:
              before.content === 'none' ? 'none' : `${before.width} ${before.backgroundColor}`,
            // 段落自身的 padding 是编辑器刻意的命中区（Crepe 4px），只比文字指标。
            textColor: text.color,
            textFontSize: text.fontSize,
            textLineHeight: text.lineHeight
          }
        }
        const result = {
          editor: read(element.querySelector('blockquote')),
          site: read(host.querySelector('blockquote'))
        }
        host.remove()
        return result
      })
      assert.deepEqual(quote.editor, quote.site, `${label}: 可视化编辑器的引用块样式必须与站点一致`)
      // 列表：marker → 文字的 ink 间距必须与站点一致。站点是 outside marker + 24px 缩进，
      // 量得 • 的 ink 离文字 13.5px、编号 6px；Crepe 默认是 24px label 列 + `li gap: 10px`
      // （宽约 5px），所以这里量编辑器的 marker ink 右边缘到文字 ink 左边缘。
      const listGaps = await pm.evaluate((element) => {
        const inkRight = (labelNode) => {
          const shape = labelNode.querySelector('circle, path, rect')
          if (labelNode.classList.contains('bullet') && shape) {
            return shape.getBoundingClientRect().right
          }
          return labelNode.getBoundingClientRect().right
        }
        const textLeft = (item) => {
          const range = document.createRange()
          range.selectNodeContents(item.querySelector('.children p').firstChild)
          return range.getBoundingClientRect().left
        }
        const gaps = {}
        for (const item of element.querySelectorAll('.milkdown-list-item-block li.list-item')) {
          const marker = item.querySelector('.label-wrapper .label')
          const kind =
            marker.classList.contains('unchecked') || marker.classList.contains('checked')
              ? 'checkbox'
              : marker.classList.contains('bullet')
                ? 'bullet'
                : 'ordered'
          if (gaps[kind] === undefined) gaps[kind] = Math.round(textLeft(item) - inkRight(marker))
        }
        return gaps
      })
      // 站点量到的值（像素扫描，见提交说明）；容差 1px 覆盖字形边距与取整。
      for (const [kind, expected] of Object.entries({ bullet: 13.5, ordered: 6, checkbox: 8.4 })) {
        const actual = listGaps[kind]
        assert.ok(
          Math.abs(actual - expected) <= 1,
          `${label}: ${kind} 的 marker→文字间距 ${actual}px 与站点 ${expected}px 不一致`
        )
      }
      // 复选框：与站点 `prose.css` 的 `.task-list-item-checkbox` 逐项一致（16px / 圆角 4px /
      // 品牌绿 #00b96b / 白色对勾 / `all .3s` / `top: .2em`），未选中与选中都比。
      const checkbox = await pm.evaluate((element) => {
        const host = document.createElement('div')
        host.className = 'vp-doc'
        host.style.cssText = 'position:absolute;left:-10000px;top:0;width:600px'
        host.innerHTML =
          '<ul class="contains-task-list"><li class="task-list-item enabled"><label><input class="task-list-item-checkbox" type="checkbox"> 未完成任务</label></li>' +
          '<li class="task-list-item enabled"><label><input class="task-list-item-checkbox" type="checkbox" checked> 已完成任务</label></li></ul>'
        document.body.append(host)
        const read = (node) => {
          const css = getComputedStyle(node)
          return {
            size: `${css.width} ${css.height}`,
            radius: css.borderRadius,
            border: `${css.borderTopWidth} ${css.borderTopStyle} ${css.borderTopColor}`,
            background: css.backgroundColor,
            backgroundSize: css.backgroundSize,
            transition: `${css.transitionProperty} ${css.transitionDuration}`,
            top: css.top
          }
        }
        const result = {
          editorUnchecked: read(element.querySelector('.label-wrapper .label.unchecked')),
          siteUnchecked: read(host.querySelectorAll('input')[0]),
          editorChecked: read(element.querySelector('.label-wrapper .label.checked')),
          siteChecked: read(host.querySelectorAll('input')[1]),
          siteListStyle: getComputedStyle(host.querySelector('.task-list-item')).listStyleType,
          editorSvg: getComputedStyle(element.querySelector('.label-wrapper .label.unchecked svg'))
            .display
        }
        host.remove()
        return result
      })
      assert.deepEqual(
        checkbox.editorUnchecked,
        checkbox.siteUnchecked,
        `${label}: 未选中复选框样式必须与站点一致`
      )
      assert.deepEqual(
        checkbox.editorChecked,
        checkbox.siteChecked,
        `${label}: 选中复选框样式必须与站点一致`
      )
      assert.equal(checkbox.siteListStyle, 'none', `${label}: 站点任务项不应再显示项目符号`)
      assert.equal(checkbox.editorSvg, 'none', `${label}: 编辑器不再使用 Crepe 的方框图标`)
      // 链接浮层的图标曾用 Crepe 的 outline 令牌（Desk 把它映射成品色边框），浅色/暗色下
      // 都几乎与浮层底色相同。这里用对比度守住「看得见」。
      if (mode === '可视化编辑') {
        const link = page.locator('.ProseMirror a', { hasText: '示例链接' }).first()
        const preview = page.locator('.milkdown-link-preview[data-show="true"]')
        // Crepe 的 tooltip 只在编辑器有 DOM 焦点时才出现（`if (!view.hasFocus()) return`），
        // 而上面刚点过模式按钮；悬停偶尔也不触发（鼠标已在同一位置时没有新的 mousemove）。
        for (let attempt = 0; ; attempt += 1) {
          await pm.locator(':scope > p').first().click()
          await link.hover()
          try {
            await preview.waitFor({ timeout: 3000 })
            break
          } catch (error) {
            if (attempt >= 2) throw error
            await page.mouse.move(0, 0)
            await page.waitForTimeout(300)
          }
        }
        const tooltip = await preview.evaluate((root) => ({
          background: getComputedStyle(root.querySelector('.link-preview')).backgroundColor,
          icons: Array.from(root.querySelectorAll('svg')).map((svg) => ({
            cls: svg.parentElement?.className ?? '',
            color: getComputedStyle(svg).color
          }))
        }))
        assert.equal(tooltip.icons.length, 3, `${label}: copy / edit / remove icons`)
        for (const icon of tooltip.icons) {
          const ratio = contrastRatio(icon.color, tooltip.background)
          assert.ok(
            ratio >= 3,
            `${label}: 链接浮层图标 ${icon.cls} 颜色 ${icon.color} 对浮层 ${tooltip.background} 对比度仅 ${ratio.toFixed(2)}`
          )
        }
      }
      await pm.locator('.label.bullet').first().scrollIntoViewIfNeeded()
      await page.screenshot({
        path: join(shots, `bullets-${mode === '可视化编辑' ? 'visual' : 'readonly'}-${theme}.png`)
      })
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
  }
  assert.equal(readFileSync(noteFile, 'utf8'), source)
  console.log(
    '✓ visual/readonly typography matches; code stays monospace, UI density and Markdown are unchanged'
  )
  console.log('✓ normal/nested/link-only/callout bullets match body text in dark/light themes')
} catch (error) {
  const page = await app.firstWindow()
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app.close()
  rmSync(fixture, { recursive: true, force: true })
}
