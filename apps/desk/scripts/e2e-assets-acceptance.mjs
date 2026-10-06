// Assets acceptance self-test (W2). Runs the real built app in an isolated
// profile against a *copy* of a fixture KB, clicks through the acceptance
// checklist, asserts DOM + on-disk facts, and keeps screenshots as evidence.
//
// Prereq: pnpm --filter desk exec electron-vite build
// Run:    node apps/desk/scripts/e2e-assets-acceptance.mjs [--only=F1]
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises'

import { _electron } from 'playwright-core'

import {
  ACCEPTANCE_EXPECTED,
  writeAcceptanceKb,
  writeAcceptanceMaterials
} from './acceptance-fixture.mjs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const deskDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const phase =
  process.argv.find((arg) => arg.startsWith('--phase='))?.slice('--phase='.length) ?? 'main'
const fixture = mkdtempSync(join(tmpdir(), 'desk-acceptance-'))
const workspace = join(fixture, 'workspace')
const profile = join(fixture, 'profile')
const kb = join(workspace, 'acceptance-kb')
const materials = join(fixture, 'materials')
const shots = join(deskDir, 'scripts', 'shots', 'acceptance')
mkdirSync(workspace, { recursive: true })
mkdirSync(profile, { recursive: true })
mkdirSync(shots, { recursive: true })
await writeAcceptanceKb(kb)
await writeAcceptanceMaterials(materials)

// 让 0002 足够长，F6 才能验证滚动位置恢复
const longNote = join(kb, 'notes', '0002. 重复与合并.md')
writeFileSync(
  longNote,
  readFileSync(longNote, 'utf8') +
    '\n' +
    Array.from(
      { length: 160 },
      (_, index) => `填充段落 ${index + 1}：仅用于验证重开后的滚动位置。`
    ).join('\n\n') +
    '\n'
)

writeFileSync(join(profile, 'workspace.v1.json'), JSON.stringify({ path: workspace }))
writeFileSync(
  join(profile, '.tn-desk-config.json'),
  JSON.stringify({
    version: 1,
    theme: 'light',
    defaultNoteView: 'visual',
    prettier: false,
    autosave: { enabled: phase !== 'gate', delayMs: 1000 }
  })
)

const results = []
let current = null
function check(name, fn, belongsTo = 'main') {
  if (belongsTo !== 'all' && belongsTo !== phase) return Promise.resolve()
  current = { name, ok: true, notes: [] }
  results.push(current)
  return Promise.resolve()
    .then(fn)
    .catch((error) => {
      current.ok = false
      current.notes.push(String(error && error.message ? error.message : error))
    })
}
function assert(condition, message) {
  if (!condition) {
    current.ok = false
    current.notes.push(message)
    throw new Error(message)
  }
}

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['out/main/index.js', `--user-data-dir=${profile}`],
  cwd: deskDir,
  timeout: 60000,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    ELECTRON_DISABLE_SANDBOX: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
})

