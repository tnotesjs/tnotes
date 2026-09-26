import { foldEffect, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language'
import { EditorState, RangeSet, RangeSetBuilder, type Extension } from '@codemirror/state'
import { EditorView, GutterMarker, gutter, lineNumbers, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { headingSections } from './headingFold'

const CHEVRON =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>'

/** 这一行标题是否已经折起。折叠从标题行末尾开始，所以要看到刚好落在行尾的范围。 */
function foldedHeading(state: EditorState, lineTo: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  foldedRanges(state).between(lineTo, lineTo + 1, (from, to) => {
    if (from === lineTo) found = { from, to }
  })
  return found
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
    const section = sections.find((item) => item.lineEnd === line.to)
    if (!section || section.end <= section.lineEnd) continue
    builder.add(block.from, block.from, foldedHeading(view.state, line.to) ? canUnfold : canFold)
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

/** 源码模式左侧：文档行号，以及标题上始终可见的折叠箭头。 */
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
          const folded = foldedHeading(view.state, line.to)
          if (folded) {
            view.dispatch({ effects: unfoldEffect.of(folded) })
            return true
          }
          const section = headingSections(view.state).find((item) => item.lineEnd === line.to)
          if (!section || section.end <= section.lineEnd) return false
          view.dispatch({ effects: foldEffect.of({ from: section.lineEnd, to: section.end }) })
          return true
        }
      }
    })
  ]
}
