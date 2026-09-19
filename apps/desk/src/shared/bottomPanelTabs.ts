/**
 * 底部面板标签容量的**唯一**判定逻辑（纯函数，不碰进程与视图）。
 *
 * 底部面板的标签由两类组成：交互式终端会话（`terminal`）与命令任务（`command-task`）。
 * 本模块把「能不能新建 / 该回收谁 / 为什么被拦」收在一处，主进程与渲染端共用同一份
 * 规则——以后改规则只改这里，不会出现「主进程和界面各判一套」的分叉。
 *
 * 已批准的默认规则：
 *  1. **合并计数**：终端会话 + 命令任务一起算，上限是总数，不是各自算；
 *  2. 默认上限 10，最大 30（设置里的 zod schema 与本文件的常量一致）；
 *  3. 达到上限还要新建时，回收**最老的已结束任务 / 已退出终端**，用掉这个名额；
 *  4. 如果全部在运行（没有可回收的）→ 阻止创建，并给出可行动的中文原因；
 *  5. **复用**已有标签（同库同种命令任务复用/重跑）不占新名额；
 *  6. **绝不回收仍在运行的标签**：调低上限不能被用来结束任何进程；
 *  7. 上限被调低后（当前数量 > 上限）**不自动回收**：回收一个仍然超限，
 *     所以直接阻止新建，直到用户把数量降回上限以下。
 */

/** 合法的下限：0 或负数不是「上限」，是非法值 */
export const BOTTOM_PANEL_TABS_MIN_LIMIT = 1
/** 明确的上界：与设置 schema 的 `.max(...)` 一致 */
export const BOTTOM_PANEL_TABS_MAX_LIMIT = 30
/** 默认上限 */
export const BOTTOM_PANEL_TABS_DEFAULT_MAX = 10

export type BottomPanelTabKind = 'terminal' | 'command-task'

/** 参与容量计算的一条标签（终端会话或命令任务）。 */
export interface BottomPanelTabSnapshot {
  id: string
  kind: BottomPanelTabKind
  /** 仍在运行/推进：**绝不可回收**（回收等于结束进程） */
  active: boolean
  /** 创建时间：回收时挑最老的一条 */
  createdAt: number
}

export interface BottomPanelCapacityInput {
  tabs: readonly BottomPanelTabSnapshot[]
  /** 上限（非法值会被 clamp 回默认值，不会让调用方炸掉） */
  maxTabs: number
  /** 本次操作是否复用已有标签（不新增） */
  reuse?: boolean
}

export type BottomPanelCapacityBlockReason = 'all-active' | 'over-limit'

export type BottomPanelCapacityPlan =
  | { action: 'allow'; reason: 'reuse' | 'under-limit'; maxTabs: number; count: number }
  | { action: 'recycle'; maxTabs: number; count: number; victim: BottomPanelTabSnapshot }
  | {
      action: 'block'
      reason: BottomPanelCapacityBlockReason
      maxTabs: number
      count: number
      message: string
    }

/**
 * 把任意输入规范成合法上限：**只接受正整数**，越界取上界，非法值回默认值。
 *
 * 设置层的 zod 已经会挡非法值（严格的 `settings.update` 直接报错，读配置时逐字段回默认），
 * 这里只是给主进程的权威检查加一道兜底：配置被手改成脏值时也不该出现「上限为 0 就永远建不了」。
 */
export function clampBottomPanelMaxTabs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return BOTTOM_PANEL_TABS_DEFAULT_MAX
  }
  if (value < BOTTOM_PANEL_TABS_MIN_LIMIT) return BOTTOM_PANEL_TABS_DEFAULT_MAX
  if (value > BOTTOM_PANEL_TABS_MAX_LIMIT) return BOTTOM_PANEL_TABS_MAX_LIMIT
  return value
}

/** 可回收 = 已经结束的标签（已退出终端 / 已结束任务）。 */
export function isBottomPanelTabRecyclable(tab: BottomPanelTabSnapshot): boolean {
  return !tab.active
}

/**
 * 挑要回收的标签：所有可回收项里**最老**的一个。
 * 没有可回收项（全部在运行）时返回 null —— 调用方据此走「阻止创建」。
 */
export function pickBottomPanelRecycleVictim(
  tabs: readonly BottomPanelTabSnapshot[]
): BottomPanelTabSnapshot | null {
  let victim: BottomPanelTabSnapshot | null = null
  for (const tab of tabs) {
    if (!isBottomPanelTabRecyclable(tab)) continue
    if (
      victim === null ||
      tab.createdAt < victim.createdAt ||
      (tab.createdAt === victim.createdAt && tab.id < victim.id)
    ) {
      victim = tab
    }
  }
  return victim
}

function allActiveMessage(maxTabs: number, count: number): string {
  return (
    `底部面板最多同时保留 ${maxTabs} 个标签（终端会话与命令任务合计），` +
    `当前 ${count} 个全部在运行，无法自动回收，已阻止新建。` +
    `请先关闭一些终端或命令任务标签，或在「设置 → 标签与导航」调高「底部面板标签上限」。`
  )
}

function overLimitMessage(maxTabs: number, count: number): string {
  // 要让新建后不超上限，数量必须先降到 maxTabs - 1 以下
  const needClose = count - maxTabs + 1
  return (
    `底部面板上限已调低为 ${maxTabs} 个标签（终端会话与命令任务合计），当前已有 ${count} 个，超过上限。` +
    `不会为了腾位置回收正在运行的进程；请先关闭至少 ${needClose} 个标签再新建，` +
    `或在「设置 → 标签与导航」调高「底部面板标签上限」。`
  )
}

/**
 * 判定一次「新建/复用」请求。
 *
 * 返回 `allow` 可继续；`recycle` 表示先关掉 `victim` 再用这个名额；`block` 表示拒绝，
 * `message` 是直接可展示给用户的中文原因。
 */
export function planBottomPanelCapacity(input: BottomPanelCapacityInput): BottomPanelCapacityPlan {
  const maxTabs = clampBottomPanelMaxTabs(input.maxTabs)
  const count = input.tabs.length

  // 复用已有标签不新增，也不受上限影响
  if (input.reuse) return { action: 'allow', reason: 'reuse', maxTabs, count }
  if (count < maxTabs) return { action: 'allow', reason: 'under-limit', maxTabs, count }

  // 正好到上限：优先回收最老的已结束/已退出标签，用掉这个名额
  if (count === maxTabs) {
    const victim = pickBottomPanelRecycleVictim(input.tabs)
    if (victim) return { action: 'recycle', maxTabs, count, victim }
    return {
      action: 'block',
      reason: 'all-active',
      maxTabs,
      count,
      message: allActiveMessage(maxTabs, count)
    }
  }

  // 数量已经超过上限（上限被调低）：回收一个仍然超限，所以不回收，直接拦住
  return {
    action: 'block',
    reason: 'over-limit',
    maxTabs,
    count,
    message: overLimitMessage(maxTabs, count)
  }
}
