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
// 冲突内容：`##` 像标题、`**` 像粗体、`#` 像注释、`-` 像列表 —— 用来证明
// 「代码复制」不会因为文本形态像 Markdown 而被解析
const CODE = [
  '## 这不是标题',
  '**这不是粗体**',
  '# 也不是注释',
  '- 也不是列表',
  '    indented',
  'const c = 3'
].join('\n')
const GROUP_CODE = [
  '## 组内也不是标题',
  '**组内也不是粗体**',
  'group2 = false',
  '    grouped'
].join('\n')
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
    },
    {
      index: '0002',
      title: '空行',
      body: ['# 空行', '', '起点', ''].join('\n')
    }
  ]
})
const noteFile = fixture.notePath('0001', '粘贴')
const blankNoteFile = fixture.notePath('0002', '空行')

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
  // 用**真实复制**（Cmd+C → 哨兵）而不是直接写剪贴板：直接写会绕开来源标记，
  // 等于只测了"按文本形态猜 Markdown"这条旧路
  await page
    .locator('.desk-raw-block--code-group-editable .code-group-panel:visible .cm-content')
    .first()
    .click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+c')
  await new Promise((resolve) => setTimeout(resolve, 400))
  await focusBodyEnd()
  await page.keyboard.press('Enter')
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

  // ── 场景四之二（P1）：粘贴事件必须真的收到「代码来源」标记 ──
  // 复制按钮与 Cmd+C 两条路都要覆盖，且用 `##` / `**` 这类**冲突内容**验证：
  // 如果标记没生效，文本会被 Markdown 解析成标题/粗体，行边界也会丢。
  const readCopied = () => app.evaluate(({ clipboard }) => clipboard.readText())
  const canary = '\u{E0000}\u{E0001}desk-code\u{E0001}'

  // (a) 普通代码块的「复制按钮」
  await page.locator('.milkdown-code-block .tools .copy-button').first().click()
  await new Promise((resolve) => setTimeout(resolve, 400))
  const byButtonRaw = await readCopied()
  rec.record(
    '复制按钮写入的纯文本带代码来源哨兵',
    byButtonRaw.startsWith(canary),
    JSON.stringify(byButtonRaw.slice(0, 40))
  )
  rec.record(
    '复制按钮带出的正文逐字等于代码块内容（哨兵之外）',
    byButtonRaw.slice(canary.length).replace(/\r\n?/g, '\n') === CODE,
    `实得=${JSON.stringify(byButtonRaw.slice(canary.length).slice(0, 80))} 期望=${JSON.stringify(CODE.slice(0, 80))}`
  )

  // (b) 代码块内 Cmd+A / Cmd+C
  await page
    .locator('.milkdown-code-block .preview-toggle-button')
    .first()
    .click()
    .catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 400))
  await page.locator('.milkdown-code-block .cm-content').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+c')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const byKeyRaw = await readCopied()
  rec.record(
    '代码块内 Cmd+C 写入的纯文本带代码来源哨兵',
    byKeyRaw.startsWith(canary),
    JSON.stringify(byKeyRaw.slice(0, 40))
  )
  rec.record(
    '代码块内 Cmd+C 带出的正文逐字等于代码块内容（哨兵之外）',
    byKeyRaw.slice(canary.length).replace(/\r\n?/g, '\n') === CODE,
    `实得=${JSON.stringify(byKeyRaw.slice(canary.length).slice(0, 80))}`
  )

  // (c) 代码组内 Cmd+A / Cmd+C
  const groupCm = page
    .locator('.desk-raw-block--code-group-editable .code-group-panel:visible .cm-content')
    .first()
  if ((await groupCm.count()) > 0) {
    await groupCm.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+c')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const groupRaw = await readCopied()
    rec.record(
      '代码组内 Cmd+C 写入的纯文本带代码来源哨兵',
      groupRaw.startsWith(canary),
      JSON.stringify(groupRaw.slice(0, 40))
    )
    rec.record(
      '代码组内 Cmd+C 带出的正文逐字等于面板内容（哨兵之外）',
      groupRaw.slice(canary.length).replace(/\r\n?/g, '\n') === GROUP_CODE,
      `实得=${JSON.stringify(groupRaw.slice(canary.length).slice(0, 80))}`
    )
  }

  // (d) 端到端：把带哨兵的剪贴板原样粘回正文 —— 冲突内容不得变成标题/粗体
  await focusBodyEnd()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 700))
  const markedPaste = await page
    .locator('.ProseMirror')
    .first()
    .evaluate((root) => ({
      text: root.innerText,
      headings: Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((n) => n.textContent),
      strong: Array.from(root.querySelectorAll('strong')).map((n) => n.textContent),
      listItems: Array.from(root.querySelectorAll('li')).map((n) => (n.textContent ?? '').trim())
    }))
  rec.record(
    '带标记粘贴：`##` 行没有被解析成标题',
    !markedPaste.headings.some((text) => (text ?? '').includes('这不是标题')),
    JSON.stringify(markedPaste.headings)
  )
  rec.record(
    '带标记粘贴：`**` 行没有被解析成粗体',
    !markedPaste.strong.some((text) => (text ?? '').includes('这不是粗体')),
    JSON.stringify(markedPaste.strong)
  )
  rec.record(
    '带标记粘贴：行边界保留（多行都在）',
    ['## 这不是标题', '**这不是粗体**', 'const c = 3'].every((line) =>
      markedPaste.text.includes(line)
    ),
    JSON.stringify(markedPaste.text.slice(-160))
  )

  // ── 场景五 / 六：换到干净的笔记（前面已粘入很多空段落，会污染计数）──
  await openNote(page, { kbName: fixture.kbName, title: '空行' })
  await waitFor(
    async () => (await page.locator('.ProseMirror:visible').first().innerText()).includes('起点'),
    20000
  )
  const blankPm = () => page.locator('.ProseMirror:visible').first()
  const focusBlankEnd = async () => {
    await blankPm().locator('p').filter({ hasText: '起点' }).first().click()
    await page.keyboard.press('End')
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const blankDisk = async () => {
    const text = (await import('node:fs')).readFileSync(blankNoteFile, 'utf8')
    return text.slice(text.indexOf('---', 3) + 4)
  }

  // 纯文本：`ALPHA` + 2 个空行 + `BRAVO`
  await setClipboard('ALPHA\n\n\nBRAVO')
  await focusBlankEnd()
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const blankBetween = await blankPm().evaluate((root) => {
    const text = root.innerText
    const start = text.indexOf('ALPHA')
    const end = text.indexOf('BRAVO')
    return start >= 0 && end > start ? text.slice(start + 'ALPHA'.length, end) : ''
  })
  // 编辑器里每个空段落渲染成 2 个换行（段落之间的空行），2 个空段落 = 4 个换行；
  // 旧的"压成 1 个"实现是 2 个换行。这里要求 ≥4，并核对磁盘侧的具体个数。
  rec.record(
    '粘贴的 2 个空行在编辑器里仍是 2 个（不是被压成 1 个）',
    (blankBetween.match(/\n/g) ?? []).length >= 4,
    `ALPHA 与 BRAVO 之间=${JSON.stringify(blankBetween)}`
  )
  await save()
  const blankDiskText = await blankDisk()
  // 磁盘上每个空段落写成一行（`<br />` 或空行）。旧实现把 2/3 个空行压成同一种结果，
  // 所以这里要求 ALPHA 与 BRAVO 之间**至少有 2 行空行**，而不是恰好隔一行。
  const blankAge = blankDiskText.slice(blankDiskText.indexOf('ALPHA'))
  const blankBetweenDisk = blankAge.slice('ALPHA'.length, blankAge.indexOf('BRAVO'))
  const diskBlankLines = blankBetweenDisk
    .split('\n')
    .filter((line) => line.trim() === '' || /^<br\s*\/?>$/.test(line.trim())).length
  rec.record(
    '保存后磁盘保留 2 个空行（不是 1 个）',
    /ALPHA/.test(blankDiskText) &&
      blankDiskText.indexOf('ALPHA') < blankDiskText.indexOf('BRAVO') &&
      diskBlankLines >= 2,
    `空行行数=${diskBlankLines}；${JSON.stringify(blankBetweenDisk)}`
  )

  // ── 场景六：Markdown 文本仍走原有解析（标题 / 列表 / 围栏代码块）──
  await setClipboard('## 粘进来的标题\n\n- 甲\n- 乙\n\n```js\nconst z = 9\n```')
  // Markdown 块语法只会在**空块**上解析：先回车开一个新段落再粘
  await focusBlankEnd()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 700))
  const mdShape = await blankPm().evaluate((root) => ({
    headings: Array.from(root.querySelectorAll('h2')).map((n) => n.textContent),
    listItems: Array.from(root.querySelectorAll('li')).map((n) =>
      (n.textContent ?? '').replace(/\s+/g, ' ').trim()
    ),
    codeBlocks: root.querySelectorAll('.milkdown-code-block, pre').length
  }))
  rec.record(
    'Markdown 粘贴仍是标题（不是普通正文）',
    mdShape.headings.includes('粘进来的标题'),
    JSON.stringify(mdShape.headings)
  )
  rec.record(
    'Markdown 粘贴仍生成列表项',
    mdShape.listItems.includes('甲') && mdShape.listItems.includes('乙'),
    JSON.stringify(mdShape.listItems)
  )
  rec.record(
    'Markdown 粘贴仍生成代码块',
    mdShape.codeBlocks >= 1,
    `codeBlocks=${mdShape.codeBlocks}`
  )
  const mdDisk = await (async () => {
    await save()
    return blankDisk()
  })()
  rec.record(
    'Markdown 粘贴落盘仍是 Markdown（`## ` 与 `- ` 与围栏）',
    /##\s+粘进来的标题/.test(mdDisk) && /^- 甲$/m.test(mdDisk) && /```/.test(mdDisk),
    JSON.stringify(mdDisk.slice(mdDisk.indexOf('粘进来的标题')).slice(0, 80))
  )

  // 重开核对：空行与 Markdown 结构都要还在
  await save()
  await page.locator('.toc-row', { hasText: '空行' }).first().click()
  await new Promise((resolve) => setTimeout(resolve, 900))
  await waitFor(async () => (await page.locator('.ProseMirror').count()) > 0, 15000)
  await waitFor(
    async () => (await page.locator('.ProseMirror:visible').first().innerText()).includes('ALPHA'),
    20000
  )
  const reopenedShape = await page
    .locator('.ProseMirror:visible')
    .first()
    .evaluate((root) => ({
      text: root.innerText,
      headings: Array.from(root.querySelectorAll('h2')).map((n) => n.textContent),
      listItems: Array.from(root.querySelectorAll('li')).map((n) =>
        (n.textContent ?? '').replace(/\s+/g, ' ').trim()
      )
    }))
  const reopenedBetween = (() => {
    const start = reopenedShape.text.indexOf('ALPHA')
    const end = reopenedShape.text.indexOf('BRAVO')
    return start >= 0 && end > start ? reopenedShape.text.slice(start + 5, end) : ''
  })()
  rec.record(
    '重开后连续空行仍按实际个数保留',
    (reopenedBetween.match(/\n/g) ?? []).length >= 4,
    `ALPHA 与 BRAVO 之间=${JSON.stringify(reopenedBetween)}`
  )
  rec.record(
    '重开后 Markdown 结构（标题 + 列表）仍在',
    reopenedShape.headings.includes('粘进来的标题') &&
      reopenedShape.listItems.includes('甲') &&
      reopenedShape.listItems.includes('乙'),
    JSON.stringify({ headings: reopenedShape.headings, listItems: reopenedShape.listItems })
  )

  // ── 场景七（P2）：Python/Shell/C 风格注释的代码不得被当成 Markdown ──
  await openNote(page, { kbName: fixture.kbName, title: '空行' })
  await waitFor(
    async () => (await page.locator('.ProseMirror:visible').first().innerText()).includes('ALPHA'),
    20000
  )
  const pythonCode = [
    '# 计算总和',
    'def total(xs):',
    '    return sum(xs)',
    '',
    '# 打印结果',
    'print(total([1, 2]))'
  ].join('\n')
  await setClipboard(pythonCode)
  await focusBlankEnd()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const afterPython = await blankPm().evaluate((root) => ({
    text: root.innerText,
    headings: root.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    listItems: root.querySelectorAll('li').length
  }))
  rec.record(
    'Python 注释开头的代码粘贴：不产生标题',
    /# 计算总和\s*\n/.test(afterPython.text.replace(/\n+/g, '\n')),
    JSON.stringify(afterPython.text.slice(-120))
  )
  rec.record(
    'Python 注释开头的代码粘贴：行边界保留（不是一行空格分隔）',
    afterPython.text.includes('def total(xs):') &&
      afterPython.text.includes('print(total([1, 2]))'),
    JSON.stringify(afterPython.text.slice(-160))
  )
  await save()
  const pythonDisk = await blankDisk()
  rec.record(
    'Python 代码落盘仍是多行（# 注释没被吃成标题）',
    pythonDisk.includes('# 计算总和') &&
      pythonDisk.includes('def total(xs):') &&
      !/^#\s+计算总和\s*$/m.test(pythonDisk.split('\n').slice(0, 3).join('\n')),
    JSON.stringify(pythonDisk.slice(pythonDisk.indexOf('# 计算总和')).slice(0, 80))
  )

  // ── 场景八（P2）：行内语法的 Markdown 仍要被识别 ──
  const inlineMd = ['这是**粗体**文字', '', '见 [文档](https://example.com/a)'].join('\n')
  await setClipboard(inlineMd)
  await focusBlankEnd()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const inlineShape = await blankPm().evaluate((root) => ({
    strong: Array.from(root.querySelectorAll('strong')).map((n) => n.textContent),
    links: Array.from(root.querySelectorAll('a')).map((n) => n.getAttribute('href'))
  }))
  rec.record(
    '行内 Markdown（`**粗体**` / 链接）仍被解析',
    inlineShape.strong.includes('粗体') &&
      inlineShape.links.some((href) => (href ?? '').includes('example.com/a')),
    JSON.stringify(inlineShape)
  )

  // 重开核对：代码与 Markdown 的结构都还在
  await save()
  await page.locator('.toc-row', { hasText: '空行' }).first().click()
  await new Promise((resolve) => setTimeout(resolve, 900))
  await waitFor(
    async () => (await page.locator('.ProseMirror:visible').first().innerText()).includes('ALPHA'),
    20000
  )
  const reopened2 = await blankPm().evaluate((root) => ({
    text: root.innerText,
    strong: Array.from(root.querySelectorAll('strong')).map((n) => n.textContent)
  }))
  rec.record(
    '重开后 Python 代码仍是多行文本',
    reopened2.text.includes('def total(xs):') && reopened2.text.includes('# 计算总和'),
    JSON.stringify(reopened2.text.slice(-120))
  )
  rec.record(
    '重开后行内 Markdown 结构仍在',
    reopened2.strong.includes('粗体'),
    JSON.stringify(reopened2.strong)
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
