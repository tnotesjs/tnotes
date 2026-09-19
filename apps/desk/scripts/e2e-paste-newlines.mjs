// 第 9 项：代码块内容粘贴到可视化正文保留换行。
//
// 期望：复制代码块里的多行内容到正文，行边界保留，不变成一行空格分隔的文本。
// 需要分别检查：复制按钮 / 选中后 Cmd+C / 普通代码块与代码组 / 纯文本与带 HTML。
//
// Run: node apps/desk/scripts/e2e-paste-newlines.mjs
import {
  createFixture,
  createRecorder,
  launchDesk,
  openNote,
  trackPageErrors,
  waitFor
} from './e2e-lib.mjs'

const rec = createRecorder()
const CODE = ['const a = 1', '', 'const b = 2', '    indented', 'const c = 3'].join('\n')
const GROUP_CODE = ['group1 = true', 'group2 = false', '    grouped'].join('\n')
const fixture = createFixture('paste-newlines', {
  notes: [
    {
      index: '0001',
      title: '粘贴',
      body: [
        '# 粘贴',
        '',
        '```js',
        CODE,
        '```',
        '',
        '::: code-group',
        '',
        '```js [a.js]',
        GROUP_CODE,
        '```',
        '',
        '```ts [b.ts]',
        'const t: number = 1',
        '```',
        '',
        ':::',
        '',
        '正文起点',
        ''
      ].join('\n')
    }
  ]
})
const noteFile = fixture.notePath('0001', '粘贴')

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

const diskBody = async () => {
  const text = (await import('node:fs')).readFileSync(noteFile, 'utf8')
  return text.slice(text.indexOf('---', 3) + 4)
}
const save = async () => {
  await page.keyboard.press('ControlOrMeta+s')
  await new Promise((resolve) => setTimeout(resolve, 900))
}
/** 主进程写剪贴板（渲染端 clipboard-write 权限在自动化里会被拒） */
const setClipboard = async (text) =>
  app.evaluate(({ clipboard }, value) => {
    clipboard.writeText(value)
    return true
  }, text)
/** 把光标放到正文末尾 */
const focusBodyEnd = async () => {
  const paragraph = page.locator('.ProseMirror p').filter({ hasText: '正文起点' }).first()
  await paragraph.click()
  await page.keyboard.press('End')
  await new Promise((resolve) => setTimeout(resolve, 150))
}
/** 正文里"粘贴"这一段之后的文本 */
const pastedText = async () =>
  page
    .locator('.ProseMirror')
    .first()
    .evaluate((root) => {
      const text = root.innerText
      const index = text.indexOf('正文起点')
      return index >= 0 ? text.slice(index + '正文起点'.length).trim() : ''
    })

