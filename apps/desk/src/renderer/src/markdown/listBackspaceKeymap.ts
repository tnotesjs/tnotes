/**
 * 无序/有序列表的 Backspace 行为：空列表项一次删除整个项，并回到前一可编辑项末尾。
 *
 * 复现场景（用户在真实界面确认过）：
 * ```
 * - 111
 *   - 222
 *     - 333
 * - 444
 *   - 555
 * - 666
 * ```
 * 光标在 `666` 末尾，连按三次删掉文本后，**第四次**应是「删除整个空列表项」。
 *
 * Milkdown 默认把空 `list_item` 的 Backspace 绑到 `LiftFirstListItem` → `joinBackward`，
 * 实测有两个问题：
 *  1. 第 4 次删除空项后，**再按一次 Backspace 又会在 555 后面冒出一个嵌套空项**；
 *  2. 那个空项被序列化成 `  - <br />` 写进 markdown（用户看到的是"没有提示的空行"）。
 *
 * 这里用更高优先级的 keymap 抢在默认键位前（默认 50，与 headingKeymap 同一手法）：
 *  - 只处理「空选区的空 list_item」——有内容、有选区、非行首一律放行；
 *  - 顶层空项：`joinBackward` 回到前一项末尾；
 *  - 嵌套空项：先 `joinBackward`（能并进上一项文本就直接并），否则 `liftListItem`
 *    退出列表，**绝不**留一个空 `list_item` 在文档里（它就会被写成 `- <br />`）。
 */

import { liftListItem } from '@milkdown/kit/prose/schema-list'
import type { Command } from '@milkdown/kit/prose/state'
import { $shortcut } from '@milkdown/kit/utils'

/** 命中的列表项为空（其唯一子节点段落里没有文本）。 */
function isEmptyListItem(state: Parameters<Command>[0]): boolean {
  const { $from } = state.selection
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parent.content.size !== 0) return false
  // 段落的直接父级必须是 list_item
  const item = $from.node(-1)
  return item?.type.name === 'list_item'
}

/**
 * 光标是否在一个**末尾的空段落**里。
 *
 * 不能要求"本项只有一个块"：实测在
 * ```
 * - 444
 *   - 555
 * - <空项>
 * ```
 * 这类结构上按 Backspace 时，`$from.node(-1)` 的 childCount 会是 3（项里已有多个块），
 * 守卫过严会让命令放行、退回到默认行为，于是又冒出一个空项（并被写成 `- <br />`）。
 */
function atItemStart(state: Parameters<Command>[0]): boolean {
  const { $from } = state.selection
  if ($from.parentOffset !== 0) return false
  // 当前块必须是本 list_item 的最后一个子块
  return $from.index(-1) === $from.node(-1).childCount - 1
}

export const listItemEmptyBackspace: Command = (state, dispatch) => {
  const { selection, schema } = state
  if (!selection.empty) return false
  if (!isEmptyListItem(state) || !atItemStart(state)) return false

  const listItemType = schema.nodes.list_item
  if (!listItemType) return false

  // 直接 `liftListItem`（prosemirror-schema-list 的标准"删除空列表项/退出列表"原语）。
  // **不要**先试 `joinBackward`：实测它会返回 true 并在文本上合并，但**留下一个结构性的
  // 空 `list_item`**，序列化出来就是 `- <br />`（正是本项要修的现象）。
  return liftListItem(listItemType)(state, dispatch)
}

/** 优先级高于 Milkdown 的默认键位（默认 50）。 */
export const listBackspaceKeymap = $shortcut(() => ({
  EmptyListItemBackspace: {
    key: 'Backspace',
    priority: 100,
    onRun: () => listItemEmptyBackspace
  }
}))
