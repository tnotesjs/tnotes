import { describe, expect, it } from 'vitest'

import {
  BOTTOM_PANEL_TABS_DEFAULT_MAX,
  BOTTOM_PANEL_TABS_MAX_LIMIT,
  clampBottomPanelMaxTabs,
  isBottomPanelTabRecyclable,
  pickBottomPanelRecycleVictim,
  planBottomPanelCapacity
} from './bottomPanelTabs'

import type { BottomPanelTabSnapshot } from './bottomPanelTabs'

function tab(
  id: string,
  options: { kind?: BottomPanelTabSnapshot['kind']; active?: boolean; createdAt?: number } = {}
): BottomPanelTabSnapshot {
  return {
    id,
    kind: options.kind ?? 'terminal',
    active: options.active ?? true,
    createdAt: options.createdAt ?? 0
  }
}

describe('clampBottomPanelMaxTabs', () => {
  it('接受 1-30 的正整数', () => {
    expect(clampBottomPanelMaxTabs(1)).toBe(1)
    expect(clampBottomPanelMaxTabs(10)).toBe(10)
    expect(clampBottomPanelMaxTabs(30)).toBe(30)
  })

  it('超过上界的值取上界（明确上界 30）', () => {
    expect(BOTTOM_PANEL_TABS_MAX_LIMIT).toBe(30)
    expect(clampBottomPanelMaxTabs(31)).toBe(30)
    expect(clampBottomPanelMaxTabs(9999)).toBe(30)
  })

  it('非法上限被拒（回默认值）：0、负数、小数、非数字、NaN/Infinity', () => {
    expect(BOTTOM_PANEL_TABS_DEFAULT_MAX).toBe(10)
    for (const value of [0, -1, -10, 1.5, 10.5, Number.NaN, Infinity, -Infinity]) {
      expect(clampBottomPanelMaxTabs(value)).toBe(BOTTOM_PANEL_TABS_DEFAULT_MAX)
    }
    for (const value of ['10', null, undefined, {}, [], true]) {
      expect(clampBottomPanelMaxTabs(value)).toBe(BOTTOM_PANEL_TABS_DEFAULT_MAX)
    }
  })
})

describe('pickBottomPanelRecycleVictim', () => {
  it('只挑已结束/已退出的标签，取最老的一个', () => {
    const victim = pickBottomPanelRecycleVictim([
      tab('running-old', { active: true, createdAt: 1 }),
      tab('done-new', { active: false, createdAt: 30 }),
      tab('done-old', { active: false, createdAt: 20 }),
      tab('exited-mid', { kind: 'terminal', active: false, createdAt: 25 })
    ])
    expect(victim?.id).toBe('done-old')
  })

  it('全部在运行时没有可回收项', () => {
    expect(pickBottomPanelRecycleVictim([tab('a'), tab('b')])).toBeNull()
  })

  it('创建时间相同时按 id 稳定排序（结果可复现）', () => {
    const victim = pickBottomPanelRecycleVictim([
      tab('b', { active: false, createdAt: 5 }),
      tab('a', { active: false, createdAt: 5 })
    ])
    expect(victim?.id).toBe('a')
  })

  it('isBottomPanelTabRecyclable 只认「已结束」', () => {
    expect(isBottomPanelTabRecyclable(tab('x', { active: false }))).toBe(true)
    expect(isBottomPanelTabRecyclable(tab('x', { active: true }))).toBe(false)
  })
})

describe('planBottomPanelCapacity', () => {
  it('未达上限：允许新建，不回收任何东西', () => {
    const plan = planBottomPanelCapacity({
      tabs: [tab('a'), tab('b'), tab('c', { active: false })],
      maxTabs: 10
    })
    expect(plan).toEqual({ action: 'allow', reason: 'under-limit', maxTabs: 10, count: 3 })
  })

  it('达上限但有已结束的：回收最老的那个，用掉这个名额', () => {
    const plan = planBottomPanelCapacity({
      tabs: [
        tab('run-1', { active: true, createdAt: 1 }),
        tab('done-1', { kind: 'command-task', active: false, createdAt: 2 }),
        tab('run-2', { active: true, createdAt: 3 }),
        tab('exited-1', { active: false, createdAt: 9 })
      ],
      maxTabs: 4
    })
    expect(plan.action).toBe('recycle')
    if (plan.action !== 'recycle') throw new Error('unreachable')
    // 最老的可回收项是 done-1（createdAt=2），而不是更老的运行中会话
    expect(plan.victim.id).toBe('done-1')
    expect(plan.maxTabs).toBe(4)
  })

  it('全部在运行：拒绝创建，并给出可行动的中文原因（含上限/数量/怎么办）', () => {
    const plan = planBottomPanelCapacity({
      tabs: [tab('a'), tab('b')],
      maxTabs: 2
    })
    expect(plan.action).toBe('block')
    if (plan.action !== 'block') throw new Error('unreachable')
    expect(plan.reason).toBe('all-active')
    expect(plan.message).toContain('最多同时保留 2 个标签')
    expect(plan.message).toContain('全部在运行')
    expect(plan.message).toContain('请先关闭')
    expect(plan.message).toContain('设置 → 标签与导航')
  })

  it('复用已有标签不占名额：已达上限甚至超限都放行', () => {
    const full = [tab('a'), tab('b'), tab('c')]
    expect(planBottomPanelCapacity({ tabs: full, maxTabs: 3, reuse: true })).toEqual({
      action: 'allow',
      reason: 'reuse',
      maxTabs: 3,
      count: 3
    })
    // 超限（上限被调低）时复用同样不受影响：复用本来就不新增标签
    expect(planBottomPanelCapacity({ tabs: full, maxTabs: 1, reuse: true }).action).toBe('allow')
  })

  it('上限调低后不杀进程：超限时只拦新建，绝不回收（哪怕有可回收项）', () => {
    const plan = planBottomPanelCapacity({
      tabs: [
        tab('run-1', { active: true }),
        tab('run-2', { active: true }),
        tab('run-3', { active: true }),
        tab('done-1', { active: false, createdAt: 1 })
      ],
      maxTabs: 2
    })
    expect(plan.action).toBe('block')
    if (plan.action !== 'block') throw new Error('unreachable')
    expect(plan.reason).toBe('over-limit')
    expect(plan.message).toContain('上限已调低为 2')
    expect(plan.message).toContain('不会为了腾位置回收正在运行的进程')
    expect(plan.message).toContain('至少 3 个')
  })

  it('运行中的标签永远不会被选为回收对象', () => {
    const plan = planBottomPanelCapacity({
      tabs: [tab('run-old', { active: true, createdAt: 1 }), tab('run-new', { active: true })],
      maxTabs: 2
    })
    expect(plan.action).toBe('block')
  })

  it('非法上限走默认值 10，不会把面板锁死', () => {
    const plan = planBottomPanelCapacity({
      tabs: Array.from({ length: 5 }, (_, index) => tab(`t${index}`)),
      maxTabs: 0
    })
    expect(plan).toMatchObject({ action: 'allow', reason: 'under-limit', maxTabs: 10 })
  })
})