const pageErrors = []
const httpErrors = []
let page
try {
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', (error) => pageErrors.push(String(error.message ?? error)))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`[console] ${message.text()}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`)
  })
  await page.waitForLoadState('domcontentloaded')

  await check(
    'setup · 打开知识库与资源面板',
    async () => {
      await page.getByText('acceptance-kb', { exact: true }).first().click()
      await page.waitForTimeout(1200)
      await page.keyboard.press('ControlOrMeta+Shift+p')
      const palette = page.locator('.command-palette__input')
      await palette.waitFor({ timeout: 15000 })
      await palette.fill('>open-kb-assets')
      await page.locator('.command-palette__item', { hasText: '资源' }).first().click()
      await page.locator('.kb-assets-pane').waitFor({ timeout: 20000 })
      await page.locator('.stats').waitFor({ timeout: 30000 })
    },
    'all'
  )

  const statsText = async () => (await page.locator('.stats').innerText()).replace(/\s+/g, ' ')
  const gotoFiles = async () => {
    await page.locator('.view-tabs button', { hasText: '文件' }).click()
    await page.waitForTimeout(250)
  }
  const refreshScan = async () => {
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForTimeout(1500)
    await page.locator('.stats').waitFor({ timeout: 30000 })
  }
  const assetNames = () => readdirSync(join(kb, 'assets')).sort()
  const readNote = (name) => readFileSync(join(kb, 'notes', name), 'utf8')
  const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const dialog = (title) => page.locator('.kb-assets-dialog').filter({ hasText: title })
  const selectAsset = async (relPath) => {
    await gotoFiles()
    await page.locator('.file-row', { hasText: relPath }).click()
    await page.locator('.detail').waitFor({ timeout: 5000 })
  }
  const applyDialog = async (title) => {
    const box = dialog(title)
    await box.locator('footer .save-button').click()
    try {
      await box.waitFor({ state: 'detached', timeout: 40000 })
    } catch {
      const body = (await box.innerText()).replace(/\s+/g, ' ')
      assert(false, `执行后对话框未关闭，可能被拒绝: ${body}`)
    }
  }
  const restoreLatest = async () => {
    await page.locator('.view-tabs button', { hasText: '历史' }).click()
    await page.locator('.history-row').first().waitFor({ timeout: 15000 })
    await page.locator('.history-row .ghost').first().click()
    await applyDialog('恢复')
  }

  await check('F1 · 统计数字与覆盖状态', async () => {
    const stats = await statsText()
    assert(
      stats.includes(`${ACCEPTANCE_EXPECTED.assetCount} 个文件`),
      `资源总数应为 ${ACCEPTANCE_EXPECTED.assetCount}，实际: ${stats}`
    )
    assert(
      stats.includes(`已解析引用 ${ACCEPTANCE_EXPECTED.determinedReferences}`),
      `已解析引用应为 ${ACCEPTANCE_EXPECTED.determinedReferences}，实际: ${stats}`
    )
    assert(
      stats.includes(`不确定引用 ${ACCEPTANCE_EXPECTED.uncertainReferences}`),
      `不确定引用应为 ${ACCEPTANCE_EXPECTED.uncertainReferences}，实际: ${stats}`
    )
    assert(
      stats.includes(`可合并重复组 ${ACCEPTANCE_EXPECTED.mergeableDuplicateGroups}`),
      `可合并重复组应为 ${ACCEPTANCE_EXPECTED.mergeableDuplicateGroups}，实际: ${stats}`
    )
    assert(
      stats.includes(`跨笔记同内容 ${ACCEPTANCE_EXPECTED.crossNoteDuplicates}`),
      `跨笔记同内容应为 ${ACCEPTANCE_EXPECTED.crossNoteDuplicates}，实际: ${stats}`
    )
    const coverage = await page.locator('.coverage').innerText()
    assert(!/未覆盖|不确定/.test(coverage) || /已覆盖/.test(coverage), `覆盖状态异常: ${coverage}`)
    assert(
      !/warn/.test(await page.locator('.coverage').getAttribute('class')),
      '覆盖状态带 warn 类'
    )
    await page.screenshot({ path: join(shots, 'F1-files.png') })
  })

  await check('F1 · 状态分类（闲置 / 受保护 / 不确定）', async () => {
    const filter = page.locator('.filters select').nth(1)
    await filter.selectOption('idle-candidate')
    await page.waitForTimeout(300)
    const idle = (await page.locator('.file-list').innerText()).replace(/\s+/g, ' ')
    assert(idle.includes('assets/idle.png'), `疑似闲置应含 idle.png，实际: ${idle}`)
    assert(
      idle.includes('0001-26-09-10-22-51-41.webp'),
      `疑似闲置应含未引用的旧 webp，实际: ${idle}`
    )
    assert(!idle.includes('0002-big.png'), '0002-big.png 已被引用，不应列为闲置')

    await filter.selectOption('protected')
    await page.waitForTimeout(300)
    const protectedText = (await page.locator('.file-list').innerText()).replace(/\s+/g, ' ')
    assert(
      protectedText.includes('0004-drawing.excalidraw'),
      `.excalidraw 应受保护，实际: ${protectedText}`
    )

    // 画布是绘图真相源：重命名入口必须是禁用的，并且说清原因（不能填完表单才被拒）
    await page
      .locator('.file-list button, .file-list li')
      .filter({ hasText: '0004-drawing.excalidraw' })
      .first()
      .click()
    await page.waitForTimeout(200)
    const renameState = await page.locator('[data-asset-rename-state]').innerText()
    const renameDisabled = await page.locator('[data-asset-rename]').isDisabled()
    assert(renameDisabled, 'excalidraw 的重命名按钮应处于禁用状态')
    assert(
      renameState.includes('归属编号'),
      `重命名禁用原因应说明画布文件名由归属编号决定，实际: ${renameState}`
    )

    await filter.selectOption('uncertain-affected')
    await page.waitForTimeout(300)
    const uncertain = (await page.locator('.file-list').innerText()).replace(/\s+/g, ' ')
    assert(
      uncertain.includes('0004-fenced-only.png'),
      `仅在代码围栏提到的图应为不确定，实际: ${uncertain}`
    )
    await filter.selectOption('all')
    await page.waitForTimeout(200)
  })

  await check('F1 · 内容重复筛选', async () => {
    const filter = page.locator('.filters select').nth(1)
    await filter.selectOption('duplicates')
    await page.waitForTimeout(400)
    const list = (await page.locator('.file-list').innerText()).replace(/\s+/g, ' ')
    assert(list.includes('0002-dup-a.png'), `重复筛选应含 0002-dup-a.png，实际: ${list}`)
    assert(list.includes('0002-dup-b.png'), `重复筛选应含 0002-dup-b.png，实际: ${list}`)
    await page.screenshot({ path: join(shots, 'F1-duplicates.png') })
    await filter.selectOption('all')
    await page.waitForTimeout(200)
  })

  await check('F1 · 断链列表可定位', async () => {
    await page.locator('.view-tabs button', { hasText: '已确定断链' }).click()
    await page.waitForTimeout(400)
    const entry = page.locator('.plain-list li').filter({ hasText: '0004-missing.png' }).first()
    assert((await entry.count()) > 0, '断链列表未见 0004-missing.png')
    const broken = (await entry.innerText()).replace(/\s+/g, ' ')
    assert(/:9\b/.test(broken), `断链应定位到第 9 行，实际: ${broken}`)
    await page.screenshot({ path: join(shots, 'F1-broken.png') })
  })

  await check('F1 · 诊断与历史', async () => {
    await page.locator('.view-tabs button', { hasText: '诊断' }).click()
    await page.waitForTimeout(400)
    const diagnosticsSection = page.locator('section').filter({ hasText: '适配器' }).first()
    const diagnostics = (await diagnosticsSection.innerText()).replace(/\s+/g, ' ')
    assert(
      /unsupported-syntax/.test(diagnostics),
      `诊断应含 unsupported-syntax，实际: ${diagnostics}`
    )
    await page.locator('.view-tabs button', { hasText: '历史' }).click()
    await page.waitForTimeout(400)
    const history = await page.locator('.history').innerText()
    assert(/还没有可恢复的整理记录/.test(history), `历史应为空，实际: ${history}`)
    await page.screenshot({ path: join(shots, 'F1-diagnostics.png') })
  })

  await check('F3 · 同笔记重复合并 → 引用改写 → 历史可还原', async () => {
    const before = readNote('0002. 重复与合并.md')
    assert((before.match(/0002-dup-b\.png/g) ?? []).length === 1, '前置：笔记应引用 dup-b 一次')
    await selectAsset('assets/0002-dup-a.png')
    const detail = await page.locator('.detail').innerText()
    assert(/同笔记内容重复 2 个/.test(detail), `详情应提示可合并 2 个，实际: ${detail}`)
    const mergeButton = page.getByRole('button', { name: '合并重复', exact: true })
    assert(await mergeButton.isEnabled(), '同笔记重复时合并按钮应可用')
    await mergeButton.click()
    const mergeBox = dialog('合并同笔记重复')
    await mergeBox.waitFor({ timeout: 10000 })
    const mergePreview = (await mergeBox.innerText()).replace(/\s+/g, ' ')
    assert(/0002-dup-b\.png/.test(mergePreview), `合并预览应列出被替代文件，实际: ${mergePreview}`)
    await page.screenshot({ path: join(shots, 'F3-merge-preview.png') })
    await applyDialog('合并同笔记重复')
    assert(!existsSync(join(kb, 'assets', '0002-dup-b.png')), 'dup-b 应已离开 assets（进回收区）')
    assert(existsSync(join(kb, 'assets', '0002-dup-a.png')), 'dup-a 应保留')
    const after = readNote('0002. 重复与合并.md')
    assert(!/0002-dup-b\.png/.test(after), '笔记引用应已改指向保留文件')
    assert(
      (after.match(/0002-dup-a\.png/g) ?? []).length === 2,
      `应有 2 处引用 dup-a，实际: ${after}`
    )
    const expected = before.replaceAll('0002-dup-b.png', '0002-dup-a.png')
    assert(
      after === expected,
      `除引用目标外笔记字节应不变。\n实际: ${JSON.stringify(after)}\n期望: ${JSON.stringify(expected)}`
    )

    await restoreLatest()
    assert(existsSync(join(kb, 'assets', '0002-dup-b.png')), '恢复后 dup-b 应回到 assets')
    assert(readNote('0002. 重复与合并.md') === before, '恢复后笔记应与合并前逐字节一致')
    await page.screenshot({ path: join(shots, 'F3-restored.png') })
  })

  await check('F3 · 跨笔记同内容不可合并', async () => {
    await refreshScan()
    await selectAsset('assets/0003-dup-c.png')
    const mergeButton = page.getByRole('button', { name: '合并重复', exact: true })
    assert(!(await mergeButton.isEnabled()), '跨笔记同内容不应提供合并')
    const detail = await page.locator('.detail').innerText()
    assert(!/可合并到当前文件/.test(detail), `跨笔记不应显示可合并，实际: ${detail}`)
    const stats = await statsText()
    assert(stats.includes('跨笔记同内容 3'), `统计应保留跨笔记同内容 3，实际: ${stats}`)
    assert(stats.includes('可合并重复组 1'), `恢复后应回到 1 个可合并重复组，实际: ${stats}`)
  })

  await check('F4 · 有损压缩：预览标「有损」、执行后变小、可恢复', async () => {
    const bigPath = join(kb, 'assets', '0002-big.png')
    const beforeHash = sha256(bigPath)
    const beforeSize = statSync(bigPath).size
    await selectAsset('assets/0002-big.png')
    await page.getByRole('button', { name: '有损压缩', exact: true }).click()
    const box = dialog('有损压缩（sharp）')
    await box.waitFor({ timeout: 10000 })
    await box.getByRole('button', { name: '预览', exact: true }).click()
    await box.locator('.preview').waitFor({ timeout: 40000 })
    const preview = (await box.locator('.preview').innerText()).replace(/\s+/g, ' ')
    assert(/有损/.test(preview), `预览必须标注「有损」，实际: ${preview}`)
    assert(!/无损/.test(preview), `sharp 预览不得出现「无损」，实际: ${preview}`)
    assert(/跳过 0/.test(preview), `该图不应被跳过，实际: ${preview}`)
    await page.screenshot({ path: join(shots, 'F4-optimize-preview.png') })
    await applyDialog('有损压缩（sharp）')
    const afterSize = statSync(bigPath).size
    assert(afterSize < beforeSize, `执行后应变小：${beforeSize} → ${afterSize}`)
    assert(sha256(bigPath) !== beforeHash, '执行后内容应变化')

    await selectAsset('assets/0002-small.jpg')
    await page.getByRole('button', { name: '有损压缩', exact: true }).click()
    const skipBox = dialog('有损压缩（sharp）')
    await skipBox.waitFor({ timeout: 10000 })
    await skipBox.getByRole('button', { name: '预览', exact: true }).click()
    await skipBox.locator('.preview').waitFor({ timeout: 40000 })
    const skipText = (await skipBox.locator('.preview').innerText()).replace(/\s+/g, ' ')
    assert(/优化后没有变小|跳过 1/.test(skipText), `已压小的 JPEG 应跳过，实际: ${skipText}`)
    await skipBox.getByRole('button', { name: '取消', exact: true }).click()
    await skipBox.waitFor({ state: 'detached', timeout: 10000 })

    await restoreLatest()
    assert(sha256(bigPath) === beforeHash, '恢复后原图应与压缩前逐字节一致')
  })

  await check('F5 · 转 WebP 改扩展名并同步引用；透明转 JPEG 拦截', async () => {
    const noteBefore = readNote('0002. 重复与合并.md')
    assert(/0002-alpha\.png/.test(noteBefore), '前置：笔记应引用 alpha.png')
    await selectAsset('assets/0002-alpha.png')
    await page.getByRole('button', { name: '有损压缩', exact: true }).click()
    const box = dialog('有损压缩（sharp）')
    await box.waitFor({ timeout: 10000 })
    await box.locator('select').nth(2).selectOption('webp')
    await box.getByRole('button', { name: '预览', exact: true }).click()
    await box.locator('.preview').waitFor({ timeout: 40000 })
    const preview = (await box.locator('.preview').innerText()).replace(/\s+/g, ' ')
    assert(/0002-alpha\.webp/.test(preview), `预览应显示新扩展名胜，实际: ${preview}`)
    assert(/有损/.test(preview), `转码预览应标注「有损」，实际: ${preview}`)
    await applyDialog('有损压缩（sharp）')
    assert(existsSync(join(kb, 'assets', '0002-alpha.webp')), '应生成 .webp')
    assert(!existsSync(join(kb, 'assets', '0002-alpha.png')), '旧 .png 应进回收区')
    const noteAfter = readNote('0002. 重复与合并.md')
    assert(/0002-alpha\.webp/.test(noteAfter), '笔记引用应改成 .webp')
    assert(!/0002-alpha\.png/.test(noteAfter), '笔记不应残留旧扩展名引用')

    await selectAsset('assets/0002-alpha.webp')
    await page.getByRole('button', { name: '有损压缩', exact: true }).click()
    const jpegBox = dialog('有损压缩（sharp）')
    await jpegBox.waitFor({ timeout: 10000 })
    await jpegBox.locator('select').nth(2).selectOption('jpeg')
    await jpegBox.getByRole('button', { name: '预览', exact: true }).click()
    await jpegBox.locator('.preview').waitFor({ timeout: 40000 })
    const jpegText = (await jpegBox.locator('.preview').innerText()).replace(/\s+/g, ' ')
    assert(
      /透明图转 JPEG 需要先选择背景色|跳过 1/.test(jpegText),
      `透明图转 JPEG 未设背景应跳过，实际: ${jpegText}`
    )
    await jpegBox.getByRole('button', { name: '取消', exact: true }).click()
    await jpegBox.waitFor({ state: 'detached', timeout: 10000 })
    await page.screenshot({ path: join(shots, 'F5-webp.png') })
  })

  await check('F2 · 同笔记粘贴复用 / 跨笔记再落一份（真实 ⌘V）', async () => {
    const source = join(materials, 'big.png')
    if (!existsSync(source)) assert(false, `缺少素材 ${source}`)
    const setClipboard = () => {
      execFileSync(
        'osascript',
        ['-e', `set the clipboard to (read (POSIX file "${source}") as «class PNGf»)`],
        { stdio: 'ignore' }
      )
    }
    const openNote = async (title) => {
      // TOC 行把编号与标题渲染成两个元素，innerText 里是换行而非 “0002. 标题”。
      const row = page.locator('.toc-row', { hasText: title }).first()
      await row.click()
      try {
        await page.locator('.live-editor:visible').first().waitFor({ timeout: 5000 })
      } catch {
        await row.dblclick()
        await page.locator('.live-editor:visible').first().waitFor({ timeout: 30000 })
      }
      await page.waitForTimeout(600)
      await page.locator('.editor-surface:visible').first().click()
      await page.waitForTimeout(200)
    }
    const waitFor = async (label, predicate, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = await predicate()
        if (value) return value
        await page.waitForTimeout(300)
      }
      return assert(false, `等待超时：${label}`)
    }
    const countRefs = (content, relPath) =>
      (content.match(new RegExp(relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length

    const before = assetNames()
    await openNote('重复与合并')
    setClipboard()
    await page.keyboard.press('Meta+V')
    const firstAdded = await waitFor('第一次粘贴落盘', () => {
      const added = assetNames().filter((name) => !before.includes(name))
      return added.length > 0 ? added : null
    })
    assert(firstAdded.length === 1, `第一次粘贴应新增 1 个文件，实际: ${firstAdded.join(',')}`)
    const pasted = firstAdded[0]
    assert(/^0002-/.test(pasted), `粘贴资源应带当前笔记编号前缀，实际: ${pasted}`)
    const pastedPath = join(kb, 'assets', pasted)
    const sourceSize = statSync(source).size
    const pastedSize = statSync(pastedPath).size
    assert(pastedSize < sourceSize, `粘贴应走压缩：${sourceSize} → ${pastedSize}`)
    assert(pasted.endsWith('.png'), `keep 格式应保持 .png，实际: ${pasted}`)
    await waitFor('笔记写入第一次引用', () =>
      countRefs(readNote('0002. 重复与合并.md'), pasted) === 1 ? true : null
    )

    setClipboard()
    await page.keyboard.press('Meta+V')
    await page.waitForTimeout(3500)
    const afterSecond = assetNames()
    assert(
      afterSecond.length === before.length + 1,
      `同笔记第二次粘贴不应新增文件：期望 ${before.length + 1}，实际 ${afterSecond.length}`
    )
    assert(
      countRefs(readNote('0002. 重复与合并.md'), pasted) === 2,
      '第二次粘贴应复用同一路径（笔记中 2 处引用）'
    )

    await openNote('跨笔记')
    setClipboard()
    await page.keyboard.press('Meta+V')
    const crossAdded = await waitFor('跨笔记粘贴落盘', () => {
      const added = assetNames().filter((name) => !afterSecond.includes(name))
      return added.length > 0 ? added : null
    })
    assert(crossAdded.length === 1, `跨笔记粘贴应新增 1 个文件，实际: ${crossAdded.join(',')}`)
    assert(/^0003-/.test(crossAdded[0]), `跨笔记资源应带目标笔记前缀，实际: ${crossAdded[0]}`)
    assert(crossAdded[0] !== pasted, '跨笔记不应复用同笔记的路径')
    await page.screenshot({ path: join(shots, 'F2-paste-reuse.png') })
  })

  const scrollerInfo = () =>
    page.evaluate(() => {
      const host =
        [...document.querySelectorAll('.live-editor')].find((el) => el.getClientRects().length > 0) ??
        document.body
      let node = host
      while (node && node !== document.body) {
        if (node.scrollHeight > node.clientHeight + 40) {
          return { scrollTop: node.scrollTop, max: node.scrollHeight - node.clientHeight }
        }
        node = node.parentElement
      }
      return { scrollTop: 0, max: 0 }
    })

  await check(
    'F7 · 有未保存文档时 apply 被拒绝且不改文件',
    async () => {
      await page.locator('.toc-row', { hasText: '重复与合并' }).first().click()
      await page.locator('.live-editor:visible').first().waitFor({ timeout: 30000 })
      await page.waitForTimeout(600)
      await page.locator('.editor-surface:visible').first().click()
      await page.keyboard.type('门禁测试：这段不应被保存')
      await page.waitForTimeout(300)

      await page.locator('.tab', { hasText: '资源' }).first().click()
      await page.locator('.kb-assets-pane').waitFor({ timeout: 10000 })
      await selectAsset('assets/0002-big.png')
      await page.getByRole('button', { name: '有损压缩', exact: true }).click()
      const box = dialog('有损压缩（sharp）')
      await box.waitFor({ timeout: 10000 })
      await box.getByRole('button', { name: '预览', exact: true }).click()
      await box.locator('.preview, .blocked').first().waitFor({ timeout: 40000 })
      const target = join(kb, 'assets', '0002-big.png')
      const beforeHash = sha256(target)
      const execute = box.locator('footer .save-button')
      assert(await execute.isEnabled(), '存在可优化项时执行按钮应可用（门禁在 apply 阶段拦截）')
      await execute.click()
      await box.locator('.blocked').waitFor({ timeout: 30000 })
      const blocked = (await box.locator('.blocked').innerText()).replace(/\s+/g, ' ')
      assert(/有未保存文档|未保存/.test(blocked), `apply 应被拒绝并列出原因，实际: ${blocked}`)
      assert(await box.isVisible(), '被拒绝时对话框应保持打开以便用户处理')
      assert(sha256(target) === beforeHash, '被拒绝时不应改写资源文件')
      await page.screenshot({ path: join(shots, 'F7-gate.png') })
      await box.getByRole('button', { name: '取消', exact: true }).click()
      await box.waitFor({ state: 'detached', timeout: 10000 })
    },
    'gate'
  )

  await check(
    'F6 · 重开后位置大致保留且不凭空变 dirty',
    async () => {
      await page.locator('.toc-row', { hasText: '重复与合并' }).first().click()
      await page.locator('.live-editor:visible').first().waitFor({ timeout: 30000 })
      await page.waitForTimeout(800)
      const before = await page.evaluate(() => {
        const host = [...document.querySelectorAll('.live-editor')].find(
          (el) => el.getClientRects().length > 0
        )
        let current = host
        while (current && current !== document.body) {
          if (current.scrollHeight > current.clientHeight + 40) {
            current.scrollTop = current.scrollHeight
            return { found: true, scrollTop: current.scrollTop }
          }
          current = current.parentElement
        }
        return { found: false, scrollTop: 0 }
      })
      assert(
        before.found && before.scrollTop > 0,
        `未能把笔记滚动到底部: ${JSON.stringify(before)}`
      )
      const noteBefore = readNote('0002. 重复与合并.md')
      console.log('dirty dots before apply:', await page.locator('.tab .dirty-dot').count())

      await page.locator('.tab', { hasText: '资源' }).first().click()
      await page.locator('.kb-assets-pane').waitFor({ timeout: 10000 })
      await selectAsset('assets/0002-big.png')
      await page.getByRole('button', { name: '有损压缩', exact: true }).click()
      const box = dialog('有损压缩（sharp）')
      await box.waitFor({ timeout: 10000 })
      await box.getByRole('button', { name: '预览', exact: true }).click()
      await box.locator('.preview').waitFor({ timeout: 40000 })
      await applyDialog('有损压缩（sharp）')
      await page.waitForTimeout(1500)

      const noteAfter = readNote('0002. 重复与合并.md')
      assert(
        noteAfter.replace(/0002-mind\.(png|webp)/g, '0002-mind.<ext>') ===
          noteBefore.replace(/0002-mind\.(png|webp)/g, '0002-mind.<ext>'),
        '仅扩展名允许变化，其余笔记字节不应被改写'
      )
      const dirtyDots = await page.locator('.tab .dirty-dot').count()
      assert(dirtyDots === 0, `应用后不应有标签变 dirty，实际 ${dirtyDots} 个`)
      // 回到笔记标签再测量：否则取到的是隐藏编辑器，滚动断言会变成空断言
      await page.locator('.tab', { hasText: '重复与合并' }).first().click()
      await page.locator('.live-editor:visible').first().waitFor({ timeout: 20000 })
      await page.waitForTimeout(1200)
      const after = await scrollerInfo()
      await page.screenshot({ path: join(shots, 'F6-reopen.png') })
      assert(after.max > 0, `重开后笔记应仍是可滚动长文，实际 ${JSON.stringify(after)}`)
      assert(
        after.scrollTop > 0,
        `重开后滚动位置应大致保留（非回到顶部），实际 ${JSON.stringify(after)}`
      )
    },
    'main'
  )

  const openSettings = async () => {
    await page.keyboard.press('ControlOrMeta+Shift+p')
    const palette = page.locator('.command-palette__input')
    await palette.waitFor({ timeout: 15000 })
    await palette.fill('>open-settings')
    await page.locator('.command-palette__item', { hasText: '设置' }).first().click()
    await page.locator('.settings-panel').waitFor({ timeout: 15000 })
    await page.locator('.settings-nav .nav-item', { hasText: '图片与图床' }).click()
    await page.locator('.image-settings').waitFor({ timeout: 10000 })
  }
  const closeSettings = async () => {
    await page.locator('[aria-label="关闭设置"]').click()
    await page.locator('.settings-panel').waitFor({ state: 'detached', timeout: 10000 })
  }
  const playground = () => page.locator('.optimize-playground')
  const waitEncoding = async (timeout = 60000) => {
    await playground()
      .locator('.busy')
      .waitFor({ state: 'detached', timeout })
      .catch(() => {})
    await page.waitForTimeout(400)
  }

  await check(
    'N3 · GitHub 图床配置按需渲染',
    async () => {
      await openSettings()
      assert(
        await page.locator('.image-settings input[value="local"]').isChecked(),
        '默认应为本地 assets'
      )
      assert(
        (await page.locator('.sub-block', { hasText: 'GitHub 图床配置' }).count()) === 0,
        '本地 assets 模式下不应渲染 GitHub 配置块'
      )
      assert((await playground().count()) === 1, '本地资源压缩块与试压块应常显')

      await page.locator('.image-settings input[value="github"]').check()
      await page.waitForTimeout(300)
      const githubBlock = page.locator('.sub-block', { hasText: 'GitHub 图床配置' })
      assert((await githubBlock.count()) === 1, '选中 GitHub 后应渲染配置块')
      const warn = (await githubBlock.locator('.warn-hint').innerText()).replace(/\s+/g, ' ')
      assert(/回退到本地 assets/.test(warn), `未配置时应提示回退，实际: ${warn}`)

      await page.locator('.image-settings input[value="local"]').check()
      await page.waitForTimeout(300)
      assert(
        (await page.locator('.sub-block', { hasText: 'GitHub 图床配置' }).count()) === 0,
        '切回本地 assets 后配置块应再次隐藏'
      )
      await page.screenshot({ path: join(shots, 'N3-settings-local.png') })
    },
    'settings'
  )

  await check(
    'N1 · 设置页试压：data URL 预览、有损徽标、不写入知识库',
    async () => {
      const assetsBefore = assetNames()
      await playground().locator('.hidden-input').setInputFiles(join(materials, 'big.png'))
      await playground().locator('.stats').waitFor({ timeout: 60000 })
      await waitEncoding()
      const srcs = await playground()
        .locator('img.zoomable')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src') ?? ''))
      assert(srcs.length >= 2, `应同时展示原图与优化图，实际 ${srcs.length} 张`)
      assert(
        srcs.every((src) => src.startsWith('data:image/')),
        `预览必须用 data: URL（CSP 不允许 blob:），实际: ${srcs.join(' | ').slice(0, 120)}`
      )
      const badge = (
        await playground().locator('.lossy-badge, .lossless-badge').first().innerText()
      ).trim()
      assert(badge === '有损', `sharp 试压徽标应为「有损」，实际: ${badge}`)
      const saved = await playground().locator('[data-testid="saved-percent"]').innerText()
      assert(/-\d+%/.test(saved), `应显示体积下降，实际: ${saved}`)
      assert(assetNames().join(',') === assetsBefore.join(','), '试压不得写入任何知识库 assets')
      await page.screenshot({ path: join(shots, 'N1-playground.png') })
    },
    'settings'
  )

  await check(
    'N5 · 强度档改变压缩结果',
    async () => {
      // 纯随机噪声在 palette 量化下各档体积相同，用渐变/平滑图才能真正看出强度差异
      await playground().locator('.hidden-input').setInputFiles(join(materials, 'alpha.png'))
      await playground().locator('.stats').waitFor({ timeout: 60000 })
      await waitEncoding()
      const strength = page
        .locator('.image-settings .sub-block')
        .filter({ hasText: '图片压缩' })
        .locator('select')
        .nth(1)
      await strength.selectOption('low')
      await waitEncoding()
      const bytesAt = async () => {
        const text = (await playground().locator('.stats').innerText()).replace(/\s+/g, ' ')
        const match = text.match(/优化后\s*([\d.]+)\s*(B|KB|MB)/)
        assert(match, `未能从试压统计中读出优化后体积，实际: ${text}`)
        const value =
          Number(match[1]) * (match[2] === 'B' ? 1 : match[2] === 'KB' ? 1024 : 1024 * 1024)
        return { value, text }
      }
      const low = await bytesAt()
      await strength.selectOption('high')
      await waitEncoding()
      const high = await bytesAt()
      assert(high.value <= low.value, `高强度不应比低强度更大：低 ${low.text} / 高 ${high.text}`)
      console.log(`strength low=${low.text} high=${high.text}`)
    },
    'settings'
  )

  await check(
    'N1b · GIF 试压给出跳过原因',
    async () => {
      await playground().locator('.hidden-input').setInputFiles(join(materials, 'gif.gif'))
      await playground().locator('.warn-hint').first().waitFor({ timeout: 60000 })
      await waitEncoding()
      const hint = (await playground().locator('.warn-hint').first().innerText()).replace(
        /\s+/g,
        ' '
      )
      assert(/GIF/.test(hint), `GIF 应给出跳过原因，实际: ${hint}`)
    },
    'settings'
  )

  await check(
    'N2 · 全屏对比浮层：左键下一张 / 右键上一张 / Esc 关闭',
    async () => {
      await playground().locator('.hidden-input').setInputFiles(join(materials, 'big.png'))
      await playground().locator('.stats').waitFor({ timeout: 60000 })
      await waitEncoding()
      await playground().locator('img.zoomable').first().click()
      const lightbox = page.locator('.image-lightbox')
      await lightbox.waitFor({ timeout: 10000 })
      const counter = () => lightbox.locator('.counter').innerText()
      assert(/1 \/ 2/.test(await counter()), `打开时应停在点选的那张，实际: ${await counter()}`)
      await lightbox.locator('.stage img').click()
      assert(/2 \/ 2/.test(await counter()), `左键应切到下一张，实际: ${await counter()}`)
      await lightbox.locator('.stage img').click({ button: 'right' })
      assert(/1 \/ 2/.test(await counter()), `右键应回到上一张，实际: ${await counter()}`)
      await page.screenshot({ path: join(shots, 'N2-lightbox.png') })
      await page.keyboard.press('Escape')
      await lightbox.waitFor({ state: 'detached', timeout: 10000 })
      await closeSettings()
    },
    'settings'
  )

  await check(
    'N4 · oxipng 无损：仅 PNG、隐藏转码参数、标注「无损」、执行可恢复',
    async () => {
      await page.locator('.tab', { hasText: '资源' }).first().click()
      await page.locator('.kb-assets-pane').waitFor({ timeout: 15000 })
      await selectAsset('assets/0002-big.png')
      await page.getByRole('button', { name: '有损压缩', exact: true }).click()
      // 切到 oxipng 后标题会变成「无损优化（oxipng）」，这里用不依赖标题的对话框定位
      const box = page.locator('.kb-assets-dialog').last()
      await box.waitFor({ timeout: 10000 })
      await box.locator('select').first().selectOption('oxipng')
      await page.waitForTimeout(300)
      assert(
        (await box.locator('select').count()) === 2,
        `oxipng 模式应只保留编码器与优化级别，实际 ${await box.locator('select').count()} 个下拉`
      )
      assert(/无损优化/.test(await box.innerText()), 'oxipng 模式标题应写「无损优化」')
      const target = join(kb, 'assets', '0002-big.png')
      const before = { size: statSync(target).size, hash: sha256(target) }
      // 编码期间在渲染进程跑 rAF 计时器：若主线程被同步 WASM 阻塞，帧数会明显偏低
      await page.evaluate(() => {
        window.__rafTicks = 0
        const start = performance.now()
        const step = () => {
          window.__rafTicks += 1
          if (performance.now() - start < 20000) requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
      await box.getByRole('button', { name: '预览', exact: true }).click()
      await box.locator('.preview').waitFor({ timeout: 120000 })
      const preview = (await box.locator('.preview').innerText()).replace(/\s+/g, ' ')
      assert(/无损/.test(preview), `oxipng 预览应标注「无损」，实际: ${preview}`)
      assert(!/有损/.test(preview), `oxipng 预览不应出现「有损」，实际: ${preview}`)
      const rafTicks = await page.evaluate(() => window.__rafTicks)
      console.log('rAF ticks during oxipng preview:', rafTicks, '|', preview.slice(0, 120))
      assert(rafTicks > 20, `oxipng 编码期间界面应保持可渲染，实际帧数 ${rafTicks}`)
      await box.locator('.preview').screenshot({ path: join(shots, 'N4-oxipng-preview.png') })
      await box.locator('footer .save-button').click()
      await box.waitFor({ state: 'detached', timeout: 120000 })
      const after = { size: statSync(target).size, hash: sha256(target) }
      assert(after.size < before.size, `oxipng 后应变小：${before.size} → ${after.size}`)
      const magic = readFileSync(target).subarray(0, 8).toString('hex')
      assert(magic.startsWith('89504e47'), `无损优化后应仍是 PNG，实际头 ${magic}`)
      await refreshScan()
      await restoreLatest()
      assert(sha256(target) === before.hash, '恢复后应与优化前逐字节一致')
    },
    'settings'
  )

  await check('F8 · SSG 产物资源完整、URL 带 base、无回收/日志路径', async () => {
    const ssgEntry = join(deskDir, '..', '..', 'packages', 'ssg', 'dist', 'index.js')
    assert(existsSync(ssgEntry), `未找到已构建的 SSG 包: ${ssgEntry}`)
    const { buildSite } = await import(pathToFileURL(ssgEntry).href)

    const config = JSON.parse(readFileSync(join(kb, 'tnotes.json'), 'utf8'))
    writeFileSync(
      join(kb, 'tnotes.json'),
      JSON.stringify({ ...config, base: '/acceptance/', title: 'acceptance' }, null, 2) + '\n'
    )
    await buildSite(kb)

    const distRoot = join(kb, '.tnotes', 'dist')
    // buildSite 把站点写在 <kb>/.tnotes/dist，base 只影响产物里的 URL 前缀
    const siteAssets = readdirSync(join(distRoot, 'assets')).sort()
    const kbAssets = assetNames()
    assert(
      siteAssets.join(',') === kbAssets.join(','),
      `产物资源应与知识库一致\n产物: ${siteAssets.join(',')}\n知识库: ${kbAssets.join(',')}`
    )
    const distFiles = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = join(dir, entry.name)
        if (entry.isDirectory()) walk(next)
        else distFiles.push(next)
      }
    }
    walk(distRoot)
    const leaked = distFiles.filter((file) =>
      /asset-journals|asset-recycle|journal|recycle/.test(file)
    )
    assert(leaked.length === 0, `产物中不应出现 journal / 回收区路径: ${leaked.join(',')}`)

    const home = readFileSync(join(distRoot, 'index.html'), 'utf8')
    assert(home.includes('/acceptance/assets/'), '站点首页应使用带 base 的资源 URL')
    const noteFiles = []
    const walkHtml = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = join(dir, entry.name)
        if (entry.isDirectory()) walkHtml(next)
        else if (entry.name.endsWith('.html')) noteFiles.push(next)
      }
    }
    walkHtml(distRoot)
    const html = noteFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
    for (const asset of kbAssets.filter((name) => name.startsWith('0002-'))) {
      const referenced =
        html.includes(`/acceptance/assets/${asset}`) ||
        html.includes(`/acceptance/assets/${encodeURIComponent(asset)}`) ||
        // 脑图 payload 里的图片仍以相对路径内嵌（本检查只要求它出现在产物中）
        html.includes(`assets/${asset}`) ||
        html.includes(`assets%2F${encodeURIComponent(asset)}`)
      assert(referenced, `笔记产物应引用 ${asset}`)
    }
    console.log('SSG dist files:', distFiles.length, '| assets:', siteAssets.length)

    // 用真实浏览器加载产物，把「URL 有效」从推断变成观测
    const serveRoot = join(fixture, 'serve')
    mkdirSync(serveRoot, { recursive: true })
    symlinkSync(distRoot, join(serveRoot, 'acceptance'), 'dir')
    const port = 8123
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.wasm': 'application/wasm',
      '.woff2': 'font/woff2'
    }
    // GitHub Pages 风格：无扩展名路由回退到 .html，SPA 客户端路由才不会 404
    const server = createServer(async (request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      for (const candidate of [
        join(serveRoot, pathname),
        join(serveRoot, `${pathname}.html`),
        join(serveRoot, pathname, 'index.html')
      ]) {
        try {
          if ((await statAsync(candidate)).isFile()) {
            const ext = candidate.slice(candidate.lastIndexOf('.'))
            response.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' })
            response.end(await readFileAsync(candidate))
            return
          }
        } catch {
          // try next candidate
        }
      }
      response.writeHead(404)
      response.end('not found')
    })
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
    try {
      const ready = await fetch(`http://127.0.0.1:${port}/acceptance/index.html`)
        .then((response) => response.ok)
        .catch(() => false)
      assert(ready, '静态服务器未就绪')
      const { chromium } = await import('playwright-core')
      // 不要写死本机缓存路径：交给 playwright-core 解析版本匹配的浏览器，否则本地用旧
      // revision、CI 上文件不存在直接红（需要先 `playwright-core install chromium`）。
      const browser = await chromium.launch({ args: ['--no-sandbox'] })
      try {
        const sitePage = await browser.newPage()
        const failedResponses = []
        sitePage.on('response', (response) => {
          if (response.status() >= 400)
            failedResponses.push(`${response.status()} ${response.url()}`)
        })
        await sitePage.goto(`http://127.0.0.1:${port}/acceptance/notes/2`, {
          waitUntil: 'networkidle'
        })
        await sitePage.waitForTimeout(1500)
        const images = await sitePage.evaluate(() =>
          [...document.images].map((img) => ({
            src: img.getAttribute('src'),
            width: img.naturalWidth
          }))
        )
        const broken = images.filter((img) => img.width === 0)
        console.log('site images:', JSON.stringify(images))
        console.log('site HTTP >=400:', JSON.stringify([...new Set(failedResponses)]))
        await sitePage.screenshot({ path: join(shots, 'F8-site-note.png'), fullPage: true })
        assert(broken.length === 0, `站点里有加载失败的图片: ${JSON.stringify(broken)}`)
        const assetFailures = [...new Set(failedResponses)].filter((entry) =>
          /assets\//.test(entry)
        )
        assert(assetFailures.length === 0, `站点资源请求失败: ${assetFailures.join(', ')}`)
      } finally {
        await browser.close()
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  await check(
    'F1 · 无页面错误',
    async () => {
      assert(pageErrors.length === 0, `页面报错: ${pageErrors.join(' | ')}`)
    },
    'all'
  )
} finally {
  const summary = results.map((item) => `${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  console.log('\n===== ACCEPTANCE SELF-TEST =====')
  for (const line of summary) console.log(line)
  for (const item of results.filter((r) => !r.ok)) {
    for (const note of item.notes) console.log(`  ↳ ${item.name}: ${note}`)
  }
  if (pageErrors.length) console.log('\nPAGE ERRORS:\n' + pageErrors.join('\n'))
  if (httpErrors.length) console.log('\nHTTP >=400:\n' + [...new Set(httpErrors)].join('\n'))
  console.log(`\nshots: ${shots}`)
  console.log(`fixture kept for inspection: ${fixture}`)
  await app.close().catch(() => {})
  if (!process.env.KEEP_FIXTURE) rmSync(fixture, { recursive: true, force: true })
  process.exitCode = results.some((item) => !item.ok) ? 1 : 0
  void phase
  void existsSync
  void readFileSync
}
