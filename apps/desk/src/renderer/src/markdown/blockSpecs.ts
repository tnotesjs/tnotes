/**
 * 块嵌套角色（todos 2026.11.02 · 06）。只描述「谁能嵌谁」，渲染、序列化、编辑行为另管。
 *
 * - `container`：tip / info / warning / danger / details 这类 `:::` 容器，子节点只允许普通内容。
 * - `topLevel`：须在文档根的特殊块，不进容器、不互嵌（`allowParents` 白名单除外）。
 * - `ordinary`：普通 Markdown；未登记的块都按它处理。
 *
 * 不检测、不自动修已写坏的嵌套；这张表只用来约束插入入口。
 */
export type NestRole = 'ordinary' | 'container' | 'topLevel'

export type BlockSpec = {
  /** 稳定类型名，与解析 / 插入菜单对齐 */
  type: string
  nest: NestRole
  /** 额外允许的父 block type；仅 topLevel 需要时填写 */
  allowParents?: readonly string[]
}

/** 未出现在此表中的块 → nest: 'ordinary' */
export const BLOCK_SPECS: readonly BlockSpec[] = [
  { type: 'tip', nest: 'container' },
  { type: 'info', nest: 'container' },
  { type: 'warning', nest: 'container' },
  { type: 'danger', nest: 'container' },
  { type: 'details', nest: 'container' },

  // 代码组的内容就是代码块
  { type: 'code', nest: 'topLevel', allowParents: ['code-group'] },
  { type: 'code-group', nest: 'topLevel' },
  { type: 'mermaid', nest: 'topLevel' },
  { type: 'mindmap', nest: 'topLevel' },
  { type: 'excalidraw', nest: 'topLevel', allowParents: ['swiper'] },
  { type: 'notes-table', nest: 'topLevel' },
  { type: 'bilibili', nest: 'topLevel' },
  { type: 'word-list', nest: 'topLevel' },
  { type: 'footprints', nest: 'topLevel' },
  { type: 'swiper', nest: 'topLevel' }
]

function specOf(type: string): BlockSpec | undefined {
  return BLOCK_SPECS.find((spec) => spec.type === type)
}

export function nestOf(type: string): NestRole {
  return specOf(type)?.nest ?? 'ordinary'
}

/** `parentType` 为 null 表示文档根。 */
export function canNest(parentType: string | null, childType: string): boolean {
  if (parentType == null) return true
  const child = specOf(childType)
  const childNest = child?.nest ?? 'ordinary'
  if (nestOf(parentType) === 'container') return childNest === 'ordinary'
  if (childNest === 'topLevel' || childNest === 'container') {
    return child?.allowParents?.includes(parentType) ?? false
  }
  // 普通内容放在 topLevel / 未登记的父级里：交给 Markdown 与宿主自己的规则
  return true
}

/** 插入菜单项 id → BlockSpec 类型（画布插的是 excalidraw，表格是普通 Markdown）。 */
export function blockTypeOfMenuItem(id: string): string {
  if (id === 'canvas') return 'excalidraw'
  return id
}
