import { syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { Extension, TransactionSpec } from '@codemirror/state'

/** 代码块折叠 / 全屏 / 换行。只存在于这次查看，不写进 Markdown。键是围栏开头那一行的起点。 */
interface CodeChromeMark {
  openFrom: number
  collapsed: boolean
  fullscreen: boolean
  /** 缺省不换行；只有用户打开换行时才记下 true */
  wrapped: boolean
}

export const toggleCodeCollapse = StateEffect.define<number>()
export const toggleCodeFullscreen = StateEffect.define<number>()
export const toggleCodeWrap = StateEffect.define<number>()

export const codeBlockChrome = StateField.define<CodeChromeMark[]>({
  create: () => [],
  update(marks, tr) {
    if (
      !tr.docChanged &&
      !tr.effects.some(
        (effect) =>
          effect.is(toggleCodeCollapse) || effect.is(toggleCodeFullscreen) || effect.is(toggleCodeWrap)
      )
    ) {
      return marks
    }
    let next = marks.map((mark) => ({ ...mark, openFrom: tr.changes.mapPos(mark.openFrom, -1) }))
    for (const effect of tr.effects) {
      if (effect.is(toggleCodeCollapse)) {
        const at = tr.changes.mapPos(effect.value, -1)
        const index = next.findIndex((mark) => mark.openFrom === at)
        if (index >= 0) next[index] = { ...next[index], collapsed: !next[index].collapsed }
        else next.push({ openFrom: at, collapsed: true, fullscreen: false, wrapped: false })
      } else if (effect.is(toggleCodeFullscreen)) {
        const at = tr.changes.mapPos(effect.value, -1)
        const current = next.find((mark) => mark.openFrom === at)
        const on = !(current?.fullscreen ?? false)
        next = next
          .filter((mark) => mark.openFrom !== at)
          .map((mark) => ({ ...mark, fullscreen: false }))
        next.push({
          openFrom: at,
          collapsed: current?.collapsed ?? false,
          fullscreen: on,
          wrapped: current?.wrapped ?? false
        })
      } else if (effect.is(toggleCodeWrap)) {
        const at = tr.changes.mapPos(effect.value, -1)
        const index = next.findIndex((mark) => mark.openFrom === at)
        if (index >= 0) next[index] = { ...next[index], wrapped: !next[index].wrapped }
        else next.push({ openFrom: at, collapsed: false, fullscreen: false, wrapped: true })
      }
    }
    return next.filter((mark) => mark.collapsed || mark.fullscreen || mark.wrapped)
  }
})

export function codeChromeAt(state: EditorState, openFrom: number): CodeChromeMark | null {
  return state.field(codeBlockChrome, false)?.find((mark) => mark.openFrom === openFrom) ?? null
}

export interface CollapsedCodeBody {
  from: number
  to: number
}

/** 收起的代码块正文（不含标题栏那一行，含结束围栏）。 */
export function collapsedCodeBodies(state: EditorState): CollapsedCodeBody[] {
  const marks = state.field(codeBlockChrome, false) ?? []
  const collapsed = new Set(marks.filter((mark) => mark.collapsed).map((mark) => mark.openFrom))
  if (collapsed.size === 0) return []
  const bodies: CollapsedCodeBody[] = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return
      const open = state.doc.lineAt(node.from)
      if (!collapsed.has(open.from)) return
      const close = state.doc.lineAt(node.to)
      if (close.number <= open.number) return
      bodies.push({ from: state.doc.line(open.number + 1).from, to: close.to })
    }
  })
  return bodies
}

/** 把选区从收起的代码正文里挪走。完全落在正文里则回到标题栏行尾。 */
export function clampRangeAroundCollapsed(
  from: number,
  to: number,
  bodies: CollapsedCodeBody[]
): { from: number; to: number } | null {
  let nextFrom = from
  let nextTo = to
  let changed = false
  for (const body of bodies) {
    if (nextTo <= body.from || nextFrom >= body.to) continue
    changed = true
    const inside = nextFrom >= body.from && nextTo <= body.to
    if (inside) {
      nextFrom = Math.max(0, body.from - 1)
      nextTo = nextFrom
    } else if (nextFrom < body.from && nextTo <= body.to) {
      nextTo = body.from
    } else if (nextFrom >= body.from && nextFrom < body.to && nextTo > body.to) {
      nextFrom = body.to
    } else {
      nextTo = body.from
    }
  }
  if (!changed) return null
  if (nextFrom > nextTo) return { from: nextTo, to: nextFrom }
  return { from: nextFrom, to: nextTo }
}

export const keepCursorOutOfCollapsedCode = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr
  if (tr.annotation(Transaction.userEvent) === 'select.code-clamp') return tr
  const mapped = collapsedCodeBodies(tr.startState).map((body) => ({
    from: tr.changes.mapPos(body.from, 1),
    to: tr.changes.mapPos(body.to, -1)
  }))
  const main = tr.newSelection.main
  const clamped = clampRangeAroundCollapsed(main.from, main.to, mapped)
  if (!clamped) return tr
  const selection =
    clamped.from === clamped.to
      ? EditorSelection.cursor(clamped.from)
      : EditorSelection.range(clamped.from, clamped.to)
  return {
    changes: tr.changes,
    effects: tr.effects,
    selection,
    scrollIntoView: false,
    filter: false,
    userEvent: 'select.code-clamp'
  } satisfies TransactionSpec
})

export const codeBlockFullscreenClass = ViewPluginForFullscreen()

function ViewPluginForFullscreen(): Extension {
  return [
    codeBlockChrome,
    keepCursorOutOfCollapsedCode,
    EditorView.updateListener.of((update) => {
      const marks = update.state.field(codeBlockChrome)
      const on = marks.some((mark) => mark.fullscreen)
      update.view.dom.classList.toggle('cm-lp-code-fs', on)
    }),
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.key !== 'Escape') return false
        const marks = view.state.field(codeBlockChrome)
        const open = marks.find((mark) => mark.fullscreen)
        if (!open) return false
        event.preventDefault()
        view.dispatch({ effects: toggleCodeFullscreen.of(open.openFrom) })
        return true
      }
    })
  ]
}
