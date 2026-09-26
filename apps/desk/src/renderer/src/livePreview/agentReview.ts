import {
  Annotation,
  ChangeSet,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  type ChangeDesc,
  type ChangeSpec,
  type Extension,
  type Range,
  type Text,
  type TransactionSpec
} from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, showPanel, type DecorationSet, type Panel, type ViewUpdate } from '@codemirror/view'
import { allLiveEditors, liveEditorsFor } from './editorRegistry'

/**
 * Agent 改动审阅：Agent 的修改直接进文档并保存，改动处高亮，
 * 编辑器顶部出现「保留 / 撤销」条。撤销只回退 Agent 那一次的修改 ——
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

export interface StoredReview {
  label: string
  inverse: ReturnType<ChangeSet['toJSON']>
  inserted: Array<{ from: number; to: number }>
  removed: Array<{ at: number; text: string }>
}

export interface ReviewNote {
  knowledgeBaseId: string
  noteUuid: string
}

export interface ReviewMeta {
  title: string
  index: string
  knowledgeBaseName: string
}

interface ReviewArchive {
  content: string
  reviews: StoredReview[]
  stale: boolean
}

const agentEdit = Annotation.define<boolean>()
const addReview = StateEffect.define<Review>()
const restoreReviews = StateEffect.define<Review[]>()
const resolveReview = StateEffect.define<number>()

/** 编辑器属于哪篇笔记。关掉标签后，审阅标记按这个身份暂存。 */
export const agentReviewNote = Facet.define<ReviewNote, ReviewNote | null>({
  combine: (values) => values[0] ?? null
})

const archives = new Map<string, ReviewArchive>()
const metas = new Map<string, ReviewMeta>()
let nextId = 1

function noteKey(knowledgeBaseId: string, noteUuid: string): string {
  return `${knowledgeBaseId}:${noteUuid}`
}

function splitKey(key: string): ReviewNote {
  const split = key.indexOf(':')
  return { knowledgeBaseId: key.slice(0, split), noteUuid: key.slice(split + 1) }
}

/** 用户的改动整段盖住了 Agent 新增的文字，或者撤销/重做碰到了它：这条审阅作废。 */
function overridden(review: Review, changes: ChangeDesc, undoRedo: boolean): boolean {
  let covered = false
  changes.iterChangedRanges((fromA, toA) => {
    if (toA <= fromA) return
    if (review.inserted.some((range) => fromA <= range.from && toA >= range.to)) covered = true
  })
  if (covered) return true
  if (!undoRedo) return false
  return (
    review.inserted.some((range) => changes.touchesRange(range.from, range.to) !== false) ||
    review.removed.some((item) => changes.touchesRange(item.at, item.at) !== false)
  )
}

