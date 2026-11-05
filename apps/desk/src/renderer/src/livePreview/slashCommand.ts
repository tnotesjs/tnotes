/**
 * 斜杠快捷输入（可视化模式）。
 *
 * - 光标停在空行上时行内露出「输入 / 唤起更多」；
 * - 行首或空白后输入 `/`（中文输入法下是 `、`）弹出插入菜单，继续输入按名称 / 简写过滤
 *   （`/swdt`、`/mindmap` 都是思维导图），↑↓ 选择，Enter / Tab 插入，Esc 收起；
 * - 插入时删掉 `/简写`，块落在当前行（空行）或下一行。
 */
import { syntaxTree } from '@codemirror/language'
import { Facet, Prec, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  showTooltip
} from '@codemirror/view'

import { BlockPicker } from '../markdown/blockPicker'
import { blockTypeOfMenuItem, canNest } from '../markdown/blockSpecs'
import { INSERT_ITEMS, filterInsertItems } from '../markdown/insertCatalog'
import { containerAtCursor } from './containerAt'
import { livePreviewEnabled } from './host'
import { insertItemSpec } from './insertBlock'

import type { EditorState, Extension } from '@codemirror/state'
import type { DecorationSet, Tooltip, TooltipView, ViewUpdate } from '@codemirror/view'
import type { InsertItem } from '../markdown/insertCatalog'

/** 宿主提供：不支持的块、选图、新建画布 */
export interface InsertHost {
  exclude: readonly string[]
  pickImage(view: EditorView, pos: number): void
  insertCanvas(view: EditorView): void
}

export const insertHost = Facet.define<InsertHost, InsertHost>({
  combine: (values) =>
    values[values.length - 1] ?? {
      exclude: [],
      pickImage: () => undefined,
      insertCanvas: () => undefined
    }
})

const TRIGGERS = new Set(['/', '、'])
/** 这些节点里的 `/` 就是文字 */
const LITERAL_NODES = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'Frontmatter',
  'BlockMath',
  'InlineMath',
  'Table',
  'HTMLBlock',
  'ComponentBlock',
  'CommentBlock',
  'Container',
  'URL',
  'Autolink',
  'LinkReference'
])

interface SlashState {
  /** `/` 的位置 */
  from: number
  /** `/` 之后到光标的文字 */
  query: string
  /** 同一个对象一直沿用，菜单才不会每输入一个字就重建（选中项会丢） */
  tooltip: Tooltip
}

function slashTooltipAt(from: number): Tooltip {
  return { pos: from, above: false, arrow: false, create: (view) => slashTooltip(view) }
}

const closeSlash = StateEffect.define<null>()

function literalAt(state: EditorState, pos: number): boolean {
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
      state
    ).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (LITERAL_NODES.has(node.name)) return true
  }
  return false
}

/** 能弹菜单的位置：可视化、可编辑、行首或空白之后、不在代码 / 公式 / 组件里 */
function canTrigger(state: EditorState, slashPos: number): boolean {
  if (!state.facet(livePreviewEnabled) || state.readOnly) return false
  const line = state.doc.lineAt(slashPos)
  const before = state.doc.sliceString(line.from, slashPos)
  if (before !== '' && !/\s$/.test(before)) return false
  return !literalAt(state, slashPos)
}

const slashField = StateField.define<SlashState | null>({
  create: () => null,
  update(value, tr) {
    if (tr.effects.some((effect) => effect.is(closeSlash))) return null
    const { main } = tr.state.selection
    if (value) {
      if (!main.empty || tr.state.selection.ranges.length > 1) return null
      const from = tr.changes.mapPos(value.from, 1)
      const head = main.head
      if (head <= from || !TRIGGERS.has(tr.state.doc.sliceString(from, from + 1))) return null
      if (tr.state.doc.lineAt(from).number !== tr.state.doc.lineAt(head).number) return null
      const query = tr.state.doc.sliceString(from + 1, head)
      const composing = tr.isUserEvent('input.type.compose')
      if (!composing && /\s/.test(query)) return null
      if (query.length > 24) return null
      if (from === value.from && query === value.query) return value
      return { from, query, tooltip: from === value.from ? value.tooltip : slashTooltipAt(from) }
    }
    if (!tr.docChanged || !tr.isUserEvent('input.type') || !main.empty) return null
    let opened: SlashState | null = null
    tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
      const text = inserted.toString()
      // 输入法可能一次提交好几个字（`/tp`），只要以 `/` 开头、没有空白就算
      if (
        toB === main.head &&
        TRIGGERS.has(text[0]) &&
        text.length <= 24 &&
        !/\s/.test(text) &&
        canTrigger(tr.state, fromB)
      ) {
        opened = { from: fromB, query: text.slice(1), tooltip: slashTooltipAt(fromB) }
      }
    })
    return opened
  },
  provide: (field) => showTooltip.from(field, (value) => value?.tooltip ?? null)
})

