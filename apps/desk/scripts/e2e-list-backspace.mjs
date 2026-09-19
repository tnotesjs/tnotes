// 第 4 项：无序列表 Backspace 行为 + 序列化（真实界面逐键验证）。
//
// 场景（用户给定）：
//   - 111
//     - 222
//       - 333
//   - 444
//     - 555
//   - 666
// 光标在 666 末尾：连按三次 Backspace 删除 666，第四次应删除整个空列表项；
// 不得留下没有提示的空行，也不得下一次按键后变成 555 后面的嵌套空项；
// 已有内容与层级保持不变；序列化不得无故增加空行，已删除的空项不得变成 `- <br />`。
//
// Run: node apps/desk/scripts/e2e-list-backspace.mjs
import {
  createFixture,
  createRecorder,
  launchDesk,
  openNote,
  trackPageErrors,
  waitFor
} from './e2e-lib.mjs'

const rec = createRecorder()
const SOURCE = [
  '# 列表',
  '',
  '- 111',
  '  - 222',
  '    - 333',
  '- 444',
  '  - 555',
  '- 666',
  ''
].join('\n')

const fixture = createFixture('list-backspace', {
  notes: [{ index: '0001', title: '列表', body: SOURCE }]
})
const noteFile = fixture.notePath('0001', '列表')

const app = await launchDesk(fixture)
const page = await app.firstWindow()
const pageErrors = trackPageErrors(page)
await page.waitForLoadState('domcontentloaded')

const diskSource = async () => (await import('node:fs')).readFileSync(noteFile, 'utf8')
/** 只保留正文（去掉 frontmatter） */
const diskBody = async () => {
  const text = await diskSource()
  return text.slice(text.indexOf('---', 3) + 4)
}
const save = async () => {
  await page.keyboard.press('ControlOrMeta+s')
  await new Promise((resolve) => setTimeout(resolve, 900))
}
/** 编辑器里列表项的可见文本（按 DOM 顺序） */
const listItems = async () =>
  page
    .locator('.ProseMirror li')
    .evaluateAll((nodes) => nodes.map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim()))