const reviewField = StateField.define<Review[]>({
  create: () => [],
  update(reviews, tr) {
    let next = reviews
    if (tr.docChanged && reviews.length > 0) {
      const byAgent = Boolean(tr.annotation(agentEdit))
      const undoRedo = tr.isUserEvent('undo') || tr.isUserEvent('redo')
      next = reviews
        .filter((review) => byAgent || !overridden(review, tr.changes, undoRedo))
        .map((review) => ({
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
      if (effect.is(restoreReviews)) next = [...next, ...effect.value]
      if (effect.is(resolveReview)) next = next.filter((review) => review.id !== effect.value)
    }
    return next
  }
})

function serialize(reviews: readonly Review[]): StoredReview[] {
  return reviews.map((review) => ({
    label: review.label,
    inverse: review.inverse.toJSON(),
    inserted: review.inserted.map((range) => ({ from: range.from, to: range.to })),
    removed: review.removed.map((item) => ({ at: item.at, text: item.text }))
  }))
}

function materialize(stored: readonly StoredReview[]): Review[] {
  return stored.map((review) => ({
    id: nextId++,
    label: review.label,
    inverse: ChangeSet.fromJSON(review.inverse),
    inserted: review.inserted.map((range) => ({ from: range.from, to: range.to })),
    removed: review.removed.map((item) => ({ at: item.at, text: item.text }))
  }))
}

export function setReviewMeta(knowledgeBaseId: string, noteUuid: string, meta: ReviewMeta): void {
  metas.set(noteKey(knowledgeBaseId, noteUuid), meta)
}

export function reviewMeta(knowledgeBaseId: string, noteUuid: string): ReviewMeta | null {
  return metas.get(noteKey(knowledgeBaseId, noteUuid)) ?? null
}

/** 把这份状态里的标记按笔记存起来（编辑器销毁、后台改动时用）。 */
export function archiveState(note: ReviewNote, state: EditorState): void {
  const key = noteKey(note.knowledgeBaseId, note.noteUuid)
  const reviews = state.field(reviewField, false) ?? []
  if (reviews.length === 0) {
    if (archives.get(key)?.stale === false) archives.delete(key)
    notifyReviews()
    return
  }
  archives.set(key, { content: state.doc.toString(), stale: false, reviews: serialize(reviews) })
  notifyReviews()
}

/** 编辑器销毁时调用：还有标记就把它们按全文存起来。 */
export function archiveReviews(state: EditorState): void {
  const note = state.facet(agentReviewNote)
  if (!note) return
  if ((state.field(reviewField, false) ?? []).length === 0) return
  archiveState(note, state)
}

/**
 * 全文一致就把标记交出来（调用方负责装回编辑器）。
 * 全文变了就丢掉标记，并记成失效，面板上会提示。
 */
export function takeArchivedReviews(state: EditorState): Review[] | 'stale' | 'none' {
  const note = state.facet(agentReviewNote)
  if (!note) return 'none'
  const key = noteKey(note.knowledgeBaseId, note.noteUuid)
  const archive = archives.get(key)
  if (!archive || archive.stale || archive.reviews.length === 0) return 'none'
  if ((state.field(reviewField, false) ?? []).length > 0) {
    archives.delete(key)
    return 'none'
  }
  if (archive.content !== state.doc.toString()) {
    archives.set(key, { content: archive.content, reviews: [], stale: true })
    notifyReviews()
    return 'stale'
  }
  archives.delete(key)
  return materialize(archive.reviews)
}

export function adoptArchivedReviews(view: EditorView): void {
  const taken = takeArchivedReviews(view.state)
  if (!Array.isArray(taken) || taken.length === 0) return
  view.dispatch({ effects: restoreReviews.of(taken) })
}

export function applyArchivedReviews(state: EditorState): EditorState {
  const taken = takeArchivedReviews(state)
  if (!Array.isArray(taken) || taken.length === 0) return state
  return state.update({ effects: restoreReviews.of(taken) }).state
}

export interface ArchivedEntry extends ReviewNote {
  content: string
  reviews: StoredReview[]
}

export function archivedEntries(): ArchivedEntry[] {
  const entries: ArchivedEntry[] = []
  for (const [key, archive] of archives) {
    if (archive.stale || archive.reviews.length === 0) continue
    entries.push({ ...splitKey(key), content: archive.content, reviews: archive.reviews })
  }
  return entries
}

export function archivedEntry(knowledgeBaseId: string, noteUuid: string): ArchivedEntry | null {
  const archive = archives.get(noteKey(knowledgeBaseId, noteUuid))
  if (!archive || archive.stale || archive.reviews.length === 0) return null
  return { knowledgeBaseId, noteUuid, content: archive.content, reviews: archive.reviews }
}

export function dropArchive(knowledgeBaseId: string, noteUuid: string): void {
  if (!archives.delete(noteKey(knowledgeBaseId, noteUuid))) return
  notifyReviews()
}

export function markArchiveStale(knowledgeBaseId: string, noteUuid: string): void {
  const key = noteKey(knowledgeBaseId, noteUuid)
  const archive = archives.get(key)
  archives.set(key, { content: archive?.content ?? '', reviews: [], stale: true })
  notifyReviews()
}

export function staleReviewNotes(): ReviewNote[] {
  const notes: ReviewNote[] = []
  for (const [key, archive] of archives) {
    if (archive.stale) notes.push(splitKey(key))
  }
  return notes
}

export function dismissStaleReview(knowledgeBaseId: string, noteUuid: string): void {
  const archive = archives.get(noteKey(knowledgeBaseId, noteUuid))
  if (!archive?.stale) return
  archives.delete(noteKey(knowledgeBaseId, noteUuid))
  notifyReviews()
}

export function resetReviewArchivesForTests(): void {
  archives.clear()
  metas.clear()
}

function headlessState(note: ReviewNote, content: string): EditorState {
  return EditorState.create({ doc: content, extensions: [reviewField, agentReviewNote.of(note)] })
}

/**
 * 没有打开编辑器的笔记（包括其他知识库的）：在一份临时状态上应用 Agent 修改，
 * 把标记存进存档，返回修改后的全文。已有的标记全文对得上就一起保留。
 */
export function applyAgentEditToContent(note: ReviewNote, content: string, changes: ChangeSpec, label: string): string {
  const state = applyAgentChangeToState(applyArchivedReviews(headlessState(note, content)), changes, label)
  archiveState(note, state)
  return state.doc.toString()
}

/** 保存后全文被整理过（例如生成的标题）：把存档里的位置映射到新全文上。 */
export function syncArchiveContent(knowledgeBaseId: string, noteUuid: string, content: string): void {
  const entry = archivedEntry(knowledgeBaseId, noteUuid)
  if (!entry || entry.content === content) return
  const note = { knowledgeBaseId, noteUuid }
  let state = headlessState(note, entry.content)
  state = state.update({ effects: restoreReviews.of(materialize(entry.reviews)) }).state
  state = state.update({ changes: minimalChange(entry.content, content) }).state
  archiveState(note, state)
}

function minimalChange(current: string, next: string): { from: number; to: number; insert: string } {
  let start = 0
  const limit = Math.min(current.length, next.length)
  while (start < limit && current.charCodeAt(start) === next.charCodeAt(start)) start += 1
  let endCurrent = current.length
  let endNext = next.length
  while (endCurrent > start && endNext > start && current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)) {
    endCurrent -= 1
    endNext -= 1
  }
  return { from: start, to: endCurrent, insert: next.slice(start, endNext) }
}

function rejectAllInState(state: EditorState): EditorState {
  let next = state
  for (const review of [...next.field(reviewField)].reverse()) {
    const current = next.field(reviewField).find((item) => item.id === review.id)
    if (!current) continue
    next = next.update({
      changes: current.inverse,
      effects: resolveReview.of(current.id),
      annotations: agentEdit.of(true)
    }).state
  }
  return next
}

/** 从后往前撤掉存档里的所有改动，返回还原后的全文。 */
export function revertArchived(content: string, stored: readonly StoredReview[]): string {
  const state = EditorState.create({ doc: content, extensions: [reviewField] }).update({
    effects: restoreReviews.of(materialize(stored))
  }).state
  return rejectAllInState(state).doc.toString()
}

function countLines(text: string): number {
  return text.split('\n').filter((line) => line.length > 0).length
}

/** 待审阅改动的新增、删除行数（只算非空行）。 */
export function reviewLineCounts(doc: string, reviews: ReadonlyArray<Pick<StoredReview, 'inserted' | 'removed'>>): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const review of reviews) {
    for (const range of review.inserted) added += countLines(doc.slice(range.from, range.to))
    for (const item of review.removed) removed += countLines(item.text)
  }
  return { added, removed }
}

