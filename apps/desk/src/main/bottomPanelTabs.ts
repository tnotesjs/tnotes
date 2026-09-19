import { deskLog } from './log'
import { BOTTOM_PANEL_TABS_DEFAULT_MAX, planBottomPanelCapacity } from '../shared/bottomPanelTabs'

import type {
  BottomPanelCapacityPlan,
  BottomPanelTabKind,
  BottomPanelTabSnapshot
} from '../shared/bottomPanelTabs'

/**
 * 主进程的**统一容量检查入口**。
 *
 * 底部面板的标签分散在两个注册表里（终端会话在 `TerminalManager`，命令任务在
 * `CommandTaskManager`）。两个管理器把自己的标签注册成 provider，本模块把两边合起来，
 * 交给 `shared/bottomPanelTabs` 的纯函数判定，并在这里执行「回收谁 / 拒绝谁」。
 *
 * 这是唯一的检查点：管理器在真正创建前调用它，渲染端即使绕过界面直连 IPC 也绕不过
 * （而且渲染端约束不了主进程内部的创建，例如后台 fetch 失败建的任务）。
 */
export interface BottomPanelTabProvider {
  readonly kind: BottomPanelTabKind
  /** 当前所有标签的快照（含已结束的：它们是回收候选） */
  listTabs(): BottomPanelTabSnapshot[]
  /** 回收（关闭）一个**已结束**标签；provider 只会收到纯函数挑出的可回收项 */
  closeTab(id: string): void
}

const providers = new Map<BottomPanelTabKind, BottomPanelTabProvider>()

export function registerBottomPanelTabProvider(provider: BottomPanelTabProvider): void {
  providers.set(provider.kind, provider)
}

/** 仅供测试：清空 provider 注册（生产只有单例管理器，不需要注销） */
export function resetBottomPanelTabProviders(): void {
  providers.clear()
}

let maxTabsProvider: () => number = () => BOTTOM_PANEL_TABS_DEFAULT_MAX

/**
 * 注入「当前上限从哪来」。生产在应用启动时接到设置（`settings.bottomPanel.maxTabs`）；
 * 不直接 import 设置模块，是为了让管理器的单测不必依赖 electron / 磁盘配置。
 *
 * 来源是**惰性读取**的：设置里改上限后，下一次检查立刻生效，不需要重启。
 */
export function configureBottomPanelMaxTabs(provider: () => number): void {
  maxTabsProvider = provider
}

/** 仅供测试：恢复默认上限来源 */
export function resetBottomPanelMaxTabs(): void {
  maxTabsProvider = () => BOTTOM_PANEL_TABS_DEFAULT_MAX
}

/** 当前全部标签快照（终端 + 命令任务），供检查与测试观察。 */
export function bottomPanelTabSnapshots(): BottomPanelTabSnapshot[] {
  return [...providers.values()].flatMap((provider) => provider.listTabs())
}

/** 当前上限（非法值在纯函数里会用默认值兜底）。 */
export function currentBottomPanelMaxTabs(): number {
  return maxTabsProvider()
}

export interface EnsureBottomPanelCapacityInput {
  /** 本次要新建/复用的标签类型（用于日志与后续按类型细化的规则） */
  kind: BottomPanelTabKind
  /** 复用已有标签：不新增，直接放行 */
  reuse?: boolean
}

/**
 * 判定并执行：允许就返回；要腾位置就先回收最老的已结束标签；拦不住就抛错。
 *
 * 抛出的错误会沿 IPC 变成 `{ ok:false, error:{ message } }`，渲染端直接展示该 message，
 * 因此 message 必须是面向用户的中文原因。
 */
export function ensureBottomPanelCapacity(
  input: EnsureBottomPanelCapacityInput
): BottomPanelCapacityPlan {
  const plan = planBottomPanelCapacity({
    tabs: bottomPanelTabSnapshots(),
    maxTabs: maxTabsProvider(),
    reuse: input.reuse ?? false
  })

  if (plan.action === 'recycle') {
    deskLog('bottom-panel:recycle', plan.victim.id, {
      kind: plan.victim.kind,
      requested: input.kind,
      maxTabs: plan.maxTabs,
      count: plan.count
    })
    providers.get(plan.victim.kind)?.closeTab(plan.victim.id)
  }
  if (plan.action === 'block') {
    deskLog('bottom-panel:blocked', input.kind, {
      reason: plan.reason,
      maxTabs: plan.maxTabs,
      count: plan.count
    })
    throw new Error(plan.message)
  }
  return plan
}
