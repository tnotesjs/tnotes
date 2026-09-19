import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.profile },
  // deskLog 会遍历窗口广播日志
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  BOTTOM_PANEL_TABS_DEFAULT_MAX,
  BOTTOM_PANEL_TABS_MAX_LIMIT
} from '../shared/bottomPanelTabs'
import {
  bottomPanelTabSnapshots,
  configureBottomPanelMaxTabs,
  currentBottomPanelMaxTabs,
  ensureBottomPanelCapacity,
  registerBottomPanelTabProvider,
  resetBottomPanelMaxTabs,
  resetBottomPanelTabProviders
} from './bottomPanelTabs'
import { loadSettings, saveSettings, writeSettingsRaw } from './settings'

import type { BottomPanelTabKind, BottomPanelTabSnapshot } from '../shared/bottomPanelTabs'

/** 内存 provider：closeTab 真的把标签移掉，方便断言「回收后再建就放行了」。 */
function providerFor(kind: BottomPanelTabKind, tabs: BottomPanelTabSnapshot[]) {
  const state = [...tabs]
  const closed: string[] = []
  registerBottomPanelTabProvider({
    kind,
    listTabs: () => state.map((tab) => ({ ...tab })),
    closeTab: (id) => {
      closed.push(id)
      const index = state.findIndex((tab) => tab.id === id)
      if (index >= 0) state.splice(index, 1)
    }
  })
  return { closed, state }
}

const terminal = (
  id: string,
  options: { active?: boolean; createdAt?: number } = {}
): BottomPanelTabSnapshot => ({
  id,
  kind: 'terminal',
  active: options.active ?? true,
  createdAt: options.createdAt ?? 0
})

const task = (
  id: string,
  options: { active?: boolean; createdAt?: number } = {}
): BottomPanelTabSnapshot => ({
  id,
  kind: 'command-task',
  active: options.active ?? true,
  createdAt: options.createdAt ?? 0
})

beforeEach(() => {
  environment.profile = mkdtempSync(join(tmpdir(), 'desk-bottom-panel-'))
  resetBottomPanelTabProviders()
  resetBottomPanelMaxTabs()
})

afterEach(() => {
  rmSync(environment.profile, { recursive: true, force: true })
})

describe('统一容量检查入口：终端与命令任务合并计数', () => {
  it('未达上限：放行，不回收任何标签', () => {
    const terminals = providerFor('terminal', [terminal('t1'), terminal('t2')])
    const tasks = providerFor('command-task', [task('c1', { active: false, createdAt: 1 })])
    expect(ensureBottomPanelCapacity({ kind: 'terminal' })).toMatchObject({
      action: 'allow',
      reason: 'under-limit',
      maxTabs: BOTTOM_PANEL_TABS_DEFAULT_MAX,
      count: 3
    })
    expect(terminals.closed).toEqual([])
    expect(tasks.closed).toEqual([])
  })

  it('达上限且两类合并后满员：回收最老的已结束标签（跨类型）', () => {
    const terminals = providerFor('terminal', [terminal('run-old', { createdAt: 1 })])
    const tasks = providerFor('command-task', [
      task('done-old', { active: false, createdAt: 2 }),
      task('run-new', { createdAt: 3 })
    ])
    configureBottomPanelMaxTabs(() => 3)
    const plan = ensureBottomPanelCapacity({ kind: 'terminal' })
    expect(plan.action).toBe('recycle')
    // 最老的已结束标签是命令任务（createdAt=2），即使它是「另一种类型」也照样回收
    expect(tasks.closed).toEqual(['done-old'])
    expect(terminals.closed).toEqual([])
    expect(bottomPanelTabSnapshots()).toHaveLength(2)
  })

  it('全部在运行：阻止创建并抛中文原因；一个标签都不会被关掉', () => {
    const terminals = providerFor('terminal', [terminal('t1'), terminal('t2')])
    configureBottomPanelMaxTabs(() => 2)
    expect(() => ensureBottomPanelCapacity({ kind: 'command-task' })).toThrow(/全部在运行/)
    expect(terminals.closed).toEqual([])
    expect(bottomPanelTabSnapshots()).toHaveLength(2)
  })

  it('复用已有标签不占名额：达到/超过上限都放行', () => {
    providerFor('terminal', [terminal('t1'), terminal('t2')])
    configureBottomPanelMaxTabs(() => 2)
    expect(ensureBottomPanelCapacity({ kind: 'command-task', reuse: true })).toMatchObject({
      action: 'allow',
      reason: 'reuse'
    })
    // 上限被调低到 1（当前 2 个）时，复用同样放行——它不会新增标签
    configureBottomPanelMaxTabs(() => 1)
    expect(ensureBottomPanelCapacity({ kind: 'terminal', reuse: true }).action).toBe('allow')
  })

  it('调低上限不杀进程：超限时只拦新建，正在运行的标签绝不被回收', () => {
    const terminals = providerFor('terminal', [
      terminal('run-1', { createdAt: 1 }),
      terminal('run-2', { createdAt: 2 })
    ])
    const tasks = providerFor('command-task', [task('done-1', { active: false, createdAt: 3 })])
    configureBottomPanelMaxTabs(() => 1)
    expect(() => ensureBottomPanelCapacity({ kind: 'terminal' })).toThrow(/上限已调低为 1/)
    expect(terminals.closed).toEqual([])
    expect(tasks.closed).toEqual([])
    expect(bottomPanelTabSnapshots()).toHaveLength(3)
  })

  it('上限来源可注入：设置改小后下一次检查立刻生效', () => {
    providerFor('terminal', [terminal('t1')])
    expect(currentBottomPanelMaxTabs()).toBe(BOTTOM_PANEL_TABS_DEFAULT_MAX)
    expect(ensureBottomPanelCapacity({ kind: 'terminal' }).action).toBe('allow')

    configureBottomPanelMaxTabs(() => 1)
    expect(currentBottomPanelMaxTabs()).toBe(1)
    expect(ensureBottomPanelCapacity({ kind: 'terminal', reuse: true }).action).toBe('allow')
    // 新建被拦（唯一的标签在运行，且已到上限）
    expect(() => ensureBottomPanelCapacity({ kind: 'command-task' })).toThrow()
  })
})