export function reviewsOf(state: EditorState): StoredReview[] {
  return serialize(state.field(reviewField, false) ?? [])
}

export interface AgentReviewActions {
  accept: (knowledgeBaseId: string, noteUuid: string) => void
  reject: (knowledgeBaseId: string, noteUuid: string) => void
}

let reviewActions: AgentReviewActions | null = null

export function setAgentReviewActions(actions: AgentReviewActions | null): void {
  reviewActions = actions
}

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
    const counts = reviewLineCounts(view.state.doc.toString(), reviews)
    label.textContent = `${reviews.length === 1 ? `Agent：${reviews[0].label}` : `Agent 有 ${reviews.length} 处修改`} · +${counts.added} −${counts.removed}`
    const reject = document.createElement('button')
    reject.type = 'button'
    reject.textContent = '撤销'
    reject.addEventListener('click', () => {
      const note = view.state.facet(agentReviewNote)
      if (note && reviewActions) reviewActions.reject(note.knowledgeBaseId, note.noteUuid)
      else rejectAgentEdits(view)
    })
    const accept = document.createElement('button')
    accept.type = 'button'
    accept.className = 'is-primary'
    accept.textContent = '保留'
    accept.addEventListener('click', () => {
      const note = view.state.facet(agentReviewNote)
      if (note && reviewActions) reviewActions.accept(note.knowledgeBaseId, note.noteUuid)
      else acceptAgentEdits(view)
    })
    dom.append(reject, accept, label)
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