/** 当前位置可插入的项（宿主排除的、嵌套规则不允许的都去掉） */
export function availableItems(state: EditorState, scope: 'slash' | 'toolbar'): InsertItem[] {
  const host = state.facet(insertHost)
  const parent = containerAtCursor(state)
  return INSERT_ITEMS.filter(
    (item) =>
      (scope === 'slash' || !item.slashOnly) &&
      !host.exclude.includes(item.id) &&
      canNest(parent, blockTypeOfMenuItem(item.id))
  )
}

/** 执行一项：图片 / 画布先腾好空行再交给宿主 */
export function runInsertItem(
  view: EditorView,
  item: InsertItem,
  remove?: { from: number; to: number }
): void {
  if (view.state.readOnly) return
  const at = remove?.from ?? view.state.selection.main.head
  view.dispatch({ ...insertItemSpec(view.state, item, at, remove), effects: closeSlash.of(null) })
  view.focus()
  const host = view.state.facet(insertHost)
  if (item.action.kind === 'image') host.pickImage(view, view.state.selection.main.head)
  else if (item.action.kind === 'canvas') host.insertCanvas(view)
}

const pickers = new WeakMap<EditorView, BlockPicker>()

function slashTooltip(view: EditorView): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-lp-slash-menu'
  let shownQuery: string | null = null
  const picker = new BlockPicker({
    onPick: (item) => {
      const value = view.state.field(slashField)
      if (!value) return
      runInsertItem(view, item, { from: value.from, to: view.state.selection.main.head })
    }
  })
  dom.append(picker.dom)
  const render = (): void => {
    const value = view.state.field(slashField)
    if (!value || value.query === shownQuery) return
    // 拼音还在组字时别跟着刷新，免得列表闪成「没有匹配」
    if (view.composing && shownQuery !== null) return
    shownQuery = value.query
    picker.setItems(
      filterInsertItems(availableItems(view.state, 'slash'), value.query),
      value.query === ''
    )
  }
  return {
    dom,
    mount: () => {
      pickers.set(view, picker)
      render()
    },
    update: (update: ViewUpdate) => {
      if (update.docChanged || update.selectionSet) render()
    },
    destroy: () => {
      if (pickers.get(view) === picker) pickers.delete(view)
    }
  }
}

function withPicker(run: (picker: BlockPicker, view: EditorView) => boolean) {
  return (view: EditorView): boolean => {
    if (!view.state.field(slashField, false)) return false
    const picker = pickers.get(view)
    return picker ? run(picker, view) : false
  }
}

const slashKeymap = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: withPicker((picker) => (picker.move(1), true)) },
    { key: 'ArrowUp', run: withPicker((picker) => (picker.move(-1), true)) },
    { key: 'Ctrl-n', run: withPicker((picker) => (picker.move(1), true)) },
    { key: 'Ctrl-p', run: withPicker((picker) => (picker.move(-1), true)) },
    {
      key: 'Enter',
      run: withPicker((picker, view) => {
        if (picker.pickSelected()) return true
        view.dispatch({ effects: closeSlash.of(null) })
        return false
      })
    },
    { key: 'Tab', run: withPicker((picker) => picker.pickSelected()) },
    {
      key: 'Escape',
      run: (view) => {
        if (!view.state.field(slashField, false)) return false
        view.dispatch({ effects: closeSlash.of(null) })
        return true
      }
    }
  ])
)

const closeOnBlur = EditorView.domEventHandlers({
  blur(_event, view) {
    // 点菜单时焦点不会离开编辑器（菜单阻止了 mousedown 的默认行为）
    if (view.state.field(slashField, false)) {
      setTimeout(() => {
        if (!view.hasFocus && view.state.field(slashField, false)) {
          view.dispatch({ effects: closeSlash.of(null) })
        }
      })
    }
    return false
  }
})

class SlashHintWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-lp-slash-hint'
    el.setAttribute('aria-hidden', 'true')
    el.textContent = '输入 / 唤起更多'
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

function hintDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const { main } = state.selection
  if (!view.hasFocus || !main.empty || state.selection.ranges.length > 1) return Decoration.none
  if (state.doc.length === 0 || state.field(slashField, false)) return Decoration.none
  const line = state.doc.lineAt(main.head)
  if (line.length > 0 || !canTrigger(state, line.from)) return Decoration.none
  return Decoration.set([
    Decoration.widget({ widget: new SlashHintWidget(), side: 1 }).range(line.from)
  ])
}

const slashHint = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = hintDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.transactions.length
      ) {
        this.decorations = hintDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

export const slashCommand: Extension = [slashField, slashKeymap, closeOnBlur, slashHint]

/** 当前菜单状态（`/` 的位置与输入）；没打开时为 null */
export function slashStateOf(state: EditorState): { from: number; query: string } | null {
  const value = state.field(slashField, false)
  return value ? { from: value.from, query: value.query } : null
}