try {
  await openNote(page, { kbName: fixture.kbName, title: '粘贴' })
  await waitFor(async () => (await page.locator('.milkdown-code-block').count()) > 0, 20000)

  // 打开代码块编辑态并全选复制（走真实 Cmd+C）
  await page
    .locator('.milkdown-code-block .preview-toggle-button')
    .first()
    .click()
    .catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 500))
  const cm = page.locator('.milkdown-code-block .cm-content').first()
  await cm.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+c')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  rec.record(
    'Cmd+C 复制到剪贴板的是多行文本',
    copied.split('\n').length >= 4 && copied.includes('indented'),
    JSON.stringify(copied.slice(0, 80))
  )

  // 粘贴到正文
  await focusBodyEnd()
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const inEditor = await pastedText()
  rec.record(
    '粘贴后正文保留行边界（不是一行空格分隔）',
    inEditor.split('\n').filter((line) => line.trim()).length >= 4 && inEditor.includes('indented'),
    JSON.stringify(inEditor.slice(0, 120))
  )
  await save()
  const onDisk = await diskBody()
  const bodyAfterPaste = onDisk.slice(onDisk.indexOf('正文起点'))
  // 段落里的换行是 Markdown 硬换行（行尾 `\`），缩进是 mdast 的转义写法
  // （`&#x20;   indented`，0x20 空格实体 + 3 个字面空格）。两者都是既有序列化路径，
  // 不是粘贴引入的；这里断言"换行边界 + 缩进"落盘，再由下面的重开断言证明语义等价。
  rec.record(
    '保存后磁盘保留换行边界',
    /\\\n/.test(bodyAfterPaste) && bodyAfterPaste.trim().split('\n').length >= 4,
    JSON.stringify(bodyAfterPaste.trim().slice(0, 140))
  )
  rec.record(
    '保存后磁盘保留行首缩进（含转义写法）',
    /&#x20;/.test(bodyAfterPaste) || /\n {4}indented/.test(bodyAfterPaste),
    JSON.stringify(bodyAfterPaste.match(/^.*indented.*$/m)?.[0] ?? '')
  )
  // 重开核对：磁盘内容再解析回编辑器后，文本必须与粘贴时一致。
  await page.locator('.toc-row', { hasText: '粘贴' }).first().click()
  await new Promise((resolve) => setTimeout(resolve, 800))
  await waitFor(async () => (await page.locator('.ProseMirror').count()) > 0, 15000)
  const reopened = await pastedText()
  rec.record(
    '保存重开后正文与粘贴结果逐字一致（不是视觉假象）',
    reopened === inEditor,
    `重开=${JSON.stringify(reopened.slice(0, 120))} 粘贴=${JSON.stringify(inEditor.slice(0, 120))}`
  )

  // ── 场景二：代码块标题栏的「复制」按钮 ────────────────────────────────
  const copyButton = page.locator('.milkdown-code-block .tools .copy-button').first()
  const hasCopyButton = (await copyButton.count()) > 0
  rec.record('普通代码块标题栏有复制按钮', hasCopyButton, `count=${await copyButton.count()}`)
  if (hasCopyButton) {
    await copyButton.click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    const byButton = await app.evaluate(({ clipboard }) => clipboard.readText())
    rec.record(
      '复制按钮写入剪贴板的是多行文本',
      byButton.split('\n').length >= 4 && byButton.includes('indented'),
      JSON.stringify(byButton.slice(0, 80))
    )
  }

  // ── 场景三：代码组（tab 面板）里的内容 ────────────────────────────────
  const groupedTabs = page.locator('.desk-raw-block--code-group-editable .code-group-tab')
  rec.record(
    '代码组渲染出 tab',
    (await groupedTabs.count()) > 0,
    `count=${await groupedTabs.count()}`
  )
  await setClipboard(GROUP_CODE)
  await focusBodyEnd()
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const groupedInEditor = await pastedText()
  // 断言粘贴进去的那段逐字保留（含行首缩进），而不是只看整段行数
  rec.record(
    '代码组里的多行内容粘到正文同样保留行边界',
    groupedInEditor.includes(GROUP_CODE),
    `期望包含=${JSON.stringify(GROUP_CODE)} 实得=${JSON.stringify(groupedInEditor.slice(0, 160))}`
  )

  // ── 场景四：带 text/html 的剪贴板（富文本语义不能被改掉）──────────────
  await app.evaluate(
    ({ clipboard }, value) => {
      clipboard.write({ text: value.plain, html: value.html })
      return true
    },
    {
      plain: '纯文本一行',
      html: '<p>带格式的<strong>粗体</strong>一行</p>'
    }
  )
  await focusBodyEnd()
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const richText = await page
    .locator('.ProseMirror')
    .first()
    .evaluate((root) => root.innerText.slice(root.innerText.indexOf('正文起点')))
  rec.record(
    '带 HTML 的粘贴仍走富文本（粗体保留，不被纯文本分支接管）',
    richText.includes('粗体') && !richText.includes('纯文本一行'),
    JSON.stringify(richText.slice(0, 120))
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
