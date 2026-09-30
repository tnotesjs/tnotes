// 渲染忠实性：结构性不忠实的区域按**普通正文**暴露（可编辑/可删除），其余内容照常，磁盘不变。
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = mkdtempSync(join(tmpdir(), 'desk-fidelity-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'TNotes.fidelity')
const noteFile = join(kb, 'notes', '0001. fidelity.md')
mkdirSync(join(kb, 'notes'), { recursive: true })
mkdirSync(profile, { recursive: true })
writeFileSync(join(kb, 'tnotes.json'), JSON.stringify({ title: 'fidelity' }))
writeFileSync(join(kb, 'TOC.md'), '- [ ] 0001. fidelity\n- [ ] 0002. upgrade\n- [ ] 0003. format\n')

// 保存不再整篇重排。这段「处处不合 Prettier 内置默认」的正文用来验源码视图保存只落用户改动。
// 第二个库的 tnotes.json 仍写着 prettier:true，保存时也必须原样落盘。
const styled = [
  '---',
  'id: fidelity-format',
  '---',
  '',
  '* 甲',
  '',
  '***',
  '',
  '```js',
  'const a  =  1',
  "const s = 'x'",
  '```',
  '',
  '正文。',
  ''
].join('\n')
const styledEdited = `${styled}追加。\n`
const note3File = join(kb, 'notes', '0003. format.md')
writeFileSync(note3File, styled)

// 第二个库：tnotes.json 里残留 prettier:true，保存时必须忽略。
const kb2 = join(workspace, 'TNotes.format-on')
const note2File = join(kb2, 'notes', '0001. format-on.md')
mkdirSync(join(kb2, 'notes'), { recursive: true })
writeFileSync(join(kb2, 'tnotes.json'), JSON.stringify({ title: 'format-on', prettier: true }))
writeFileSync(join(kb2, 'TOC.md'), '- [ ] 0001. format-on\n')
writeFileSync(note2File, styled)

// 嵌套容器是已知的「结构性不忠实」：这段要按普通正文暴露（看得见 ::: 符号）。
// 后面的 222 段落与正常提示块都与它无关，必须照常渲染 —— 验证「只处理出问题的区域」。
const markdown = [
  '---',
  'id: fidelity-e2e',
  '---',
  '',
  '::: tip 正常提示块',
  '',
  '正常正文',
  '',
  ':::',
  '',
  '::: tip T',
  '',
  '外层',
  '',
  '::: info I',
  '',
  '内层',
  '',
  ':::',
  '',
  ':::',
  '',
  '222',
  ''
].join('\n')
writeFileSync(noteFile, markdown)
const upgradeFile = join(kb, 'notes', '0002. upgrade.md')
writeFileSync(upgradeFile, '开头段落。\n\n后面还有一段。\n')
writeFileSync(
  join(profile, 'workspace.v1.json'),
  `${JSON.stringify({ path: workspace }, null, 2)}\n`
)
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  `${JSON.stringify(
    {
      version: 1,
      theme: 'light',
      defaultNoteView: 'visual',
      autosave: { enabled: true, delayMs: 800 }
    },
    null,
    2
  )}\n`
)

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['out/main/index.js', `--user-data-dir=${profile}`],
  cwd: deskDir,
  timeout: 60000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_DISABLE_SANDBOX: '1' }
})

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// 等磁盘落到期望内容：保存是异步的，用「等元素消失」会在元素从未出现时假通过。
const waitForFile = async (file, predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      last = readFileSync(file, 'utf8')
    } catch {
      last = ''
    }
    if (predicate(last) || Date.now() > deadline) return last
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.getByText('fidelity', { exact: true }).first().click()
  await page.waitForTimeout(1500)
  await page.locator('.toc-row', { hasText: '0001' }).first().locator('.node-label').click()
  await page.waitForTimeout(3000) // 降级在空闲时发生

  const state = () =>
    page.evaluate(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find(
        (el) => el.offsetParent !== null
      )
      if (!editor) return { error: 'no-editor' }
      const paragraphs = [...editor.querySelectorAll('p')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => el.textContent ?? '')
      const literal = paragraphs.filter((text) => text.trim().startsWith(':::'))
      return {
        literal: literal.length,
        literalText: literal.join('\n'),
        unparsedCards: editor.querySelectorAll('.desk-raw-block--unparsed').length,
        has222: paragraphs.some((text) => text.trim() === '222'),
        callouts: editor.querySelectorAll('.desk-callout').length
      }
    })

  const before = await state()
  check(
    '问题区域按普通正文暴露（看得见 ::: 符号）',
    before.literal >= 1,
    `literal=${before.literal}`
  )
  check(
    '降级内容逐字可见',
    String(before.literalText).includes('::: info I'),
    String(before.literalText).replace(/\n/g, '⏎').slice(0, 60)
  )
  check('不再是专门的 raw 卡片', before.unparsedCards === 0, `cards=${before.unparsedCards}`)
  check(
    '无关段落 222 仍照常渲染',
    before.has222 === true && before.literalText.includes('222') === false
  )
  check('正常提示块没有被处理', before.callouts === 1, `callouts=${before.callouts}`)
  await page.screenshot({ path: join(deskDir, 'scripts', 'shots', 'fidelity-literal.png') })

  // 切到源码视图：磁盘必须逐字未变
  await page.getByRole('button', { name: '源码视图', exact: true }).click()
  await page.waitForTimeout(1200)
  check('切视图后磁盘文件逐字未变', readFileSync(noteFile, 'utf8') === markdown)

  // 切回可视化：仍是普通正文
  await page.getByRole('button', { name: '可视化编辑', exact: true }).click()
  await page.waitForTimeout(3000)
  const after = await state()
  check('切回可视化后仍按普通正文显示', after.literal >= 1, `literal=${after.literal}`)
  check('切回后磁盘仍然未变', readFileSync(noteFile, 'utf8') === markdown)

  // 关键：这段内容现在是**真的普通内容** —— 能直接编辑（用户反馈过"通过把手删不掉、改不了"）
  // 说明：这里**不**验"编辑降级区域后写盘形态" —— e2e 里用 Playwright 往这类段落打字的
  // 落点不稳定（DOM 上看起来改了，ProseMirror 并未收到输入），容易得到假结论。
  // 写盘形态（A2 的转义逐行覆盖）由 projectionFidelity.test.ts 的确定性单测覆盖；
  // 这里只验端到端稳定成立的三件事：切视图不改磁盘、切回来仍是普通文字、守卫不误拦。
  await page.getByRole('button', { name: '源码视图', exact: true }).click()
  await page.waitForTimeout(1200)
  const statusText = await page.evaluate(
    () => document.querySelector('[role="status"]')?.textContent ?? ''
  )
  check(
    '浏览/切视图没有被守卫拦住',
    !statusText.includes('会被写坏'),
    JSON.stringify(statusText.slice(0, 40))
  )
  check('切视图后磁盘仍然逐字未变', readFileSync(noteFile, 'utf8') === markdown)

  // 切回可视化：仍然是文字，没有被重新解析成容器
  await page.getByRole('button', { name: '可视化编辑', exact: true }).click()
  await page.waitForTimeout(3000)
  const reloaded = await state()
  check(
    '重新加载后仍是普通文字（没有变回容器）',
    reloaded.literal >= 1 && reloaded.callouts === 1,
    `literal=${reloaded.literal} callouts=${reloaded.callouts}`
  )
  await page.screenshot({ path: join(deskDir, 'scripts', 'shots', 'fidelity-after-edit.png') })

  // ---- 懒升级：手写容器语法，光标离开后要变成真正的提示块 ----
  await page.locator('.toc-row', { hasText: '0002' }).first().locator('.node-label').click()
  await page.waitForTimeout(2500)
  const paragraph = page.locator('.ProseMirror p').filter({ hasText: '开头段落。' }).first()
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('::: tip 我的标题')
  await page.waitForTimeout(200)
  const typedText = await page.evaluate(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find(
      (el) => el.offsetParent !== null
    )
    return [...editor.querySelectorAll('p')].map((el) => el.textContent ?? '').join('|')
  })
  check(
    '可视化视图里能正常打出容器语法（当普通文字）',
    typedText.includes('::: tip 我的标题'),
    typedText.slice(0, 60)
  )
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('正文内容')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type(':::')
  await page.waitForTimeout(300)

  // 光标离开这一段（点下面的段落）→ 触发懒升级
  await page.locator('.ProseMirror p').filter({ hasText: '后面还有一段。' }).first().click()
  await page.waitForTimeout(1500)
  const upgraded = await page.evaluate(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find(
      (el) => el.offsetParent !== null
    )
    const callouts = [...editor.querySelectorAll('.desk-callout')]
    return {
      callouts: callouts.length,
      title: callouts[0]?.querySelector('.desk-callout__title')?.value ?? ''
    }
  })
  check(
    '光标离开后手写的容器语法升级成提示块',
    upgraded.callouts >= 1 && String(upgraded.title).includes('我的标题'),
    `callouts=${upgraded.callouts} title=${JSON.stringify(upgraded.title)}`
  )
  const upgradeStatus = await page.evaluate(
    () => document.querySelector('[role="status"]')?.textContent ?? ''
  )
  check(
    '升级没有被保存守卫拦住',
    !upgradeStatus.includes('会被写坏'),
    JSON.stringify(upgradeStatus.slice(0, 40))
  )
  await page.getByRole('button', { name: '源码视图', exact: true }).click()
  await page.waitForTimeout(1500)
  const upgradedFile = readFileSync(upgradeFile, 'utf8')
  check(
    '升级后的内容写进了文件（容器形态）',
    upgradedFile.includes('::: tip 我的标题') && upgradedFile.includes('正文内容'),
    JSON.stringify(upgradedFile.slice(0, 60))
  )
  await page.screenshot({ path: join(deskDir, 'scripts', 'shots', 'fidelity-upgrade.png') })

  // ---- 源码视图保存只落用户改动，未编辑的字节不许被重排 ----
  await page.locator('.toc-row', { hasText: '0003' }).first().locator('.node-label').click()
  await page.waitForTimeout(2500)
  check(
    '可视化加载不改动 0003 的磁盘内容',
    readFileSync(note3File, 'utf8') === styled,
    JSON.stringify(readFileSync(note3File, 'utf8').slice(0, 24))
  )
  const sourceViewButton = page.getByRole('button', { name: '源码视图', exact: true })
  await sourceViewButton.filter({ visible: true }).first().click()
  await page.waitForTimeout(1200)
  // 源码视图已是 Monaco：文本层是 .view-lines
  const formatCm = page
    .locator('.markdown-source-editor .view-lines')
    .filter({ visible: true })
    .first()
  await formatCm.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(styledEdited)
  await page.keyboard.press('ControlOrMeta+s')
  const savedDefault = await waitForFile(note3File, (text) => text === styledEdited)
  check(
    '默认关闭：源码视图保存只落改动，不整篇重排',
    savedDefault === styledEdited,
    JSON.stringify(savedDefault.slice(-24))
  )
  check(
    '默认关闭：列表记号 / 分割线 / 代码块内部逐字保留',
    savedDefault.includes('* 甲') &&
      savedDefault.includes('\n***\n') &&
      savedDefault.includes('const a  =  1') &&
      savedDefault.includes("const s = 'x'"),
    JSON.stringify(savedDefault.slice(0, 40))
  )

  // ---- tnotes.json 里残留 prettier:true 时，保存仍只落用户改动 ----
  await page.getByText('format-on', { exact: true }).first().click()
  await page.waitForTimeout(1800)
  await page.locator('.toc-row', { hasText: 'format-on' }).first().locator('.node-label').click()
  await page.waitForTimeout(2500)
  await page
    .getByRole('button', { name: '源码视图', exact: true })
    .filter({ visible: true })
    .first()
    .click()
  await page.waitForTimeout(1200)
  const onCm = page.locator('.markdown-source-editor .view-lines').filter({ visible: true }).first()
  await onCm.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(styledEdited)
  await page.keyboard.press('ControlOrMeta+s')
  const savedOn = await waitForFile(note2File, (text) => text === styledEdited)
  check(
    'tnotes.json 里的 prettier 被忽略，源码视图保存不整篇重排',
    savedOn === styledEdited && savedOn.includes('* 甲') && !savedOn.includes('- 甲'),
    JSON.stringify(savedOn.slice(0, 40))
  )
  await page.screenshot({ path: join(deskDir, 'scripts', 'shots', 'fidelity-prettier.png') })

  console.log(failures === 0 ? '\nfidelity e2e: 全部通过' : `\nfidelity e2e: ${failures} 项失败`)
  if (failures > 0) process.exitCode = 1
} finally {
  await app.close()
  rmSync(fixture, { recursive: true, force: true })
}