const reviewListeners = new Set<() => void>()

export function onAgentReviewsChanged(listener: () => void): () => void {
  reviewListeners.add(listener)
  return () => reviewListeners.delete(listener)
}

function notifyReviews(): void {
  for (const listener of reviewListeners) listener()
}

const reviewNotifier = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (update.startState.field(reviewField) !== update.state.field(reviewField)) notifyReviews()
    }

    destroy(): void {
      archiveReviews(this.view.state)
      const note = this.view.state.facet(agentReviewNote)
      if (!note) return
      for (const other of liveEditorsFor(note.knowledgeBaseId, note.noteUuid)) {
        if (other === this.view) continue
        adoptArchivedReviews(other)
      }
      notifyReviews()
    }
  }
)

export function agentReviewExtension(): Extension {
  return [reviewField, reviewDecorations, reviewPanelFacet, reviewNotifier]
}

export function applyAgentChangeToState(state: EditorState, changes: ChangeSpec, label: string): EditorState {
  const spec = agentChangeSpec(state, changes, label)
  return spec ? state.update(spec).state : state
}

function agentChangeSpec(state: EditorState, changes: ChangeSpec, label: string): TransactionSpec | null {
  const before: Text = state.doc
  const set = state.changes(changes)
  if (set.empty) return null
  const inserted: Review['inserted'] = []
  const removed: Review['removed'] = []
  set.iterChanges((fromA, toA, fromB, toB) => {
    if (toB > fromB) inserted.push({ from: fromB, to: toB })
    if (toA > fromA) removed.push({ at: fromB, text: before.sliceString(fromA, toA) })
  })
  const review: Review = { id: nextId++, label, inverse: set.invert(before), inserted, removed }
  return {
    changes: set,
    effects: addReview.of(review),
    annotations: agentEdit.of(true),
    userEvent: 'input.agent',
    scrollIntoView: true
  }
}

/** 应用 Agent 的修改（同一次调用算一次审阅、一步撤销） */
export function applyAgentChanges(view: EditorView, changes: ChangeSpec, label: string): void {
  const spec = agentChangeSpec(view.state, changes, label)
  if (spec) view.dispatch(spec)
}

export function pendingReviewsIn(state: EditorState): number {
  return state.field(reviewField, false)?.length ?? 0
}

export function pendingAgentReviews(view: EditorView): number {
  return pendingReviewsIn(view.state)
}

/** 同一篇笔记可能在分屏里开了多份：返回真正带标记的那一个。 */
export function reviewViewFor(knowledgeBaseId: string, noteUuid: string): EditorView | null {
  return liveEditorsFor(knowledgeBaseId, noteUuid).find((view) => pendingAgentReviews(view) > 0) ?? null
}

export interface LiveReviewEntry extends ReviewNote {
  view: EditorView
}

export function liveReviewEntries(): LiveReviewEntry[] {
  const entries: LiveReviewEntry[] = []
  for (const item of allLiveEditors()) {
    const view = item.views.find((candidate) => pendingAgentReviews(candidate) > 0)
    if (view) entries.push({ knowledgeBaseId: item.knowledgeBaseId, noteUuid: item.noteUuid, view })
  }
  return entries
}

/** 光标移到第一处改动并滚到可见位置。 */
export function revealFirstReview(view: EditorView): void {
  const first = view.state.field(reviewField, false)?.[0]
  if (!first) return
  const at = first.inserted[0]?.from ?? first.removed[0]?.at ?? 0
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
  view.focus()
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
