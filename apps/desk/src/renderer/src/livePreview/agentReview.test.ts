import { history, undo } from '@codemirror/commands'
import { EditorState, type Transaction } from '@codemirror/state'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  agentReviewExtension,
  agentReviewNote,
  applyAgentChangeToState,
  applyAgentEditToContent,
  applyArchivedReviews,
  archiveReviews,
  archivedEntries,
  archivedEntry,
  pendingReviewsIn,
  resetReviewArchivesForTests,
  reviewLineCounts,
  reviewsOf,
  revertArchived,
  staleReviewNotes
} from './agentReview'

const identity = { knowledgeBaseId: 'kb', noteUuid: 'n1' }
const note = agentReviewNote.of(identity)

function edited(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [agentReviewExtension(), note] })
  return applyAgentChangeToState(state, { from: doc.length, insert: '新增' }, '修改')
}

function reopen(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [agentReviewExtension(), note] })
}

function runUndo(state: EditorState): EditorState {
  let next = state
  undo({ state, dispatch: (tr: Transaction) => (next = tr.state) })
  return next
}

beforeEach(() => {
  resetReviewArchivesForTests()
})

describe('review archive', () => {
  it('restores marks when the note is opened with the same text', () => {
    const source = edited('原文')
    archiveReviews(source)
    expect(archivedEntries().map((entry) => entry.noteUuid)).toEqual(['n1'])
    const restored = applyArchivedReviews(reopen(source.doc.toString()))
    expect(pendingReviewsIn(restored)).toBe(1)
    expect(restored.doc.toString()).toBe('原文新增')
    expect(archivedEntries()).toEqual([])
  })

  it('discards the archive when the text has changed', () => {
    const source = edited('原文')
    archiveReviews(source)
    const discarded = applyArchivedReviews(reopen('不一样'))
    expect(pendingReviewsIn(discarded)).toBe(0)
    expect(discarded.doc.toString()).toBe('不一样')
    expect(staleReviewNotes()).toEqual([identity])
    expect(pendingReviewsIn(applyArchivedReviews(reopen(source.doc.toString())))).toBe(0)
  })

  it('edits a note without an editor and restores the marks when it opens', () => {
    const content = applyAgentEditToContent(identity, '前 A 后', { from: 2, to: 3, insert: 'B' }, '修改')
    expect(content).toBe('前 B 后')
    expect(archivedEntry('kb', 'n1')?.content).toBe('前 B 后')
    const opened = applyArchivedReviews(reopen(content))
    expect(pendingReviewsIn(opened)).toBe(1)
  })

  it('reverts several archived edits from last to first', () => {
    const first = applyAgentEditToContent(identity, '一\n二\n', { from: 0, to: 1, insert: '甲' }, '修改')
    const second = applyAgentEditToContent(identity, first, { from: first.length, insert: '三\n' }, '修改')
    expect(second).toBe('甲\n二\n三\n')
    const entry = archivedEntry('kb', 'n1')
    expect(entry?.reviews).toHaveLength(2)
    expect(revertArchived(entry!.content, entry!.reviews)).toBe('一\n二\n')
    expect(reviewLineCounts(entry!.content, entry!.reviews)).toEqual({ added: 2, removed: 1 })
  })
})

describe('user edits over agent edits', () => {
  it('drops the review when the agent edit is undone, so reject cannot duplicate text', () => {
    let state = EditorState.create({ doc: '前 A 后', extensions: [history(), agentReviewExtension()] })
    state = applyAgentChangeToState(state, { from: 2, to: 3, insert: 'B' }, '修改')
    state = runUndo(state)
    expect(state.doc.toString()).toBe('前 A 后')
    expect(pendingReviewsIn(state)).toBe(0)
  })

  it('drops the review when the user rewrites the whole inserted text', () => {
    let state = EditorState.create({ doc: '前 A 后', extensions: [agentReviewExtension()] })
    state = applyAgentChangeToState(state, { from: 2, to: 3, insert: 'BBB' }, '修改')
    state = state.update({ changes: { from: 2, to: 5, insert: 'C' } }).state
    expect(pendingReviewsIn(state)).toBe(0)
  })

  it('keeps the review when the user only types inside the inserted text', () => {
    let state = EditorState.create({ doc: '前 A 后', extensions: [agentReviewExtension()] })
    state = applyAgentChangeToState(state, { from: 2, to: 3, insert: 'BBB' }, '修改')
    state = state.update({ changes: { from: 3, insert: 'x' } }).state
    expect(pendingReviewsIn(state)).toBe(1)
    expect(revertArchived(state.doc.toString(), reviewsOf(state))).toBe('前 Ax 后')
  })
})
