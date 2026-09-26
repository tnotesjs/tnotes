import { Annotation, EditorState, type ChangeSpec, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/**
 * 把会话里的内容同步进编辑器（磁盘重载等）。会话才是真相源：
 * 这类修改原样放行，编辑器也不再回抛 change。
 */
export const externalSync = Annotation.define<boolean>()

/**
 * 保护 frontmatter 里的 `id` 行，以及包住它的 `---`。
 * 可视化、源码、Agent 替换都走同一套事务，所以只拦这一处。
 * 全选删除会清掉正文，留下：
 * ---
 * id: …
 * ---
 */
export function frontmatterGuardRanges(doc: { line: (n: number) => { from: number; to: number; text: string }; lines: number; length: number }): number[] | null {
  const first = doc.line(1)
  if (first.text.trimEnd() !== '---') return null
  const openTo = first.to < doc.length ? first.to + 1 : first.to
  let idFrom = -1
  let idTo = -1
  let closeFrom = -1
  let closeTo = -1
  for (let number = 2; number <= doc.lines; number += 1) {
    const line = doc.line(number)
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line.text)) {
      closeFrom = line.from
      closeTo = line.to < doc.length ? line.to + 1 : line.to
      break
    }
    if (idFrom < 0 && /^id\s*:/.test(line.text)) {
      idFrom = line.from
      idTo = line.to < doc.length ? line.to + 1 : line.to
    }
  }
  if (idFrom < 0 || closeFrom < 0) return null
  return [first.from, openTo, idFrom, idTo, closeFrom, closeTo]
}

function unprotectedGaps(from: number, to: number, ranges: number[]): Array<{ from: number; to: number }> {
  let cursor = from
  const gaps: Array<{ from: number; to: number }> = []
  for (let index = 0; index < ranges.length; index += 2) {
    const start = ranges[index]
    const end = ranges[index + 1]
    if (end <= cursor || start >= to) continue
    if (start > cursor) gaps.push({ from: cursor, to: Math.min(start, to) })
    cursor = Math.max(cursor, end)
    if (cursor >= to) return gaps
  }
  if (cursor < to) gaps.push({ from: cursor, to })
  return gaps
}

function guardsBoundary(pos: number, ranges: number[]): boolean {
  for (let index = 0; index < ranges.length; index += 2) {
    if (pos === ranges[index]) return true
  }
  return false
}

const lockedLine = Decoration.line({ class: 'cm-lp-locked' })

function lockedDecorations(state: EditorState): DecorationSet {
  const ranges = frontmatterGuardRanges(state.doc)
  if (!ranges) return Decoration.none
  const idFrom = ranges[2]
  const line = state.doc.lineAt(idFrom)
  return Decoration.set([lockedLine.range(line.from)])
}

function pointInside(pos: number, ranges: number[]): boolean {
  for (let index = 0; index < ranges.length; index += 2) {
    if (pos > ranges[index] && pos < ranges[index + 1]) return true
  }
  return false
}

export function frontmatterIdGuard(): Extension {
  return [
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || tr.annotation(externalSync)) return tr
      const ranges = frontmatterGuardRanges(tr.startState.doc)
      if (!ranges) return tr
      const changes: ChangeSpec[] = []
      let rewritten = false
      tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        if (from === to && guardsBoundary(from, ranges)) {
          rewritten = true
          return
        }
        const gaps = unprotectedGaps(from, to, ranges)
        const text = inserted.toString()
        // 光标处打字是 from === to。落在受保护区间外时，上面的空隙计算会得到空数组，
        // 不能据此把这次插入丢掉。
        if (from === to && gaps.length === 0) {
          if (pointInside(from, ranges)) {
            rewritten = true
            return
          }
          changes.push({ from, to, insert: text })
          return
        }
        if (gaps.length === 1 && gaps[0].from === from && gaps[0].to === to) {
          changes.push({ from, to, insert: text })
          return
        }
        rewritten = true
        let placed = false
        for (const gap of gaps) {
          changes.push({ from: gap.from, to: gap.to, insert: placed ? '' : text })
          placed = true
        }
      })
      if (!rewritten) return tr
      return tr.startState.update({ changes, filter: false })
    }),
    EditorView.decorations.compute([], lockedDecorations)
  ]
}