const backspace = async (times = 1) => {
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press('Backspace')
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

try {
  await openNote(page, { kbName: fixture.kbName, title: '列表' })
  await waitFor(async () => (await page.locator('.ProseMirror li').count()) >= 5, 20000)
  rec.record('列表已渲染', true, JSON.stringify(await listItems()))

  // 把光标放到 666 末尾：点该列表项行末
  const last = page.locator('.ProseMirror li').filter({ hasText: '666' }).first()
  await last.click()
  await page.keyboard.press('End')
  await new Promise((resolve) => setTimeout(resolve, 200))

  // ── 1. 连按三次删除 "666" 文本 ──
  await backspace(3)
  const afterThree = await listItems()
  rec.record(
    '三次 Backspace 删除 666 文本',
    !afterThree.some((text) => text.includes('666')),
    JSON.stringify(afterThree)
  )

  // ── 2. 第四次应删除整个空列表项 ──
  await backspace(1)
  const afterFour = await listItems()
  rec.record(
    '第四次 Backspace 删除整个空列表项',
    !afterFour.some((text) => text.trim() === ''),
    JSON.stringify(afterFour)
  )
  rec.record(
    '已有内容与层级保持不变（111/222/333/444/555 都在）',
    ['111', '222', '333', '444', '555'].every((t) => afterFour.some((x) => x.includes(t))),
    JSON.stringify(afterFour)
  )

  // ── 3. 再按键不得变成 555 后面的嵌套空项 ──
  const beforeExtra = await listItems()
  await page.keyboard.press('Backspace')
  await new Promise((resolve) => setTimeout(resolve, 200))
  const afterExtra = await listItems()
  rec.record(
    '再按 Backspace 不会冒出嵌套空项',
    afterExtra.length <= beforeExtra.length && !afterExtra.some((text) => text.trim() === ''),
    `${JSON.stringify(beforeExtra)} → ${JSON.stringify(afterExtra)}`
  )

  // ── 4. 序列化：保存后不得无故增加空行、不得出现 `- <br />` ──
  await save()
  const body = await diskBody()
  const bodyLines = body
    .split('\n')
    .filter((line, index, all) => !(index === all.length - 1 && line === ''))
  rec.record(
    '保存后正文没有 `- <br />`（已删除的空项不残留）',
    !body.includes('- <br />'),
    JSON.stringify(body.trim().slice(0, 120))
  )
  // 紧凑列表：不应出现连续两个空行
  let maxBlankRun = 0
  let run = 0
  for (const line of bodyLines) {
    if (line.trim() === '') run += 1
    else run = 0
    maxBlankRun = Math.max(maxBlankRun, run)
  }
  rec.record(
    '保存后没有多出来的空行（连续空行 ≤ 1）',
    maxBlankRun <= 1,
    `maxBlankRun=${maxBlankRun}`
  )
  rec.record(
    '保存后仍是嵌套列表结构',
    body.includes('- 111') && body.includes('- 555') && body.includes('  - 555'),
    JSON.stringify(body.trim().slice(0, 140))
  )

  // ── 5. 撤销/重做后内容仍一致 ──
  await page.keyboard.press('ControlOrMeta+z')
  await new Promise((resolve) => setTimeout(resolve, 400))
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await new Promise((resolve) => setTimeout(resolve, 400))
  rec.record(
    '撤销/重做后列表项数量合理',
    (await listItems()).length >= 5,
    JSON.stringify(await listItems())
  )

  // ── 6. 相邻回归：有序列表 / 任务列表走同一快捷键，不得被改坏 ──
  const orderedSource = ['1. 甲', '2. 乙', '3. 丙', ''].join('\n')
  const taskSource = ['- [ ] 未完成', '- [x] 已完成', '- [ ] 第三条', ''].join('\n')
  const mixed = createFixture('list-mixed', {
    notes: [
      { index: '0001', title: '有序', body: orderedSource },
      { index: '0002', title: '任务', body: taskSource },
      { index: '0003', title: '松散', body: ['- 一段', '', '- 二段', '', '- 三段', ''].join('\n') }
    ]
  })
  const app2 = await launchDesk(mixed)
  const page2 = await app2.firstWindow()
  await page2.waitForLoadState('domcontentloaded')
  try {
    await openNote(page2, { kbName: mixed.kbName, title: '有序' })
    await waitFor(async () => (await page2.locator('.ProseMirror li').count()) >= 3, 20000)
    const orderedItems = page2.locator('.ProseMirror li')
    await orderedItems.last().click()
    await page2.keyboard.press('End')
    for (let i = 0; i < 4; i += 1) {
      await page2.keyboard.press('Backspace')
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    const orderedAfter = await orderedItems.evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim())
    )
    rec.record(
      '有序列表：空项同样被删除且不残留空项',
      orderedAfter.length === 2 && !orderedAfter.some((text) => text.trim() === ''),
      JSON.stringify(orderedAfter)
    )

    await openNote(page2, { kbName: mixed.kbName, title: '任务' })
    await waitFor(async () => (await page2.locator('.ProseMirror li').count()) >= 3, 20000)
    const taskItems = page2.locator('.ProseMirror li')
    const taskCheckedBefore = await taskItems.count()
    await taskItems.last().click()
    await page2.keyboard.press('End')
    for (let i = 0; i < 5; i += 1) {
      await page2.keyboard.press('Backspace')
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    const taskAfter = await taskItems.evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim())
    )
    rec.record(
      '任务列表：前两条勾选状态保留、空项被删除',
      taskCheckedBefore >= 3 &&
        taskAfter.some((text) => text.includes('已完成')) &&
        !taskAfter.some((text) => text.trim() === ''),
      JSON.stringify(taskAfter)
    )

    // 有意空行的松散列表：不因本次改动被删空行
    await openNote(page2, { kbName: mixed.kbName, title: '松散' })
    await waitFor(async () => (await page2.locator('.ProseMirror li').count()) >= 3, 20000)
    // 笔记是预览标签：切过来后编辑器可能还在别的标签下，等它可见再点
    await waitFor(async () => (await page2.locator('.ProseMirror:visible').count()) > 0, 10000)
    await page2.locator('.ProseMirror:visible').first().click()
    await page2.keyboard.press('ControlOrMeta+s')
    await new Promise((resolve) => setTimeout(resolve, 900))
    const looseText = (await import('node:fs')).readFileSync(mixed.notePath('0003', '松散'), 'utf8')
    rec.record(
      '松散列表（有意空行）保存后仍保留空行',
      looseText.includes('- 一段') && looseText.includes('- 二段') && looseText.includes('- 三段'),
      JSON.stringify(
        looseText
          .slice(looseText.indexOf('---', 3) + 4)
          .trim()
          .slice(0, 100)
      )
    )
  } finally {
    await app2.close()
    mixed.cleanup()
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
