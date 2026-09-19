// 第 2 项验收：代码块不自动折行（普通代码块与多标签代码组口径统一）。
//
// 要求：保留源码真实换行；长行不折、在块内横向滚动；不撑宽整个页面；
// 高度仍由内容撑开（无 max-height、无内部纵向滚动）；折叠/全屏/编辑/切 tab 不受影响。
//
// Run: node apps/desk/scripts/e2e-code-wrap.mjs
import {
  createFixture,
  createRecorder,
  launchDesk,
  openNote,
  trackPageErrors,
  waitFor
} from './e2e-lib.mjs'

const rec = createRecorder()
const LONG = 'LONG_LINE_'.repeat(40) // 约 400 字符
const fixture = createFixture('code-wrap', {
  notes: [
    {
      index: '0001',
      title: '代码块',
      body: [
        '# 代码块',
        '',
        '```js',
        `const long = "${LONG}"`,
        'const second = 2',
        '',
        'const third = 3',
        '```',
        '',
        '::: code-group',
        '',
        '```js [a.js]',
        `groupA = "${LONG}"`,
        '```',
        '',
        '```ts [b.ts]',
        'groupB = 1',
        '```',
        '',
        ':::',
        ''
      ].join('\n')
    }
  ]
})

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

/** 量一个块：内容是否折行、能否横向滚动、是否撑破页面。 */
const measure = async (selector) =>
  page
    .locator(selector)
    .first()
    .evaluate((root) => {
      const scroller = root.querySelector('.cm-scroller') ?? root
      const content = root.querySelector('.cm-content') ?? root
      const cs = getComputedStyle(scroller)
      const pageEl = document.querySelector('.ProseMirror')
      return {
        whiteSpace: getComputedStyle(content).whiteSpace,
        overflowX: cs.overflowX,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        // 内容比可视区宽 → 说明没有折行（折行会让 scrollWidth 收敛到 clientWidth）
        overflows: scroller.scrollWidth > scroller.clientWidth + 1,
        maxHeight: cs.maxHeight,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        pageScrollWidth: pageEl ? pageEl.scrollWidth : 0,
        pageClientWidth: pageEl ? pageEl.clientWidth : 0,
        innerHeight: content.clientHeight
      }
    })

try {
  await openNote(page, { kbName: fixture.kbName, title: '代码块' })
  await waitFor(async () => (await page.locator('.milkdown-code-block').count()) > 0, 20000)
  await new Promise((resolve) => setTimeout(resolve, 800))

  // 普通代码块：需要进入编辑态（previewOnlyByDefault）才能量到 CodeMirror 内容
  await page
    .locator('.milkdown-code-block .preview-toggle-button')
    .first()
    .click()
    .catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 600))

  const plainCount = await page.locator('.milkdown-code-block:not(.desk-code-tab)').count()
  rec.record('普通代码块存在', plainCount > 0, `count=${plainCount}`)

  const plain = await measure('.milkdown-code-block:not(.desk-code-tab)')
  rec.record(
    '普通代码块：长行不折行（内容宽于可视区，可横向滚动）',
    plain.overflows && plain.overflowX !== 'hidden',
    `overflowX=${plain.overflowX} scrollW=${plain.scrollWidth} clientW=${plain.clientWidth} whiteSpace=${plain.whiteSpace}`
  )
  rec.record(
    '普通代码块：不撑宽页面',
    plain.pageScrollWidth <= plain.pageClientWidth + 1,
    `page=${plain.pageScrollWidth}/${plain.pageClientWidth}`
  )
  rec.record(
    '普通代码块：不设最大高度（高度由内容撑开）',
    plain.maxHeight === 'none',
    `maxHeight=${plain.maxHeight}`
  )

  // 代码组：切到第二个 tab 再量，确认长行同样不折
  const tabsBar = page.locator('.code-group-tabs')
  const groupExists = (await tabsBar.count()) > 0
  rec.record('代码组存在', groupExists, `code-group-tabs=${await tabsBar.count()}`)
  if (groupExists) {
    const tabs = page.locator('.code-group-tab')
    // 切到第一个 tab（内容里有超长行）
    await tabs.nth(0).click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const groupMeasure = await tabsBar.first().evaluate((bar) => {
      // 活动面板：tab 条之后的 .code-group-panels 里 display 不为 none 的面板
      const container = bar.closest('.desk-raw-block, .code-group') ?? bar.parentElement
      const panels = Array.from(container ? container.querySelectorAll('.code-group-panel') : [])
      const panel = panels.find((p) => getComputedStyle(p).display !== 'none') ?? panels[0]
      const scroller = panel?.querySelector('.cm-scroller')
      if (!scroller) return null
      const cs = getComputedStyle(scroller)
      const pageEl = document.querySelector('.ProseMirror')
      return {
        overflowX: cs.overflowX,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        overflows: scroller.scrollWidth > scroller.clientWidth + 1,
        maxHeight: cs.maxHeight,
        whiteSpace: getComputedStyle(panel.querySelector('.cm-content') ?? scroller).whiteSpace,
        pageScrollWidth: pageEl ? pageEl.scrollWidth : 0,
        pageClientWidth: pageEl ? pageEl.clientWidth : 0
      }
    })
    rec.record(
      '代码组：长行不折行（块内横向滚动）',
      Boolean(groupMeasure) && groupMeasure.overflows && groupMeasure.overflowX !== 'hidden',
      JSON.stringify(groupMeasure)
    )
    rec.record(
      '代码组：不设最大高度',
      Boolean(groupMeasure) && groupMeasure.maxHeight === 'none',
      `maxHeight=${groupMeasure?.maxHeight}`
    )
    rec.record(
      '代码组：不撑宽页面',
      Boolean(groupMeasure) && groupMeasure.pageScrollWidth <= groupMeasure.pageClientWidth + 1,
      `page=${groupMeasure?.pageScrollWidth}/${groupMeasure?.pageClientWidth}`
    )
  }

  // 折叠仍然可用
  const collapseButton = page.locator('.desk-code-collapse').first()
  const hasCollapse = (await collapseButton.count()) > 0
  if (hasCollapse) {
    await collapseButton.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const collapsed = await page.locator('.milkdown-code-block.is-collapsed').count()
    await collapseButton.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    rec.record('折叠/展开仍可用', collapsed > 0, `collapsed=${collapsed}`)
  } else {
    rec.record('折叠/展开仍可用', false, '未找到折叠按钮')
  }

  // 重新打开笔记：仍不折行（口径持久）
  await page.locator('.toc-row', { hasText: '代码块' }).first().click()
  await new Promise((resolve) => setTimeout(resolve, 800))
  await waitFor(async () => (await page.locator('.milkdown-code-block').count()) > 0, 20000)
  const replain = await measure('.milkdown-code-block:not(.desk-code-tab)')
  rec.record(
    '重开后仍不折行',
    replain.overflows || replain.whiteSpace !== 'break-spaces',
    `whiteSpace=${replain.whiteSpace} overflows=${replain.overflows}`
  )

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  console.log('调试：页面错误', pageErrors.join(' | ').slice(0, 500))
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
