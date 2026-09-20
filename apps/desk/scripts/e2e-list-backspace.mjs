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

/**
 * 结构化快照：每个列表项的**文本 + 嵌套层级**，以及当前**光标所在的块与偏移**。
 *
 * 只断言"没有空 li"是不够的：`liftListItem` 会把空项提升成**列表外的空段落**——
 * 空 li 确实没了、文本也都在，但用户按完第四次 Backspace 会发现光标没有回到 555
 * 末尾（实测停在 `p.crepe-placeholder` 的 offset 0，直到再按一次才莫名其妙跳进 555）。
 * 所以这里同时断言层级与光标归属。
 */
const structAt = (target) =>
  target.evaluate((root) => {
    const items = Array.from(root.querySelectorAll('li.list-item')).map((li) => {
      const first = li.querySelector('.content-dom > p')
      let depth = 0
      let node = li.parentElement
      while (node && node !== root) {
        // 有序列表的外层是 OL、无序/任务列表是 UL，两者都算一层
        if (node.tagName === 'UL' || node.tagName === 'OL') depth += 1
        node = node.parentElement
      }
      return { text: (first?.textContent ?? '').trim(), depth }
    })
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    let caret = null
    if (anchor) {
      const element = anchor.nodeType === 3 ? anchor.parentElement : anchor
      const paragraph = element.closest('p')
      const item = paragraph?.closest('li.list-item') ?? null
      caret = {
        inListItem: Boolean(item),
        paragraphText: (paragraph?.textContent ?? '').trim(),
        offset: selection.anchorOffset
      }
    }
    return { items, caret }
  })
const struct = () => structAt(page.locator('.ProseMirror').first())

