// 源码视图（Monaco）的 Unicode 高亮：中文全角标点不得再出现黄色警告框，
// 同时**保留**异常不可见字符与其它易混淆字符的提示能力。
//
// 背景：Monaco 的 `unicodeHighlight.allowedLocales` 默认只有 `{ _os, _vscode }`，
// 解析后若都落不到内置语言表上，就回退到兜底表 `_default` —— 那里把 `（）` `，` `；`
// `？` 等全角标点判为“与半角字符易混淆”。只有在**紧邻 ASCII / 数字词**时才真的会画框
// （贴着中文词时 Monaco 会因为“词里没有 ASCII”而放过），所以探针用混排行才有效。
// 显式允许 zh-hans / zh-hant 后，语言表按交集取，`_default` 不再生效；
// 不可见字符（`_common`）与西里尔/拉丁这类真混淆字符仍会提示。
//
// 断言对应用户行为：按**行**数黄框数量，且先等到“该提示的行确实提示了”再断言
// “不该提示的行为 0”，避免高亮还没算完导致的假通过。
//
// Run: node apps/desk/scripts/e2e-source-unicode-highlight.mjs
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/** 中文全角标点：纯中文行（修复前也不提示）/ 与数字混排（修复前会提示） */
const PUNCTUATION_CJK_LINE = '中文标点（示例），分号；问号？感叹号！'
const PUNCTUATION_MIXED_LINE = '输出（1），输入；2，结束。'
const PUNCTUATION_LATIN_LINE = 'return (a)， value； done！'
/** 真混淆字符：pаypal 里的 а 是西里尔 U+0430（与拉丁 a 同形） */
const CONFUSABLE_LINE = '混排单词 pаypal 检查'
/** 异常不可见字符：U+200E LRM，夹在 ASCII 词里 */
const INVISIBLE_LINE = '不可见 abc\u200edef 检查'

const fixture = createFixture('src-unicode-highlight', {
  notes: [
    {
      index: '0001',
      title: '标点',
      body: [
        '# 标点检查',
        '',
        PUNCTUATION_CJK_LINE,
        '',
        PUNCTUATION_MIXED_LINE,
        '',
        PUNCTUATION_LATIN_LINE,
        '',
        CONFUSABLE_LINE,
        '',
        INVISIBLE_LINE,
        ''
      ].join('\n')
    }
  ]
})
const noteFile = fixture.notePath('0001', '标点')
const shots = join(deskDir, 'scripts', 'shots', 'source-unicode-highlight')
mkdirSync(shots, { recursive: true })

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

/**
 * 收集当前源码视图里的 unicode 高亮：Monaco 把这类装饰画在 overlay 层
 * （`.cdr.unicode-highlight` 的方块），方块自身不带文本，所以按**竖直位置**归到 `.view-line`。
 * Monaco 用 `\u00a0` 渲染空白，比较前统一还原成普通空格。
 */
const collectHighlights = async () =>
  page
    .locator('.markdown-source-editor')
    .first()
    .evaluate((root) => {
      const lines = [...root.querySelectorAll('.view-line')].map((node) => ({
        rect: node.getBoundingClientRect(),
        text: (node.textContent ?? '').replace(/\u00a0/g, ' ')
      }))
      return [...root.querySelectorAll('.unicode-highlight')].map((node) => {
        const rect = node.getBoundingClientRect()
        // 用方块的**竖直中心**归行：相邻行的 rect 首尾相接（上一行 bottom == 下行 top），
        // 拿 top 加容差去比会先命中上一行（空白行），文本就取成空串。
        const center = rect.top + rect.height / 2
        const line = lines.find((item) => center > item.rect.top && center < item.rect.bottom)
        return { text: line?.text ?? '', top: Math.round(rect.top), width: Math.round(rect.width) }
      })
    })

const countOn = (highlights, needle) =>
  highlights.filter((item) => item.text.includes(needle)).length

const setTheme = async (theme) => {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value
  }, theme)
  await page.waitForTimeout(400)
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '标点' })
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

  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    // 先等到“该提示的两行确实提示了”，再断言“中文标点行没有提示”
    // —— 否则高亮还没算完时 0 个方块会变成假通过。
    const active = await waitFor(async () => {
      const list = await collectHighlights()
      const confusable = countOn(list, 'pаypal')
      const invisible = countOn(list, 'abc')
      return confusable >= 1 && invisible >= 1 ? list : null
    }, 15000)
    rec.record(
      `${theme}：高亮计算已生效（真混淆与不可见字符仍有提示）`,
      Boolean(active),
      active
        ? `西里尔=${countOn(active, 'pаypal')} LRM=${countOn(active, 'abc')}`
        : '未在 15s 内算出高亮'
    )

    const highlights = active ?? (await collectHighlights())
    const summary = JSON.stringify(highlights.map((item) => item.text.slice(0, 20)))
    rec.record(
      `${theme}：中文全角标点不再有警告框（纯中文行）`,
      countOn(highlights, '中文标点') === 0,
      `高亮=${countOn(highlights, '中文标点')}；全部=${summary}`
    )
    rec.record(
      `${theme}：中文全角标点不再有警告框（与数字混排行）`,
      countOn(highlights, '输出') === 0,
      `高亮=${countOn(highlights, '输出')}；全部=${summary}`
    )
    rec.record(
      `${theme}：中文全角标点不再有警告框（与拉丁文混排行）`,
      countOn(highlights, 'return') === 0,
      `高亮=${countOn(highlights, 'return')}；全部=${summary}`
    )
    rec.record(
      `${theme}：易混淆字符仍会提示（西里尔 а）`,
      countOn(highlights, 'pаypal') >= 1,
      `高亮=${countOn(highlights, 'pаypal')}`
    )
    rec.record(
      `${theme}：异常不可见字符仍会提示（LRM）`,
      countOn(highlights, 'abc') >= 1,
      `高亮=${countOn(highlights, 'abc')}`
    )
    await page.screenshot({ path: join(shots, `source-unicode-highlight-${theme}.png`) })
  }

  rec.record(
    '查看 / 切换主题没有改动文档',
    readFileSync(noteFile, 'utf8') === before,
    `chars=${before.length}`
  )
  const dirty = await page.locator('.tab .dirty-dot:visible').count()
  rec.record('查看 / 切换主题没有把标签标脏', dirty === 0, `dirtyDots=${dirty}`)

  rec.record('无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
} catch (error) {
  rec.record('验收脚本执行', false, error instanceof Error ? error.message : String(error))
  await page
    .screenshot({ path: join(shots, 'source-unicode-highlight-failure.png') })
    .catch(() => {})
} finally {
  await app.close()
  fixture.cleanup()
}

rec.finish()
