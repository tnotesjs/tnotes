import {
  Annotation,
  ChangeSet,
  StateEffect,
  StateField,
  type ChangeSpec,
  type Extension,
  type Range,
  type Text
} from '@codemirror/state'
import { Decoration, EditorView, WidgetType, showPanel, type DecorationSet, type Panel } from '@codemirror/view'

/**
 * Agent 改动审阅：Agent 的修改直接进文档（用户立刻看到效果），改动处高亮，
 * 编辑器顶部出现「接受 / 撤销」条。撤销只回退 Agent 那一次的修改 ——
 * 之后用户在别处的编辑不受影响（逆向修改会映射过后续编辑）。
 */
interface Review {
  id: number
  label: string
  /** 应用 Agent 修改之后的文档 → 应用之前：逆向修改（随后续编辑映射） */
  inverse: ChangeSet
  /** 新插入文本的范围（随后续编辑映射） */
  inserted: Array<{ from: number; to: number }>
  /** 被删掉的文本（显示成删除线），挂在插入点 */
  removed: Array<{ at: number; text: string }>
}

const agentEdit = Annotation.define<boolean>()
const addReview = StateEffect.define<Review>()
const resolveReview = StateEffect.define<number>()

let nextId = 1

class RemovedTextWidget extends WidgetType {
  constructor(private readonly text: string) {
    super()
  }

  eq(other: RemovedTextWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-agent-removed'
    span.textContent = this.text.length > 400 ? `${this.text.slice(0, 400)}…` : this.text
    return span
  }
}

const reviewField = StateField.define<Review[]>({
  create: () => [],
  update(reviews, tr) {
    let next = reviews
    if (tr.docChanged && reviews.length > 0) {
      next = reviews.map((review) => ({
        ...review,
        inverse: review.inverse.map(tr.changes),
        inserted: review.inserted
          .map((range) => ({ from: tr.changes.mapPos(range.from, 1), to: tr.changes.mapPos(range.to, -1) }))
          .filter((range) => range.to > range.from),
        removed: review.removed.map((item) => ({ at: tr.changes.mapPos(item.at, -1), text: item.text }))
      }))
    }
    for (const effect of tr.effects) {
      if (effect.is(addReview)) next = [...next, effect.value]
      if (effect.is(resolveReview)) next = next.filter((review) => review.id !== effect.value)
    }
    return next
  }
})

const reviewDecorations = EditorView.decorations.compute([reviewField], (state): DecorationSet => {
  const ranges: Range<Decoration>[] = []
  for (const review of state.field(reviewField)) {
    for (const range of review.inserted) {
      if (range.to > range.from) ranges.push(Decoration.mark({ class: 'cm-agent-inserted' }).range(range.from, range.to))
    }
    for (const item of review.removed) {
      if (item.text) {
        ranges.push(Decoration.widget({ widget: new RemovedTextWidget(item.text), side: -1 }).range(item.at))
      }
    }
  }
  return Decoration.set(ranges, true)
})

function reviewPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-agent-review-panel'
  const render = (): void => {
    const reviews = view.state.field(reviewField)
    dom.replaceChildren()
    const label = document.createElement('span')
    label.className = 'cm-agent-review-label'
    label.textContent =
      reviews.length === 1 ? `Agent：${reviews[0].label}` : `Agent 有 ${reviews.length} 处修改待确认`
    const accept = document.createElement('button')
    accept.type = 'button'
    accept.className = 'is-primary'
    accept.textContent = '接受'
    accept.addEventListener('click', () => acceptAgentEdits(view))
    const reject = document.createElement('button')
    reject.type = 'button'
    reject.textContent = '撤销'
    reject.addEventListener('click', () => rejectAgentEdits(view))
    dom.append(label, accept, reject)
  }
  render()
  return {
    dom,
    top: true,
    update: (update) => {
      if (update.startState.field(reviewField) !== update.state.field(reviewField)) render()
    }
  }
}

const reviewPanelFacet = showPanel.compute([reviewField], (state) =>
  state.field(reviewField).length > 0 ? reviewPanel : null
)

export function agentReviewExtension(): Extension {
  return [reviewField, reviewDecorations, reviewPanelFacet]
}

/** 应用 Agent 的修改（同一次调用算一次审阅、一步撤销） */
export function applyAgentChanges(view: EditorView, changes: ChangeSpec, label: string): void {
  const before: Text = view.state.doc
  const set = view.state.changes(changes)
  if (set.empty) return
  const inserted: Review['inserted'] = []
  const removed: Review['removed'] = []
  set.iterChanges((fromA, toA, fromB, toB) => {
    if (toB > fromB) inserted.push({ from: fromB, to: toB })
    if (toA > fromA) removed.push({ at: fromB, text: before.sliceString(fromA, toA) })
  })
  const review: Review = { id: nextId++, label, inverse: set.invert(before), inserted, removed }
  view.dispatch({
    changes: set,
    effects: addReview.of(review),
    annotations: agentEdit.of(true),
    userEvent: 'input.agent',
    scrollIntoView: true
  })
}

export function pendingAgentReviews(view: EditorView): number {
  return view.state.field(reviewField, false)?.length ?? 0
}

export function acceptAgentEdits(view: EditorView): void {
  const reviews = view.state.field(reviewField, false) ?? []
  if (reviews.length === 0) return
  view.dispatch({ effects: reviews.map((review) => resolveReview.of(review.id)) })
}

/** 撤销所有待确认的 Agent 修改（从最后一次往前回退） */
export function rejectAgentEdits(view: EditorView): void {
  const reviews = [...(view.state.field(reviewField, false) ?? [])]
  if (reviews.length === 0) return
  for (const review of reviews.reverse()) {
    const current = view.state.field(reviewField).find((item) => item.id === review.id)
    if (!current) continue
    view.dispatch({
      changes: current.inverse,
      effects: resolveReview.of(current.id),
      annotations: agentEdit.of(true),
      userEvent: 'input.agent-revert'
    })
  }
}