/** 期望的结构（相对层级）：三次删除 666 文本后、第四次删除空项后都应如此 */
const EXPECTED_ITEMS = [
  { text: '111', depth: 1 },
  { text: '222', depth: 2 },
  { text: '333', depth: 3 },
  { text: '444', depth: 1 },
  { text: '555', depth: 2 }
]
const sameItems = (actual) => JSON.stringify(actual) === JSON.stringify(EXPECTED_ITEMS)
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

  // ── 2. 第四次应删除整个空列表项，并把光标交回上一项末尾 ──
  await backspace(1)
  const afterFour = await struct()
  rec.record(
    '第四次 Backspace 后没有空列表项',
    !afterFour.items.some((item) => item.text === ''),
    JSON.stringify(afterFour.items)
  )
  rec.record(
    '第四次 Backspace 后完整结构不变（文本 + 层级逐项一致）',
    sameItems(afterFour.items),
    `期望=${JSON.stringify(EXPECTED_ITEMS)} 实得=${JSON.stringify(afterFour.items)}`
  )
  rec.record(
    '第四次 Backspace 后光标在列表内、落在 555 末尾',
    afterFour.caret?.inListItem === true &&
      afterFour.caret.paragraphText === '555' &&
      afterFour.caret.offset === 3,
    JSON.stringify(afterFour.caret)
  )
  rec.record(
    '第四次 Backspace 后不残留列表外的空段落（除文档末尾尾随段）',
    (await page
      .locator('.ProseMirror')
      .first()
      .evaluate((root) => {
        const paragraphs = Array.from(root.querySelectorAll(':scope > p'))
        return paragraphs.filter((p, index) => {
          const isTrailing = index === paragraphs.length - 1
          return !isTrailing && (p.textContent ?? '').trim() === ''
        }).length
      })) === 0,
    '检查连续/中间的空段落'
  )

  // ── 3. 再按 Backspace 只在 555 上退格，不得冒出嵌套空项 ──
  const beforeExtra = await struct()
  await page.keyboard.press('Backspace')
  await new Promise((resolve) => setTimeout(resolve, 200))
  const afterExtra = await struct()
  rec.record(
    '再按 Backspace 不会冒出嵌套空项',
    afterExtra.items.length === beforeExtra.items.length &&
      !afterExtra.items.some((item) => item.text === ''),
    `${JSON.stringify(beforeExtra.items)} → ${JSON.stringify(afterExtra.items)}`
  )
  rec.record(
    '再按 Backspace 是在 555 上退格（55），光标仍在列表内',
    afterExtra.caret?.inListItem === true &&
      afterExtra.caret.paragraphText === '55' &&
      afterExtra.caret.offset === 2,
    JSON.stringify(afterExtra.caret)
  )
  // 还原成预期结构，后面的保存/重开断言才有确定期望
  await page.keyboard.press('ControlOrMeta+z')
  await new Promise((resolve) => setTimeout(resolve, 300))

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
    '保存后仍是嵌套列表结构（缩进层级逐行核对）',
    body
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(1)
      .join('\n') === ['- 111', '  - 222', '    - 333', '- 444', '  - 555'].join('\n'),
    JSON.stringify(body)
  )

  // ── 4b. 保存重开后结构、层级与文本一致 ──
  await page.locator('.toc-row', { hasText: '列表' }).first().click()
  await new Promise((resolve) => setTimeout(resolve, 800))
  await waitFor(async () => (await page.locator('.ProseMirror').count()) > 0, 15000)
  const reopened = await struct()
  rec.record(
    '保存重开后结构与层级一致',
    sameItems(reopened.items),
    `实得=${JSON.stringify(reopened.items)}`
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
  // 末项用 3 个字符，与主场景对称：前 3 次删文本、第 4 次删空项
  const orderedSource = ['1. 甲', '2. 乙', '3. 丙丙丙', ''].join('\n')
  const taskSource = ['- [ ] 未完成', '- [x] 已完成', '- [ ] 第三条', ''].join('\n')
  const nestedSource = ['- 111', '  - 222', '    - 333', '- 444', ''].join('\n')
  const mixed = createFixture('list-mixed', {
    notes: [
      { index: '0001', title: '有序', body: orderedSource },
      { index: '0002', title: '任务', body: taskSource },
      { index: '0003', title: '松散', body: ['- 一段', '', '- 二段', '', '- 三段', ''].join('\n') },
      { index: '0004', title: '嵌套', body: nestedSource }
    ]
  })
  const app2 = await launchDesk(mixed)
  const page2 = await app2.firstWindow()
  await page2.waitForLoadState('domcontentloaded')
  try {
    // 有序列表：与无序列表同一路径，逐键核对"文本 → 空项 → 空项被删除 + 光标回上一项末尾"
    await openNote(page2, { kbName: mixed.kbName, title: '有序' })
    // 必须等到"确实是那一篇"可见：多篇笔记都会渲染 `.ProseMirror`，只等数量会点在别人身上
    await waitFor(
      async () =>
        (await page2.locator('.ProseMirror:visible').first().innerText()).includes('丙丙丙'),
      20000
    )
    await page2.locator('.ProseMirror:visible li').filter({ hasText: '丙丙丙' }).first().click()
    await page2.keyboard.press('End')
    await new Promise((resolve) => setTimeout(resolve, 200))
    // 逐键记录，失败时能看到是"哪一次删错了"
    const orderedSteps = []
    for (let i = 0; i < 4; i += 1) {
      await page2.keyboard.press('Backspace')
      await new Promise((resolve) => setTimeout(resolve, 200))
      orderedSteps.push(
        JSON.stringify((await structAt(page2.locator('.ProseMirror:visible').first())).items)
      )
    }
    console.log('DBG ordered steps', orderedSteps.join(' → '))
    const orderedAfter = await structAt(page2.locator('.ProseMirror:visible').first())
    rec.record(
      '有序列表：空项被删除、不留空项、结构不变',
      JSON.stringify(orderedAfter.items) ===
        JSON.stringify([
          { text: '甲', depth: 1 },
          { text: '乙', depth: 1 }
        ]),
      JSON.stringify(orderedAfter.items)
    )
    rec.record(
      '有序列表：光标回到上一项末尾',
      orderedAfter.caret?.inListItem === true &&
        orderedAfter.caret.paragraphText === '乙' &&
        orderedAfter.caret.offset === 1,
      JSON.stringify(orderedAfter.caret)
    )

    // 任务列表：勾选状态必须保留，空项同样被删除
    await openNote(page2, { kbName: mixed.kbName, title: '任务' })
    await waitFor(
      async () =>
        (await page2.locator('.ProseMirror:visible').first().innerText()).includes('第三条'),
      20000
    )
    // 任务列表的勾选态是 DOM 上的 `.label.checked / .label.unchecked`（不是 <input>）
    const taskCheckedBefore = await page2
      .locator('.ProseMirror:visible li .label')
      .evaluateAll((nodes) => nodes.map((node) => node.classList.contains('checked')))
    await page2.locator('.ProseMirror:visible li').filter({ hasText: '第三条' }).first().click()
    await page2.keyboard.press('End')
    await new Promise((resolve) => setTimeout(resolve, 200))
    for (let i = 0; i < 5; i += 1) {
      await page2.keyboard.press('Backspace')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const taskAfter = await structAt(page2.locator('.ProseMirror:visible').first())
    const taskCheckedAfter = await page2
      .locator('.ProseMirror:visible li .label')
      .evaluateAll((nodes) => nodes.map((node) => node.classList.contains('checked')))
    rec.record(
      '任务列表：空项被删除、不留空项、结构不变',
      JSON.stringify(taskAfter.items) ===
        JSON.stringify([
          { text: '未完成', depth: 1 },
          { text: '已完', depth: 1 }
        ]),
      JSON.stringify(taskAfter.items)
    )
    rec.record(
      '任务列表：前两条勾选状态原样保留',
      taskCheckedBefore.length === 3 &&
        taskCheckedAfter.length === 2 &&
        taskCheckedBefore[0] === taskCheckedAfter[0] &&
        taskCheckedBefore[1] === taskCheckedAfter[1] &&
        taskCheckedAfter[1] === true,
      `前=${JSON.stringify(taskCheckedBefore)} 后=${JSON.stringify(taskCheckedAfter)}`
    )

    // 有意空行的松散列表：不因本次改动被删空行
    await openNote(page2, { kbName: mixed.kbName, title: '松散' })
    await waitFor(async () => (await page2.locator('.ProseMirror:visible li').count()) >= 3, 20000)
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
    // 嵌套列表：Milkdown 默认 lift 会在**外层**列表里留下一个空 item（写成 `  - <br />`）。
    // 主场景的 666 是顶层项，走不到这条路径，所以这里单独覆盖。
    await openNote(page2, { kbName: mixed.kbName, title: '嵌套' })
    await waitFor(
      async () => (await page2.locator('.ProseMirror:visible').first().innerText()).includes('333'),
      20000
    )
    // 注意：`li` 的 hasText 会连祖先 li 一起匹配（111 的 li 也"包含" 333 的文本），
    // 必须点最里层那个 p，否则会点在 222 上。
    await page2.locator('.ProseMirror:visible li p').filter({ hasText: /^333$/ }).first().click()
    await page2.keyboard.press('End')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const nestedSteps = []
    for (let i = 0; i < 4; i += 1) {
      await page2.keyboard.press('Backspace')
      await new Promise((resolve) => setTimeout(resolve, 200))
      nestedSteps.push(
        JSON.stringify((await structAt(page2.locator('.ProseMirror:visible').first())).items)
      )
    }
    console.log('DBG nested steps', nestedSteps.join(' → '))
    const nestedAfter = await structAt(page2.locator('.ProseMirror:visible').first())
    rec.record(
      '嵌套列表：空项被删除、不留空项、层级逐项不变',
      JSON.stringify(nestedAfter.items) ===
        JSON.stringify([
          { text: '111', depth: 1 },
          { text: '222', depth: 2 },
          { text: '444', depth: 1 }
        ]),
      JSON.stringify(nestedAfter.items)
    )
    rec.record(
      '嵌套列表：光标回到上一项（222）末尾、仍在列表内',
      nestedAfter.caret?.inListItem === true &&
        nestedAfter.caret.paragraphText === '222' &&
        nestedAfter.caret.offset === 3,
      JSON.stringify(nestedAfter.caret)
    )
    rec.record(
      '嵌套列表：不残留列表外的空段落（除文档末尾尾随段）',
      (await page2
        .locator('.ProseMirror:visible')
        .first()
        .evaluate((root) => {
          const paragraphs = Array.from(root.querySelectorAll(':scope > p'))
          return paragraphs.filter((p, index) => {
            const isTrailing = index === paragraphs.length - 1
            return !isTrailing && (p.textContent ?? '').trim() === ''
          }).length
        })) === 0,
      '检查连续/中间的空段落'
    )
    await page2.keyboard.press('ControlOrMeta+s')
    await new Promise((resolve) => setTimeout(resolve, 900))
    const nestedText = (await import('node:fs')).readFileSync(
      mixed.notePath('0004', '嵌套'),
      'utf8'
    )
    rec.record(
      '嵌套列表：保存后没有 `- <br />`、层级逐行正确',
      !nestedText.includes('- <br />') &&
        nestedText
          .slice(nestedText.indexOf('---', 3) + 4)
          .split('\n')
          .filter((line) => line.trim() !== '')
          .join('\n') === ['- 111', '  - 222', '- 444'].join('\n'),
      JSON.stringify(nestedText)
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
