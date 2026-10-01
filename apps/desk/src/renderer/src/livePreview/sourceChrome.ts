import { foldEffect, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language'
import { EditorState, RangeSet, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  EditorView,
  GutterMarker,
  gutter,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'

import { headingSections } from './headingFold'
import { listItemFoldRange } from './listFold'

const CHEVRON =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>'

/** 这一行（标题或列表项）是否已经折起。折叠从行末尾开始，所以要看到刚好落在行尾的范围。 */
function foldedAtLine(state: EditorState, lineTo: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  foldedRanges(state).between(lineTo, lineTo + 1, (from, to) => {
    if (from === lineTo) found = { from, to }
  })
  return found
}

type HeadingSectionList = ReturnType<typeof headingSections>

/** 这一行可折叠的范围：标题小节，或者列表项的子内容。 */
function foldableAtLine(
  state: EditorState,
  line: { from: number; to: number },
  sections: HeadingSectionList
): { from: number; to: number } | null {
  const section = sections.find((item) => item.lineEnd === line.to)
  if (section && section.end > section.lineEnd) return { from: section.lineEnd, to: section.end }
  return listItemFoldRange(state, line.from)
}

class SourceFoldMarker extends GutterMarker {
  constructor(readonly open: boolean) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof SourceFoldMarker && other.open === this.open
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = this.open ? 'cm-lp-source-fold is-open' : 'cm-lp-source-fold'
    span.title = this.open ? '折叠' : '展开'
    span.setAttribute('aria-label', span.title)
    span.setAttribute('aria-expanded', this.open ? 'true' : 'false')
    span.innerHTML = CHEVRON
    return span
  }
}

const canFold = new SourceFoldMarker(true)
const canUnfold = new SourceFoldMarker(false)

function foldMarkers(view: EditorView): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>()
  const sections = headingSections(view.state)
  for (const block of view.viewportLineBlocks) {
    const line = view.state.doc.lineAt(block.from)
    if (line.from !== block.from) continue
    if (foldedAtLine(view.state, line.to)) {
      builder.add(block.from, block.from, canUnfold)
      continue
    }
    if (foldableAtLine(view.state, line, sections)) builder.add(block.from, block.from, canFold)
  }
  return builder.finish()
}

const sourceFoldMarkers = ViewPlugin.fromClass(
  class {
    markers: RangeSet<GutterMarker>

    constructor(view: EditorView) {
      this.markers = foldMarkers(view)
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        foldedRanges(update.startState) !== foldedRanges(update.state) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.markers = foldMarkers(update.view)
      }
    }
  }
)

/** 源码模式左侧：文档行号，以及标题、列表项上始终可见的折叠箭头。 */
export function sourceChrome(): Extension {
  return [
    lineNumbers(),
    sourceFoldMarkers,
    gutter({
      class: 'cm-lp-source-folds',
      markers: (view) => view.plugin(sourceFoldMarkers)?.markers ?? RangeSet.empty,
      initialSpacer: () => canFold,
      domEventHandlers: {
        click(view, block) {
          const line = view.state.doc.lineAt(block.from)
          const folded = foldedAtLine(view.state, line.to)
          if (folded) {
            view.dispatch({ effects: unfoldEffect.of(folded) })
            return true
          }
          const range = foldableAtLine(view.state, line, headingSections(view.state))
          if (!range) return false
          view.dispatch({ effects: foldEffect.of(range) })
          return true
        }
      }
    })
  ]
}