describe('bottomPanel.maxTabs 设置', () => {
  const path = () => join(environment.profile, '.tn-desk-config.json')

  it('默认 10；老配置没有分组时补默认值，且不清掉其它偏好', () => {
    expect(loadSettings().bottomPanel.maxTabs).toBe(10)
    writeFileSync(
      path(),
      JSON.stringify({
        version: 1,
        theme: 'dark',
        tabs: { maxOpenCount: 5, wrap: false, autoRevealInToc: true }
      })
    )
    const settings = loadSettings()
    expect(settings.bottomPanel.maxTabs).toBe(10)
    expect(settings.theme).toBe('dark')
    expect(settings.tabs.maxOpenCount).toBe(5)
    expect(existsSync(`${path()}.invalid.bak`)).toBe(false)
  })

  it('合法正整数持久化，且不被其它字段更新覆盖', () => {
    expect(saveSettings({ bottomPanel: { maxTabs: 3 } }).bottomPanel.maxTabs).toBe(3)
    expect(loadSettings().bottomPanel.maxTabs).toBe(3)
    saveSettings({ theme: 'dark' })
    expect(loadSettings().bottomPanel.maxTabs).toBe(3)
  })

  it('接受上界 30，超过上界/0/负数/小数一律拒绝（严格入口抛错，文件不变）', () => {
    expect(
      saveSettings({ bottomPanel: { maxTabs: BOTTOM_PANEL_TABS_MAX_LIMIT } }).bottomPanel.maxTabs
    ).toBe(30)
    const before = readFileSync(path(), 'utf8')
    for (const value of [0, -1, 31, 2.5, Number.NaN]) {
      expect(() => saveSettings({ bottomPanel: { maxTabs: value } })).toThrow()
      expect(readFileSync(path(), 'utf8')).toBe(before)
    }
    expect(() => writeSettingsRaw(JSON.stringify({ bottomPanel: { maxTabs: 0 } }))).toThrow()
  })

  it('读被手改坏的配置时逐字段回默认（不会把上限变成 0 把面板锁死）', () => {
    writeFileSync(path(), JSON.stringify({ bottomPanel: { maxTabs: 0 } }))
    expect(loadSettings().bottomPanel.maxTabs).toBe(BOTTOM_PANEL_TABS_DEFAULT_MAX)
    // 逐字段抢救：非法的具体字段被记录，配置文件留了备份
    expect(existsSync(`${path()}.invalid.bak`)).toBe(true)
  })
})
