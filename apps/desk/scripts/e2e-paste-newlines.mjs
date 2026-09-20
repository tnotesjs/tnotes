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
// 「末尾换行 + 中间多个空行」：代码块最后一行是空行时，末尾换行会被保留下来
// （markdown 围栏会吃掉紧贴闭合围栏的空行，所以这里只留一个末尾空行）
const TAILING_BLANK_LINES = ['## 冲突标题样式', '**不是粗体**', '', '', 'const tail = 1', ''].join(
  '\n'
)
const JSON_CODE = '{"a": 1, "b": [2, 3]}'
// 合法 JS：用来验证「复制读回值仍能被解析器接受」（`CODE` 故意是非法 JS，不能拿来 parse）
const JS_CODE = 'const sum = (a, b) => a + b;\nconsole.log(sum(1, 2))'
const PYTHON_CODE = [
  '# 计算总和',
  'def total(xs):',
  '    """**返回**和"""',
  '    return sum(xs)'
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
        '```js',
        TAILING_BLANK_LINES,
        '```',
        '',
        '```json',
        JSON_CODE,
        '```',
        '',
        '```py',
        PYTHON_CODE,
        '```',
        '',
        '```js',
        JS_CODE,
        '```',
        '',
        '正文起点',
        ''
      ].join('\n')
    },
    {
      index: '0002',
      title: '空行',
      body: ['# 空行', '', '起点', ''].join('\n')
    },
    {
      // 代码组的完整性单独在一篇干净笔记里验证：本套件前面会编辑正文/代码块，
      // Milkdown 会因此重建节点，拿同一篇里的面板做基准会被自己的编辑污染
      index: '0003',
      title: '代码组',
      body: [
        '# 代码组',
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
        ''
      ].join('\n')
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

  // ── 场景四之二（第五轮验收）：复制数据完整性 + 来源走独立格式 ──
  // 硬要求：复制后的纯文本**直接与原始选区比较**，不得先剥标记 / trim / 裁剪再比。
  const readCopied = () => app.evaluate(({ clipboard }) => clipboard.readText())
  const readFormats = () => app.evaluate(({ clipboard }) => clipboard.availableFormats())
  const SELECTION = CODE

  /**
   * 代码块在编辑器里的**真实内容**（ground truth）。
   *
   * 直接读 CodeMirror 状态（`.cm-content` 上的 `cmTile.view.state`），而不是拿脚本里的
   * 常量去猜：markdown 围栏会吃掉紧贴闭合围栏的空行，只有从编辑器取才能拿到
   * "用户实际看到并复制的那份文本"。
   */
  const codeBlockSource = (index) =>
    page.evaluate((i) => {
      const el = document.querySelectorAll('.milkdown-code-block .cm-content')[i]
      const state = el?.cmTile?.view?.state
      return state ? state.doc.sliceString(0, state.doc.length) : null
    }, index)
  /** 第 index 个代码块本体（复制按钮、展开按钮都在它下面） */
  const blockAt = (index) => page.locator('.milkdown-code-block').nth(index)
  const expandBlock = async (index) => {
    const block = blockAt(index)
    // 有的代码块直接在编辑态（没有预览切换按钮），所以旧实现会 30s 超时；
    // 先试着切编辑态，没有就点内容本身让 CodeMirror 拿到焦点
    const toggle = block.locator('.preview-toggle-button').first()
    if ((await toggle.count()) > 0) {
      await toggle.click().catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    await block.locator('.cm-content').first().click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    return block
  }
  /** 走「复制按钮」真实复制，返回编辑器里的原文与剪贴板读回值 */
  const copyByButtonAt = async (index) => {
    const source = await codeBlockSource(index)
    await blockAt(index).locator('.tools .copy-button').first().click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return { source, copied: await readCopied() }
  }
  /** 走「代码块内 Cmd+A / Cmd+C」真实复制 */
  const copyByKeyAt = async (index) => {
    const source = await codeBlockSource(index)
    const block = await expandBlock(index)
    await block.locator('.cm-content').first().click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+c')
    await new Promise((resolve) => setTimeout(resolve, 400))
    return { source, copied: await readCopied() }
  }
  const normalize = (text) => (text ?? '').replace(/\r\n?/g, '\n')

  // (a) 普通代码块的「复制按钮」
  await page.locator('.milkdown-code-block .tools .copy-button').first().click()
  await new Promise((resolve) => setTimeout(resolve, 400))
  const byButtonText = await readCopied()
  rec.record(
    '复制按钮：text/plain 与原始选区逐字一致（不剥标记、不 trim、不裁剪）',
    byButtonText.replace(/\r\n?/g, '\n') === SELECTION,
    `实得=${JSON.stringify(byButtonText)} 期望=${JSON.stringify(SELECTION)}`
  )
  rec.record(
    '复制按钮：来源标记在**独立格式**里，纯文本里没有额外字符',
    (await readFormats()).includes('application/x-desk-code') &&
      !byButtonText.includes('desk-code'),
    JSON.stringify(await readFormats())
  )

  // (b) 代码块内 Cmd+A / Cmd+C（含末尾换行：选区是整段，内容以 \n 结尾）
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
  const byKeyText = await readCopied()
  rec.record(
    '代码块 Cmd+C：text/plain 与原始选区逐字一致',
    byKeyText.replace(/\r\n?/g, '\n') === SELECTION,
    `实得=${JSON.stringify(byKeyText)} 期望=${JSON.stringify(SELECTION)}`
  )
  rec.record(
    '代码块 Cmd+C：来源标记在独立格式里',
    (await readFormats()).includes('application/x-desk-code'),
    JSON.stringify(await readFormats())
  )

  // (d) 粘到正文：内容与选区一致（冲突内容不得被解析成标题/粗体）
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
      strong: Array.from(root.querySelectorAll('strong')).map((n) => n.textContent)
    }))
  rec.record(
    '带标记粘贴到正文：`##` 行没被解析成标题、`**` 行没被解析成粗体',
    !markedPaste.headings.some((text) => (text ?? '').includes('这不是标题')) &&
      !markedPaste.strong.some((text) => (text ?? '').includes('这不是粗体')),
    JSON.stringify({ headings: markedPaste.headings, strong: markedPaste.strong })
  )
  rec.record(
    '带标记粘贴到正文：每一行都与选区一致',
    SELECTION.split('\n').every((line) => markedPaste.text.includes(line)),
    JSON.stringify(markedPaste.text.slice(-160))
  )

  // (e) 粘到**另一个代码块**：内容逐字一致（代码块不被当作 Markdown）
  await page
    .locator('.milkdown-code-block .preview-toggle-button')
    .first()
    .click()
    .catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 400))
  const secondCm = page.locator('.milkdown-code-block .cm-content').nth(0)
  await secondCm.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const inCodeBlock = await secondCm.evaluate((node) =>
    Array.from(node.querySelectorAll('.cm-line'))
      .map((line) => line.textContent ?? '')
      .join('\n')
  )
  rec.record(
    '粘到另一个代码块：内容与选区逐字一致',
    inCodeBlock === SELECTION,
    `实得=${JSON.stringify(inCodeBlock)} 期望=${JSON.stringify(SELECTION)}`
  )

  // (c) 解析器测试必须使用**真实复制读回的值**，不是硬编码常量。
  //     代码块顺序：0=CODE 1-2=代码组面板 3=TAILING_BLANK_LINES 4=JSON 5=PYTHON 6=JS
  const jsCopy = await copyByKeyAt(6)
  const jsonCopy = await copyByKeyAt(4)
  const parseCheck = await page.evaluate(
    (copied) => {
      const out = []
      try {
        new Function(copied.js)
        out.push(['js', 'ok'])
      } catch (error) {
        out.push(['js', 'ERR:' + String(error)])
      }
      try {
        JSON.parse(copied.json)
        out.push(['json', 'ok'])
      } catch (error) {
        out.push(['json', 'ERR:' + String(error)])
      }
      return out
    },
    { js: jsCopy.copied, json: jsonCopy.copied }
  )
  rec.record(
    'JS 复制读回值可被解析器接受（parse 的是剪贴板内容，不是脚本常量）',
    parseCheck.some(([lang, status]) => lang === 'js' && status === 'ok') &&
      normalize(jsCopy.copied) === normalize(jsCopy.source),
    JSON.stringify(parseCheck)
  )
  rec.record(
    'JSON 复制读回值可被 JSON.parse 接受',
    parseCheck.some(([lang, status]) => lang === 'json' && status === 'ok') &&
      normalize(jsonCopy.copied) === normalize(jsonCopy.source),
    JSON.stringify(parseCheck)
  )
  const pythonCopy = await copyByKeyAt(5)
  rec.record(
    'Python 复制读回值与编辑器内容逐字一致（含 `#` 注释与 `**`，没有被注入任何字符）',
    pythonCopy.source !== null &&
      normalize(pythonCopy.copied) === normalize(pythonCopy.source) &&
      pythonCopy.copied.includes('# 计算总和') &&
      pythonCopy.copied.includes('**返回**'),
    `实得=${JSON.stringify(pythonCopy.copied)} 原文=${JSON.stringify(pythonCopy.source)}`
  )

  // ── 场景四之三（第五轮验收）：末尾换行、多个空行、部分选区、代码组、普通文本框 ──
  const readText = () => app.evaluate(({ clipboard }) => clipboard.readText())

  // (b) 部分选区：双击选中一个词后复制，只能拿到**被选中的那部分**
  const wordTarget = '不是粗体'
  const wordLine = page
    .locator('.milkdown-code-block .cm-line')
    .filter({ hasText: wordTarget })
    .first()
  await wordLine.dblclick()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const selectionInCm = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  await page.keyboard.press('ControlOrMeta+c')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const partialText = await readText()
  rec.record(
    '部分选区：复制内容 === 当时的选区内容（逐字一致，不补不裁）',
    selectionInCm.length > 0 &&
      partialText.replace(/\r\n?/g, '\n') === selectionInCm &&
      !partialText.includes(CODE.split('\n')[0]),
    `选区=${JSON.stringify(selectionInCm)} 复制=${JSON.stringify(partialText)}`
  )

  // (a) 末尾换行 + 中间多个空行：把这段内容放进**代码块**，分别用「复制按钮」与
  //     「Cmd+A/Cmd+C」真实复制，与编辑器原文比较（不得先 trim / 裁剪）
  const tailSource = await codeBlockSource(3)
  rec.record(
    '末尾换行夹具就位：代码块内容以换行结尾且含连续空行',
    tailSource !== null && /\n\n/.test(tailSource) && /\n$/.test(tailSource),
    JSON.stringify(tailSource)
  )
  const tailByButton = await copyByButtonAt(3)
  rec.record(
    '末尾换行：复制按钮读回值 === 编辑器原文（末尾换行与空行都不被裁剪）',
    normalize(tailByButton.copied) === normalize(tailByButton.source),
    `实得=${JSON.stringify(tailByButton.copied)} 原文=${JSON.stringify(tailByButton.source)}`
  )
  const tailByKey = await copyByKeyAt(3)
  rec.record(
    '末尾换行：Cmd+A/Cmd+C 读回值 === 编辑器原文',
    normalize(tailByKey.copied) === normalize(tailByKey.source),
    `实得=${JSON.stringify(tailByKey.copied)} 原文=${JSON.stringify(tailByKey.source)}`
  )

  // (d) 在页面里注入一个**普通文本框**（不是外部应用），粘贴**上一步真实复制的**剪贴板：
  //     中间不得再写剪贴板，否则测的就不是 Desk 的复制结果
  const tailRear = await copyByButtonAt(3) // 重新真实复制一次，保证剪贴板就是 Desk 的产物
  await page.evaluate(() => {
    const area = document.createElement('textarea')
    area.id = 'e2e-plain-input'
    area.style.position = 'fixed'
    area.style.left = '10px'
    area.style.top = '10px'
    area.style.width = '320px'
    area.style.height = '160px'
    document.body.append(area)
  })
  await page.locator('#e2e-plain-input').click()
  await page.keyboard.press('ControlOrMeta+v')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const plainInputValue = await page.locator('#e2e-plain-input').inputValue()
  rec.record(
    '粘到页面内普通文本框：内容 === 上一步 Desk 复制读回值（未重新写剪贴板）',
    normalize(plainInputValue) === normalize(tailRear.copied) &&
      !plainInputValue.includes('desk-code'),
    `文本框=${JSON.stringify(plainInputValue)} 复制读回=${JSON.stringify(tailRear.copied)}`
  )
  await page.evaluate(() => document.querySelector('#e2e-plain-input')?.remove())

  // (c) 代码组复制：切到**只放一个代码组**的干净笔记再验证
  //     （本套件前面编辑过正文/代码块，会在同一篇里重建节点，基准会被自己污染）
  await openNote(page, { kbName: fixture.kbName, title: '代码组' })
  await waitFor(
    async () =>
      (await page.locator('.desk-raw-block--code-group-editable .code-group-panel').count()) > 0,
    20000
  )
  // 两篇笔记的代码组会同时挂在 DOM 里（都报 visible），所以不能靠"可见"挑；
  // 直接挑**内容等于夹具里代码组内容**的那个面板 —— 这同时证明了真面板没被改坏
  const groupTarget = await page.evaluate((expected) => {
    const normalizeText = (value) => (value ?? '').replace(/\r\n?/g, '\n')
    const panels = Array.from(
      document.querySelectorAll('.desk-raw-block--code-group-editable .code-group-panel')
    )
    const content = panels
      .map((panel) => panel.querySelector('.cm-content'))
      .find((el) => {
        const state = el?.cmTile?.view?.state
        return (
          state &&
          normalizeText(state.doc.sliceString(0, state.doc.length)) === normalizeText(expected)
        )
      })
    const state = content?.cmTile?.view?.state
    if (!content || !state) return null
    content.dataset.e2eGroupTarget = '1'
    return state.doc.sliceString(0, state.doc.length)
  }, GROUP_CODE)
  const groupCmTarget = page.locator('[data-e2e-group-target="1"]')
  rec.record(
    '代码组面板内容与夹具一致（干净笔记里读到真面板）',
    groupTarget !== null && normalize(groupTarget) === normalize(GROUP_CODE),
    `面板=${JSON.stringify(groupTarget)} 夹具=${JSON.stringify(GROUP_CODE)}`
  )
  if (groupTarget !== null && (await groupCmTarget.count()) === 1) {
    await groupCmTarget.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+c')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const groupText = await readText()
    rec.record(
      '代码组复制：纯文本与被复制面板的内容逐字一致',
      normalize(groupText) === normalize(groupTarget),
      `实得=${JSON.stringify(groupText)} 面板=${JSON.stringify(groupTarget)}`
    )
    rec.record(
      '代码组复制：来源标记在独立格式里',
      (await readFormats()).includes('application/x-desk-code'),
      JSON.stringify(await readFormats())
    )
    // 代码组复制的内容粘到普通文本框也应逐字一致
    await page.evaluate(() => {
      const area = document.createElement('textarea')
      area.id = 'e2e-group-plain-input'
      area.style.position = 'fixed'
      area.style.left = '10px'
      area.style.top = '10px'
      document.body.append(area)
    })
    await page.locator('#e2e-group-plain-input').click()
    await page.keyboard.press('ControlOrMeta+v')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const groupPasted = await page.locator('#e2e-group-plain-input').inputValue()
    rec.record(
      '代码组复制内容粘到普通文本框逐字一致',
      normalize(groupPasted) === normalize(groupText),
      `文本框=${JSON.stringify(groupPasted)} 复制=${JSON.stringify(groupText)}`
    )
    await page.evaluate(() => document.querySelector('#e2e-group-plain-input')?.remove())
  }

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
