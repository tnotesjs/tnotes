/**
 * 无序/有序/任务列表的 Backspace 行为：空列表项一次删除整个项，并回到前一可编辑项末尾。
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
 * 光标在 `666` 末尾，连按三次删掉文本后，**第四次**应是「删除整个空列表项」，
 * 回到 `555` 末尾，且不残留任何空块。
 *
 * ## 为什么不用 Milkdown 默认（`LiftFirstListItem` → `joinBackward`）
 *
 * 默认行为会把空 `list_item` **提升出列表**成一个段落：
 *  - 顶层项：列表后面多出一个空段落，序列化成一行 `<br />`；
 *  - 嵌套项（实测 `- 444 / - 555` 里删空 555）：外层列表里多出一个**空的
 *    `list_item`**（还挂着它自己的空子列表），列表外再多一个空段落 —— 也就是
 *    用户看到的 `  - <br />` 与"光标停在 `p.crepe-placeholder` 的 offset 0"。
 *
 * ## 本实现
 *
 * 只做一件事：**把整个空 `list_item` 从它的父列表里删掉**（它是父列表唯一的子项时，
 * 连父列表一起删，避免留下非法的空列表）；光标直接落到"文档顺序上最近一个**有内容的**
 * 文本块末尾"。不提升、不 join、不做位置加减的拼接收尾，所以不会留下任何空块。
 *
 * 之前试过的写法都实测失败过（留档避免回退）：
 *  - 只 `liftListItem`：空项被提升成列表内/外的空块，见上；
 *  - 先 `joinBackward`：留下结构性空 `list_item`（写成 `  - <br />`）；
 *  - 两次独立 dispatch（第二次传旧 state）：`RangeError: Applying a mismatched transaction`；
 *  - 把 `joinBackward` 的 steps 搬进同一条 transaction：`Inconsistent open depths`；
 *  - 在 lift 产物上删"残留空段落"：嵌套场景仍会留下空 `list_item`（本次探针实测）。
 */

import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { TextSelection, type Command, type Transaction } from '@milkdown/kit/prose/state'
import { $shortcut } from '@milkdown/kit/utils'

const LIST_TYPES = new Set(['bullet_list', 'ordered_list'])

export const listItemEmptyBackspace: Command = (state, dispatch) => {
  const { selection } = state
  if (!selection.empty) return false

  const { $from } = selection
  // 命中条件：光标在 list_item 自己的第一个块、且该块是**空的段落**。
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parent.content.size !== 0) return false
  if ($from.parentOffset !== 0) return false

  const itemDepth = $from.depth - 1
  if (itemDepth < 1) return false
  const item = $from.node(itemDepth)
  if (item.type.name !== 'list_item') return false
  // 空段落必须是本项的第一块，且整项确实没有任何文字 —— 否则（本项还有别的段落 /
  // 有内容的嵌套列表）删整项会把用户的内容一起删掉，放行给默认行为（join 前后块）。
  if ($from.index(itemDepth) !== 0) return false
  if (item.textContent !== '') return false

  const listDepth = itemDepth - 1
  const list = $from.node(listDepth)
  if (!LIST_TYPES.has(list.type.name)) return false

  const itemStart = $from.before(itemDepth)
  // 上一个"有内容的文本块"末尾。找不到（空文档里只有一个空列表之类）就不接管，
  // 让默认键位去处理这种边角。
  const target = previousTextEnd(state.doc, itemStart)
  if (target === null) return false
  if (!dispatch) return true

  const tr: Transaction = state.tr
  if (list.childCount > 1) {
    tr.delete(itemStart, itemStart + item.nodeSize)
  } else {
    // 这一项是父列表的唯一子项：连列表一起删。父级是 doc 时，能找到 `target`
    // 说明列表前面还有别的块，删除后文档不会变空。
    const listStart = $from.before(listDepth)
    tr.delete(listStart, listStart + list.nodeSize)
  }

  // 删除发生在 target 之后，位置不变；仍走 mapping 以防将来调整删除范围。
  const mapped = tr.mapping.map(target)
  const $mapped = tr.doc.resolve(mapped)
  if (!$mapped.parent.isTextblock) return false
  tr.setSelection(TextSelection.create(tr.doc, mapped))

  dispatch(tr)
  return true
}

/**
 * 位置 `before` 之前、文档顺序上最后一个**有内容的文本块**的末尾光标位。
 *
 * 不用 `Selection.findFrom(..., -1)`：它在文本块内会停到**最后一个字符之前**
 * （实测 offset 2 而不是 3），所以这里直接算文本块末尾位 `pos + nodeSize - 1`。
 */
function previousTextEnd(doc: ProseMirrorNode, before: number): number | null {
  let found: number | null = null
  doc.descendants((node, pos) => {
    if (!node.isTextblock || node.content.size === 0) return true
    const end = pos + node.nodeSize - 1
    if (end < before) found = end
    return true
  })
  return found
}

/** 优先级高于 Milkdown 的默认键位（默认 50）。 */
export const listBackspaceKeymap = $shortcut(() => ({
  EmptyListItemBackspace: {
    key: 'Backspace',
    priority: 100,
    onRun: () => listItemEmptyBackspace
  }
}))
