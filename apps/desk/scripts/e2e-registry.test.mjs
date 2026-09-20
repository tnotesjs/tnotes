// e2e 基建的回归测试：registry 完整性 + `--since` 用的 glob 语义。
// 这些是「改了 glob/删了套件没人发现」的唯一防线——runner 本身不好单测，
// 但注册表数据和匹配规则可以。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SUITES } from './e2e-registry.mjs'
import { matchesGlob } from './run-e2e.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

describe('e2e registry', () => {
  it('每个套件脚本都真实存在，且名字唯一', () => {
    const names = SUITES.map((suite) => suite.name)
    expect(new Set(names).size).toBe(names.length)
    for (const suite of SUITES) {
      expect(existsSync(join(SCRIPTS_DIR, suite.name)), `${suite.name} 不存在`).toBe(true)
    }
  })

  it('每个套件都有 area / tier / note / globs，globs 不含空项', () => {
    for (const suite of SUITES) {
      expect(suite.area, suite.name).toMatch(/^[a-z-]+$/)
      expect(['regression', 'manual']).toContain(suite.tier)
      expect(suite.note.length, suite.name).toBeGreaterThan(4)
      expect(suite.globs.length, suite.name).toBeGreaterThan(0)
      for (const glob of suite.globs) expect(glob.trim(), suite.name).not.toBe('')
    }
  })

  it('manual 套件不进冒烟集；smoke 都是 regression', () => {
    for (const suite of SUITES) {
      if (suite.smoke) expect(suite.tier, suite.name).toBe('regression')
      if (suite.tier === 'manual') expect(suite.smoke, suite.name).toBe(false)
    }
  })

  it('体检结论被固化：无断言工具与需打包产物的套件都是 manual', () => {
    const manual = SUITES.filter((suite) => suite.tier === 'manual').map((suite) => suite.name)
    expect(manual.sort()).toEqual([
      'e2e-excalidraw-e0.mjs',
      'e2e-mindmap.mjs',
      'e2e-packaged-smoke.mjs'
    ])
  })

  it('资源约束按 locks 声明：clipboard / focus 各成一组，回归集不再整机独占', () => {
    const byLock = (lock) =>
      SUITES.filter((suite) => (suite.locks ?? []).includes(lock))
        .map((suite) => suite.name)
        .sort()
    // OS 粘贴板是全局共享：这些套件复制/粘贴时会互相覆盖，必须互斥
    expect(byLock('clipboard')).toEqual(
      [
        'e2e-assets-acceptance.mjs',
        'e2e-block-interactions.mjs',
        'e2e-block-ranges.mjs',
        'e2e-excalidraw-copy.mjs',
        'e2e-image-chrome.mjs',
        // 这两个也用系统剪贴板做断言：漏了锁会与上面几个互相覆盖
        // （实测：并发跑时「复制路径给的是相对笔记文件的相对路径」读到 null）
        'e2e-image-copy-plain-text.mjs',
        'e2e-note-assets.mjs'
      ].sort()
    )
    // 依赖 OS 窗口焦点（sendInputEvent / 大窗口焦点断言）：彼此互斥即可，不必整机独占
    expect(byLock('focus')).toEqual(
      ['e2e-editor-focus.mjs', 'e2e-numbered-tabs.mjs', 'e2e-tab-drag.mjs'].sort()
    )
    // serial（整机独占）只剩 manual 套件：默认不参与回归
    expect(
      SUITES.filter((suite) => suite.serial)
        .map((suite) => suite.name)
        .sort()
    ).toEqual(['e2e-excalidraw-e0.mjs', 'e2e-mindmap.mjs', 'e2e-packaged-smoke.mjs'])
    for (const suite of SUITES) {
      if (suite.serial) expect(suite.locks ?? [], suite.name).toEqual([])
    }
  })
})

describe('matchesGlob（--since 的增量选择）', () => {
  it('精确路径与单层通配', () => {
    expect(matchesGlob('apps/desk/src/a.ts', 'apps/desk/src/a.ts')).toBe(true)
    expect(matchesGlob('apps/desk/src/*.ts', 'apps/desk/src/a.ts')).toBe(true)
    expect(matchesGlob('apps/desk/src/*.ts', 'apps/desk/src/nested/a.ts')).toBe(false)
    expect(matchesGlob('apps/desk/src/a.ts', 'apps/desk/src/b.ts')).toBe(false)
  })

  it('`**` 跨目录，`**/` 允许零层', () => {
    expect(matchesGlob('apps/desk/src/**', 'apps/desk/src/a/b/c.ts')).toBe(true)
    expect(matchesGlob('**/package.json', 'apps/desk/package.json')).toBe(true)
    expect(matchesGlob('**/package.json', 'package.json')).toBe(true)
    expect(matchesGlob('packages/kb/**', 'packages/kb/src/asset-scan/plan.ts')).toBe(true)
  })

  it('`?` 只匹配一个非斜杠字符', () => {
    expect(matchesGlob('a?.ts', 'ab.ts')).toBe(true)
    expect(matchesGlob('a?.ts', 'a/b.ts')).toBe(false)
  })

  it('正则元字符按字面处理', () => {
    expect(matchesGlob('apps/desk/src/a+b.ts', 'apps/desk/src/a+b.ts')).toBe(true)
    expect(matchesGlob('apps/desk/src/a+b.ts', 'apps/desk/src/aab.ts')).toBe(false)
    expect(
      matchesGlob('packages/ui/src/styles/tokens.css', 'packages/ui/src/styles/tokens.css')
    ).toBe(true)
  })
})
