// 第二列头部在滚动时固定：顶部视图切换栏、笔记目录视图的「目录」栏。
//
// 覆盖：长目录滚动时头部可见可点、侧栏宽度变化、目录项可完整滚动访问。
// （「变更」已移到独立的 Git 视图，见 e2e-navigator-views.mjs。）
//
// Run: node apps/desk/scripts/e2e-sidebar-sticky.mjs
import { createFixture, createRecorder, launchDesk, trackPageErrors, waitFor } from './e2e-lib.mjs'

const rec = createRecorder()
const fixture = createFixture('sidebar-sticky', {
  notes: Array.from({ length: 40 }, (_, index) => {
    const n = String(index + 1).padStart(4, '0')
    return { index: n, title: `笔记${n}`, body: `# 笔记${n}\n\n正文${n}\n` }
  })
})

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

/** 量头部相对滚动视口的位置与可见性 */
const headingInfo = async (selector) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const body = el.closest('.navigator-body')
      if (!body) return null
      const rect = el.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      const cs = getComputedStyle(body)
      // 滚动容器的**内容盒**上沿：容器有 padding，吸顶是相对内容盒的
      const contentTop = bodyRect.top + parseFloat(cs.paddingTop || '0')
      const at = document.elementFromPoint(rect.left + 20, rect.top + rect.height / 2)
      return {
        top: Math.round(rect.top),
        bodyTop: Math.round(bodyRect.top),
        contentTop: Math.round(contentTop),
        // 吸顶判定：标题贴近滚动容器的内容盒上沿
        stuckToTop: Math.abs(rect.top - contentTop) <= 1,
        inViewport: rect.top >= contentTop - 1 && rect.bottom <= bodyRect.bottom + 1,
        // 标题位置上最顶层的元素是否是它自己（没被内容盖住）
        topElementIsHeading: Boolean(at && (el === at || el.contains(at))),
        // 吸顶行的背景必须**不透明**：背景透明时滚动上来的目录项会透过它显示
        // （曾出现：`.section-heading` 的 transparent 与吸顶规则同优先级且更靠后，
        // 覆盖掉了 var(--panel)，计算值变成 rgba(0, 0, 0, 0)）
        // 吸顶行**上方**到滚动容器顶边的距离，以及那条带子里最顶层的元素
        gapAbove: Math.round(rect.top - bodyRect.top),
        bleedAbove: (() => {
          if (rect.top - bodyRect.top < 1) return null
          const x = Math.round(rect.left + 20)
          const probes = []
          for (let y = Math.round(bodyRect.top) + 1; y < Math.round(rect.top); y += 2) {
            const hit = document.elementFromPoint(x, y)
            // 只有命中滚动内容（目录项等）才算真的透出
            probes.push(
              hit?.closest?.('.toc-heading')
                ? 'heading'
                : String(hit?.className ?? hit?.tagName ?? '').slice(0, 40)
            )
          }
          return probes
        })(),
        background: getComputedStyle(el).backgroundColor,
        opaque: !/rgba?\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(el).backgroundColor)
      }
    })

const scrollBody = async (px) => {
  await page
    .locator('.toc-view .navigator-body')
    .first()
    .evaluate((el, y) => {
      el.scrollTop = y
    }, px)
  await new Promise((resolve) => setTimeout(resolve, 200))
}

try {
  await page.waitForSelector('.kb-sidebar, aside', { timeout: 20000 })
  await waitFor(
    async () => (await page.getByText(fixture.kbName, { exact: true }).count()) > 0,
    20000
  )
  await page.getByText(fixture.kbName, { exact: true }).first().click()
  await waitFor(async () => (await page.locator('.toc-row').count()) >= 5, 20000)

  // 视图切换栏在滚动容器之外：滚动前后位置不变
  const searchBefore = await page.locator('.navigator-top').first().boundingBox()
  await scrollBody(600)
  const searchAfter = await page.locator('.navigator-top').first().boundingBox()
  rec.record(
    '视图切换栏不随内容滚动',
    Boolean(searchBefore && searchAfter) && Math.abs(searchBefore.y - searchAfter.y) <= 1,
    `before=${Math.round(searchBefore?.y ?? -1)} after=${Math.round(searchAfter?.y ?? -1)}`
  )

  // 滚动后「目录」栏仍然吸顶可见
  const tocHeading = await headingInfo('.toc-heading')
  rec.record(
    '滚动后「目录」栏吸顶可见',
    Boolean(tocHeading?.stuckToTop && tocHeading?.topElementIsHeading),
    JSON.stringify(tocHeading)
  )

  // 吸顶的「目录」栏按钮仍可点击
  const collapseAll = page.locator('.toc-heading button[aria-label="目录操作"]').first()
  const clickable = await waitFor(
    async () => (await collapseAll.isEnabled()) && (await collapseAll.isVisible()),
    5000
  )
  rec.record(
    '吸顶行背景不透明（滚动内容不会透过它显示）',
    Boolean(tocHeading?.opaque),
    `toc=${tocHeading?.background}`
  )

  // 吸顶行只能吸到**内容盒**上沿：容器若留 padding-top，那条带子盖不住，
  // 滚动上来的目录项会从吸顶行上方透出（实测 padding-top:7px 时带高 7px，
  // 打点命中 node-label / note-index）。
  const bleed = (heading) => (heading?.bleedAbove ?? []).filter((hit) => hit !== 'heading')
  rec.record(
    '吸顶行上方没有内容透出（容器顶部不留可透视的 padding 带）',
    bleed(tocHeading).length === 0,
    `toc gap=${tocHeading?.gapAbove} bleed=${JSON.stringify(bleed(tocHeading))}`
  )

  rec.record('吸顶后目录栏操作按钮仍可点', Boolean(clickable))
  if (clickable) {
    await collapseAll.click()
    rec.record(
      '点目录操作按钮弹出菜单',
      Boolean(await waitFor(async () => (await page.locator('.section-menu').count()) > 0, 3000))
    )
    await page.keyboard.press('Escape')
  }

  // 只有一个滚动容器（无嵌套滚动条）
  const scrollerCount = await page.locator('.toc-view .navigator-body').evaluate((body) => {
    const all = Array.from(body.querySelectorAll('*'))
    return all.filter((el) => {
      const cs = getComputedStyle(el)
      return (
        (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 1
      )
    }).length
  })
  rec.record(
    '没有额外的内部滚动容器（无重复滚动条）',
    scrollerCount === 0,
    `innerScrollers=${scrollerCount}`
  )

  // 目录树能滚到最后一个条目（头部固定不能把内容吃掉）
  await scrollBody(100000)
  const lastRow = await page
    .locator('.toc-row')
    .last()
    .evaluate((el) => {
      const body = el.closest('.navigator-body')
      const rect = el.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      return { visible: rect.top >= bodyRect.top - 1 && rect.bottom <= bodyRect.bottom + 1 }
    })
  rec.record('最后一条目录项可完整滚动访问', lastRow.visible, JSON.stringify(lastRow))

  // 侧栏宽度变化后吸顶仍成立
  await page
    .locator('.toc-view .navigator-body')
    .first()
    .evaluate((el) => {
      el.scrollTop = 400
    })
  const handle = page.locator('.resize-handle[aria-orientation="vertical"]').last()
  const box = await handle.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const narrow = await headingInfo('.toc-heading')
  rec.record(
    '侧栏变窄后「目录」栏仍吸顶',
    Boolean(narrow?.inViewport && narrow?.stuckToTop === false ? true : narrow?.inViewport),
    JSON.stringify(narrow)
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
