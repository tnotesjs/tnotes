import { syntaxTree } from '@codemirror/language'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import {
  EditorSelection,
  EditorState as EditorStateValue,
  Facet,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
  type Range,
  type TransactionSpec
} from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'

import { writeClipboardText } from '../clipboardText'
import { applyFenceLanguage, applyFenceTitle, parseFenceTitleFromMeta } from '../editor/markdown/fenceInfo'
import { matchDeskLanguage } from '../editor/markdown/codeMirrorLanguages'
import { CHEVRON_DOWN_ICON, COLLAPSE_ICON, COPY_ICON, EXPAND_ICON } from '../markdown/copyIcons'
import {
  codeBlockChrome,
  codeChromeAt,
  clampRangeAroundCollapsed,
  toggleCodeCollapse,
  toggleCodeFullscreen,
  toggleCodeWrap
} from './codeBlockChrome'
import { codeLineDecorations } from './codeLines'
import { CardWidget, isKnownComponent, setCodeGroupTab, type CardKind } from './cards'
import { headingFoldKey, headingSections, HeadingFoldToggle, isHeadingFolded } from './headingFold'
import { livePreviewEnabled } from './host'
import { readImage } from './images'
import {
  BulletWidget,
  CheckboxWidget,
  CodeFenceHeaderWidget,
  EmptyWidget,
  HorizontalRuleWidget,
  codeWrapButton,
  flashCopied,
  iconButton,
  ImageWidget,
  MathWidget
} from './widgets'

import type { Parser, SyntaxNode } from '@lezer/common'

/** 被块级组件替换掉的源码范围（整行），键盘上下移动时据此「走进」卡片。 */
export interface HiddenBlock {
  from: number
  to: number
}

interface LivePreviewState {
  decorations: DecorationSet
  blocks: HiddenBlock[]
}

const hidden = Decoration.replace({})

const bumpCodeHighlight = StateEffect.define<null>()
const codeHighlightEpoch = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    return tr.effects.some((effect) => effect.is(bumpCodeHighlight)) ? value + 1 : value
  }
})

const codeParsers = new Map<string, Parser | null>()
const codeParsersLoading = new Set<string>()
const codeHighlightViews = new Set<EditorView>()

function codeParserFor(lang: string): Parser | null {
  const key = lang.trim().toLowerCase()
  if (!key) return null
  if (codeParsers.has(key)) return codeParsers.get(key) ?? null
  const desc = matchDeskLanguage(key)
  if (!desc) {
    codeParsers.set(key, null)
    return null
  }
  const ready = desc.support?.language.parser
  if (ready) {
    codeParsers.set(key, ready)
    return ready
  }
  if (!codeParsersLoading.has(key)) {
    codeParsersLoading.add(key)
    void desc.load()
      .then((support) => {
        codeParsers.set(key, support.language.parser)
        for (const view of codeHighlightViews) view.dispatch({ effects: bumpCodeHighlight.of(null) })
      })
      .catch(() => {
        codeParsers.set(key, null)
      })
      .finally(() => {
        codeParsersLoading.delete(key)
      })
  }
  return null
}

function highlightCode(
  ranges: Range<Decoration>[],
  from: number,
  to: number,
  lang: string,
  source: string
): void {
  const parser = codeParserFor(lang)
  if (!parser || to <= from) return
  const tree = parser.parse(source)
  highlightTree(tree, classHighlighter, (start, end, classes) => {
    if (end <= start) return
    const markFrom = from + start
    const markTo = from + end
    if (markFrom >= from && markTo <= to) {
      ranges.push(Decoration.mark({ class: classes }).range(markFrom, markTo))
    }
  })
}

const codeHighlightLoader = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      codeHighlightViews.add(view)
    }

    destroy(): void {
      codeHighlightViews.delete(this.view)
    }
  }
)

/** 编辑器是否有焦点：没有焦点时不露出任何源码（点到别处时文档是干净的渲染结果） */
export const setFocused = StateEffect.define<boolean>()
/** 鼠标拖选进行中：冻结露出范围，避免拖选经过的元素反复露出/隐藏导致排版跳动 */
const setPointerSelecting = StateEffect.define<boolean>()

interface InteractionState {
  focused: boolean
  pointerSelecting: boolean
}

const interactionField = StateField.define<InteractionState>({
  create: () => ({ focused: false, pointerSelecting: false }),
  update(value, tr) {
    let next = value
    for (const effect of tr.effects) {
      if (effect.is(setFocused)) next = { ...next, focused: effect.value }
      if (effect.is(setPointerSelecting)) next = { ...next, pointerSelecting: effect.value }
    }
    return next
  }
})

const pointerTracker = ViewPlugin.fromClass(
  class {
    private readonly onUp: () => void
    constructor(private readonly view: EditorView) {
      this.onUp = () => {
        window.removeEventListener('mouseup', this.onUp, true)
        if (this.view.state.field(interactionField).pointerSelecting) {
          this.view.dispatch({ effects: setPointerSelecting.of(false) })
        }
      }
    }

    start(): void {
      window.addEventListener('mouseup', this.onUp, true)
      this.view.dispatch({ effects: setPointerSelecting.of(true) })
    }

    destroy(): void {
      window.removeEventListener('mouseup', this.onUp, true)
    }
  },
  {
    eventHandlers: {
      mousedown(event) {
        if (event.button !== 0 || event.detail > 1) return
        // 按在正文文字上才冻结；点组件（图片、卡片）由组件自己处理
        const target = event.target as HTMLElement | null
        if (target?.closest('.cm-lp-card, .cm-lp-image, .cm-lp-math, .cm-lp-frontmatter, button, input')) return
        this.start()
      }
    }
  }
)

class BreakWidget extends WidgetType {
  constructor(private readonly block: boolean) {
    super()
  }

  eq(other: BreakWidget): boolean {
    return other.block === this.block
  }

  toDOM(): HTMLElement {
    if (!this.block) return document.createElement('br')
    const spacer = document.createElement('div')
    spacer.className = 'cm-lp-break'
    return spacer
  }
}

const BREAK_TAG = /^<br\s*\/?>$/i

/** 卡片里的组件（如笔记表格）需要知道当前知识库。 */
export const cardKnowledgeBase = Facet.define<string, string>({
  combine: (values) => values[values.length - 1] ?? ''
})

/** 代码组当前显示的是第几个标签页（键：容器起点，随编辑映射）。 */
export const codeGroupTabs = StateField.define<Map<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value
    if (tr.docChanged && value.size > 0) {
      next = new Map()
      for (const [pos, index] of value) next.set(tr.changes.mapPos(pos), index)
    }
    for (const effect of tr.effects) {
      if (!effect.is(setCodeGroupTab)) continue
      if (next === value) next = new Map(value)
      next.set(effect.value.pos, effect.value.index)
    }
    return next
  }
})

interface FencePanel {
  from: number
  to: number
  label: string
}

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/

/** 代码组正文里的每个围栏代码块（按行扫描，与 containerBody 的取法一致）。 */
function codeGroupPanels(state: EditorState, bodyFrom: number, bodyTo: number): FencePanel[] {
  const doc = state.doc
  const panels: FencePanel[] = []
  let line = doc.lineAt(bodyFrom)
  let open: { from: number; marker: string; label: string } | null = null
  for (;;) {
    const match = FENCE_LINE.exec(line.text)
    if (open) {
      if (match && match[1][0] === open.marker[0] && match[1].length >= open.marker.length && !match[2].trim()) {
        panels.push({ from: open.from, to: line.to, label: open.label })
        open = null
      }
    } else if (match) {
      const info = match[2].trim()
      const lang = info.split(/\s+/)[0] ?? ''
      const title = parseFenceTitleFromMeta(info.slice(lang.length).trim()) || /\[([^\]]+)\]/.exec(info)?.[1] || ''
      open = { from: line.from, marker: match[1], label: title || lang || `代码 ${panels.length + 1}` }
    }
    if (line.to >= bodyTo || line.number >= doc.lines) break
    line = doc.line(line.number + 1)
  }
  if (open) panels.push({ from: open.from, to: doc.lineAt(bodyTo).to, label: open.label })
  return panels
}

/** 围栏开头那一行的语言记号，原样返回（可能带 `:line-numbers`）。 */
function fenceLang(opening: string): string {
  const info = opening.replace(/^[ \t]*(?:`{3,}|~{3,})/, '').trim()
  const token = info.split(/\s+/)[0] ?? ''
  return token.startsWith('[') || token.startsWith('{') ? '' : token
}

function fenceTitle(opening: string): string {
  const info = opening.replace(/^[ \t]*(?:`{3,}|~{3,})/, '').trim()
  const lang = fenceLang(opening)
  return parseFenceTitleFromMeta(info.slice(lang.length).trim()) || /\[([^\]]+)\]/.exec(info)?.[1] || ''
}

function codeGroupGaps(
  openLineTo: number,
  closeLineFrom: number,
  panels: FencePanel[]
): Array<{ from: number; to: number }> {
  const gaps: Array<{ from: number; to: number }> = []
  // 只藏中间的空行，两端的换行留着：块替换吞掉换行会把标签栏和下一行并成一行，行装饰随之丢失。
  const push = (from: number, to: number): void => {
    if (to - from > 1) gaps.push({ from: from + 1, to: to - 1 })
  }
  if (panels[0]) push(openLineTo, panels[0].from)
  for (let index = 0; index < panels.length - 1; index += 1) push(panels[index].to, panels[index + 1].from)
  const last = panels[panels.length - 1]
  if (last) push(last.to, closeLineFrom)
  return gaps
}

function groupAt(state: EditorState, pos: number): { openFrom: number; bodyFrom: number; bodyTo: number; containerTo: number } | null {
  let container: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  while (container && container.name !== 'Container') container = container.parent
  const body = container?.getChild('ContainerBody')
  if (!container || !body) return null
  return {
    openFrom: state.doc.lineAt(container.from).from,
    bodyFrom: body.from,
    bodyTo: body.to,
    containerTo: container.to
  }
}

function panelsNow(state: EditorState, pos: number): { openFrom: number; panels: FencePanel[] } | null {
  const group = groupAt(state, pos)
  if (!group) return null
  return { openFrom: group.openFrom, panels: codeGroupPanels(state, group.bodyFrom, group.bodyTo) }
}

function activatePanel(view: EditorView, openFrom: number, index: number): void {
  const located = panelsNow(view.state, openFrom)
  const panel = located?.panels[index]
  if (!located || !panel) return
  const openLine = view.state.doc.lineAt(panel.from)
  const panelCollapsed = codeChromeAt(view.state, openLine.from)?.collapsed === true
  const groupCollapsed = codeChromeAt(view.state, located.openFrom)?.collapsed === true
  const effects = [
    setCodeGroupTab.of({ pos: located.openFrom, index }),
    ...(panelCollapsed ? [toggleCodeCollapse.of(openLine.from)] : []),
    ...(groupCollapsed ? [toggleCodeCollapse.of(located.openFrom)] : [])
  ]
  const firstCodeLine = openLine.number + 1
  const target =
    firstCodeLine <= view.state.doc.lines ? view.state.doc.line(firstCodeLine).from : panel.from
  view.dispatch({
    effects,
    selection: { anchor: Math.min(target, panel.to) },
    userEvent: 'select.code-clamp'
  })
  view.focus()
}

function insertCodeGroupPanel(view: EditorView, openFrom: number): void {
  const located = panelsNow(view.state, openFrom)
  if (!located || located.panels.length === 0) return
  const last = located.panels[located.panels.length - 1]
  const fence = '\n```\n\n```'
  const index = located.panels.length
  view.dispatch({
    changes: { from: last.to, to: last.to, insert: fence },
    effects: setCodeGroupTab.of({ pos: openFrom, index }),
    selection: { anchor: last.to + '\n```\n'.length },
    userEvent: 'select.code-clamp'
  })
  view.focus()
}

function removeCodeGroupPanel(view: EditorView, openFrom: number, index: number): void {
  const located = panelsNow(view.state, openFrom)
  if (!located || located.panels.length <= 1) return
  const panel = located.panels[index]
  if (!panel) return
  const doc = view.state.doc
  let from = panel.from
  let to = panel.to
  if (index > 0 && doc.sliceString(from - 1, from) === '\n') from -= 1
  else if (located.panels[index + 1] && located.panels[index + 1].from > to) to = located.panels[index + 1].from
  const stay = index > 0 ? located.panels[index - 1] : located.panels[1]
  const codeLine = doc.lineAt(stay.from).number + 1
  let anchor = codeLine <= doc.lines ? doc.line(codeLine).from : stay.from
  if (anchor >= to) anchor -= to - from
  else if (anchor > from) anchor = from
  view.dispatch({
    changes: { from, to, insert: '' },
    effects: setCodeGroupTab.of({ pos: openFrom, index: index > 0 ? index - 1 : 0 }),
    selection: { anchor: Math.max(0, anchor) },
    userEvent: 'select.code-clamp'
  })
  view.focus()
}

function reorderCodeGroupPanel(view: EditorView, openFrom: number, fromIndex: number, toIndex: number): void {
  const located = panelsNow(view.state, openFrom)
  if (!located || fromIndex === toIndex) return
  const panels = located.panels
  if (!panels[fromIndex] || toIndex < 0 || toIndex >= panels.length) return
  const doc = view.state.doc
  const sources = panels.map((panel) => doc.sliceString(panel.from, panel.to))
  const moved = sources[fromIndex]
  sources.splice(fromIndex, 1)
  sources.splice(toIndex, 0, moved)
  const from = panels[0].from
  const to = panels[panels.length - 1].to
  let cursor = from
  for (let index = 0; index < toIndex; index += 1) cursor += sources[index].length + 1
  view.dispatch({
    changes: { from, to, insert: sources.join('\n') },
    effects: setCodeGroupTab.of({ pos: openFrom, index: toIndex }),
    selection: { anchor: Math.min(cursor, from + sources.join('\n').length) },
    userEvent: 'select.code-clamp'
  })
  view.focus()
}

function showCodeGroupMenu(
  x: number,
  y: number,
  items: Array<{ label: string; run: () => void; disabled?: boolean }>
): void {
  document.querySelector('.cm-lp-code-tab-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'cm-lp-code-tab-menu'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  for (const item of items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = item.label
    button.disabled = Boolean(item.disabled)
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      menu.remove()
      if (!item.disabled) item.run()
    })
    menu.append(button)
  }
  document.body.append(menu)
  const close = (event: MouseEvent): void => {
    if (menu.contains(event.target as Node)) return
    menu.remove()
    document.removeEventListener('mousedown', close, true)
  }
  document.addEventListener('mousedown', close, true)
}

/** 连按两下同一个标签就改名。第一下会切标签、重画标签栏，所以按下记录不能挂在元素上。 */
let lastTabPress: { openFrom: number; index: number; time: number } | null = null
/** 语言输入写回围栏后标签栏会重画，新画出来的输入框把焦点接回去。 */
let restoreGroupLang = false

/** 标签栏在文档里的**当前**位置（组件不因上方编辑重画，构造时记下的坐标会过期）。 */
function tabsOpenFrom(view: EditorView, dom: HTMLElement, fallback: number): number {
  try {
    return view.state.doc.lineAt(view.posAtDOM(dom)).from
  } catch {
    return fallback
  }
}

function tabButtons(bar: HTMLElement): HTMLButtonElement[] {
  return [...bar.querySelectorAll<HTMLButtonElement>('button.cm-lp-code-tab')]
}

function beginTabRename(view: EditorView, tab: HTMLElement, openFrom: number, index: number): void {
  const located = panelsNow(view.state, openFrom)
  const panel = located?.panels[index]
  if (!panel || view.state.readOnly) return
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'cm-lp-code-tab-rename'
  input.spellcheck = false
  input.value = fenceTitle(view.state.doc.lineAt(panel.from).text)
  input.placeholder = tab.textContent ?? ''
  input.size = Math.max(4, input.value.length + 1, input.placeholder.length)
  let done = false
  const finish = (commit: boolean): void => {
    if (done) return
    done = true
    const current = panelsNow(view.state, openFrom)?.panels[index]
    const line = current ? view.state.doc.lineAt(current.from) : null
    const next = line ? applyFenceTitle(line.text, input.value.trim()) : null
    if (input.isConnected) input.replaceWith(tab)
    if (commit && line && next !== null && next !== line.text) {
      view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: 'input.code-tab-rename' })
    }
    view.focus()
  }
  input.addEventListener('pointerdown', (event) => event.stopPropagation())
  input.addEventListener('input', () => {
    input.size = Math.max(4, input.value.length + 1, input.placeholder.length)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
  tab.replaceWith(input)
  input.focus()
  input.select()
}

/** 菜单里的「重命名」：先切到这个标签，等标签栏重画后再把新标签换成输入框。 */
function renameTabLater(view: EditorView, openFrom: number, index: number): void {
  activatePanel(view, openFrom, index)
  setTimeout(() => {
    for (const bar of view.contentDOM.querySelectorAll<HTMLElement>('.cm-lp-code-tabs')) {
      if (tabsOpenFrom(view, bar, -1) !== openFrom) continue
      const tab = tabButtons(bar)[index]
      if (tab) beginTabRename(view, tab, openFrom, index)
      return
    }
  }, 30)
}

class CodeGroupTabsWidget extends WidgetType {
  constructor(
    private readonly labels: string[],
    private readonly active: number,
    private readonly containerFrom: number,
    private readonly lang: string,
    private readonly collapsed: boolean,
    private readonly fullscreen: boolean,
    private readonly wrapped: boolean
  ) {
    super()
  }

  eq(other: CodeGroupTabsWidget): boolean {
    return (
      other.active === this.active &&
      other.labels.join('\n') === this.labels.join('\n') &&
      other.lang === this.lang &&
      other.collapsed === this.collapsed &&
      other.fullscreen === this.fullscreen &&
      other.wrapped === this.wrapped
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('span')
    bar.className = 'cm-lp-code-tabs'
    const openFrom = (): number => tabsOpenFrom(view, bar, this.containerFrom)

    const fold = iconButton(this.collapsed ? '展开代码组' : '折叠代码组', CHEVRON_DOWN_ICON, 'cm-lp-code-fold')
    if (this.collapsed) fold.classList.add('is-collapsed')
    fold.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const from = openFrom()
      const line = view.state.doc.lineAt(from)
      view.dispatch({
        effects: toggleCodeCollapse.of(from),
        selection: { anchor: line.to },
        userEvent: 'select.code-clamp'
      })
    })
    bar.append(fold)

    this.labels.forEach((label, index) => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = index === this.active ? 'cm-lp-code-tab is-active' : 'cm-lp-code-tab'
      tab.textContent = label
      tab.title = '双击改名'
      tab.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        const from = openFrom()
        const now = Date.now()
        if (lastTabPress && lastTabPress.openFrom === from && lastTabPress.index === index && now - lastTabPress.time < 450) {
          lastTabPress = null
          beginTabRename(view, tab, from, index)
          return
        }
        const startX = event.clientX
        const startY = event.clientY
        let dragging = false
        let ghost: HTMLElement | null = null
        const landingIndex = (x: number): number => {
          const buttons = tabButtons(bar)
          for (let tabIndex = 0; tabIndex < buttons.length; tabIndex += 1) {
            const box = buttons[tabIndex].getBoundingClientRect()
            if (x < box.left + box.width / 2) return tabIndex
          }
          return buttons.length
        }
        const paintDrop = (x: number): number => {
          const buttons = tabButtons(bar)
          const target = landingIndex(x)
          buttons.forEach((button, tabIndex) => {
            const before = dragging && tabIndex === target && tabIndex !== index
            const after = dragging && target === buttons.length && tabIndex === buttons.length - 1 && index !== buttons.length - 1
            button.classList.toggle('is-drop', before)
            button.classList.toggle('is-drop-after', after)
          })
          return target
        }
        const onMove = (move: PointerEvent): void => {
          if (!dragging && Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return
          dragging = true
          if (!ghost) {
            ghost = tab.cloneNode(true) as HTMLElement
            ghost.className = 'cm-lp-code-tab-ghost'
            document.body.append(ghost)
            tab.classList.add('is-dragging')
          }
          ghost.style.left = `${move.clientX + 10}px`
          ghost.style.top = `${move.clientY + 12}px`
          paintDrop(move.clientX)
        }
        const onUp = (up: PointerEvent): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          const target = dragging ? paintDrop(up.clientX) : index
          ghost?.remove()
          tab.classList.remove('is-dragging')
          tabButtons(bar).forEach((button) => {
            button.classList.remove('is-drop')
            button.classList.remove('is-drop-after')
          })
          if (!dragging) {
            lastTabPress = { openFrom: from, index, time: now }
            activatePanel(view, from, index)
            return
          }
          lastTabPress = null
          let insertAt = target
          if (index < insertAt) insertAt -= 1
          if (insertAt !== index) reorderCodeGroupPanel(view, from, index, insertAt)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      })
      tab.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        const from = openFrom()
        const located = panelsNow(view.state, from)
        showCodeGroupMenu(event.clientX, event.clientY, [
          {
            label: '重命名',
            run: () => renameTabLater(view, from, index)
          },
          {
            label: '删除',
            disabled: (located?.panels.length ?? 0) <= 1,
            run: () => removeCodeGroupPanel(view, from, index)
          }
        ])
      })
      bar.append(tab)
    })
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'cm-lp-code-tab-add'
    add.textContent = '+'
    add.title = '添加代码块'
    add.setAttribute('aria-label', '添加代码块')
    add.addEventListener('mousedown', (event) => {
      event.preventDefault()
      insertCodeGroupPanel(view, openFrom())
    })
    bar.append(add)

    const activeFence = (): { from: number; to: number; text: string; panelTo: number } | null => {
      const located = panelsNow(view.state, openFrom())
      const panel = located?.panels[this.active]
      if (!panel) return null
      const line = view.state.doc.lineAt(panel.from)
      return { from: line.from, to: line.to, text: line.text, panelTo: panel.to }
    }

    const lang = document.createElement('input')
    lang.type = 'text'
    lang.className = 'cm-lp-code-lang-input'
    lang.placeholder = 'text'
    lang.spellcheck = false
    lang.value = this.lang
    lang.addEventListener('pointerdown', (event) => event.stopPropagation())
    lang.addEventListener('input', () => {
      const fence = activeFence()
      if (!fence) return
      const next = applyFenceLanguage(fence.text, lang.value)
      if (next === fence.text) return
      restoreGroupLang = true
      view.dispatch({ changes: { from: fence.from, to: fence.to, insert: next } })
    })

    const wrap = codeWrapButton(this.wrapped, () => {
      view.dispatch({ effects: toggleCodeWrap.of(openFrom()) })
    })
    const copy = iconButton('复制', COPY_ICON, 'cm-lp-code-copy')
    copy.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const fence = activeFence()
      if (!fence) return
      const body = view.state.doc.sliceString(Math.min(fence.to + 1, fence.panelTo), fence.panelTo)
      const code = body.replace(/\n?[ \t]*(?:`{3,}|~{3,})[ \t]*$/, '')
      void writeClipboardText(code).then((ok) => flashCopied(copy, ok))
    })

    const fullscreen = iconButton(
      this.fullscreen ? '退出全屏' : '全屏代码',
      this.fullscreen ? COLLAPSE_ICON : EXPAND_ICON,
      'cm-lp-code-expand'
    )
    fullscreen.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ effects: toggleCodeFullscreen.of(openFrom()) })
    })

    bar.append(lang, wrap, copy, fullscreen)
    if (restoreGroupLang) {
      restoreGroupLang = false
      queueMicrotask(() => {
        lang.focus()
        lang.setSelectionRange(lang.value.length, lang.value.length)
      })
    }
    return bar
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** 代码组里当前没显示的段。选区跨出整组时不挡，好让源码露出来。源码模式没有藏起来的行。 */
export function hiddenCodeGroupBodies(
  state: EditorState
): Array<{ from: number; to: number; containerFrom: number; containerTo: number }> {
  if (!state.facet(livePreviewEnabled)) return []
  const bodies: Array<{ from: number; to: number; containerFrom: number; containerTo: number }> = []
  const selection = state.selection.main
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Container') return
      const info = node.node.getChild('ContainerInfo')
      const name = info ? state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0]?.toLowerCase() : ''
      if (name !== 'code-group') return false
      const body = node.node.getChild('ContainerBody')
      if (!body) return false
      const openLine = state.doc.lineAt(node.from)
      const openFrom = openLine.from
      const closeLine = state.doc.lineAt(node.to)
      if (codeChromeAt(state, openFrom)?.collapsed) {
        if (closeLine.number > openLine.number) {
          bodies.push({
            from: state.doc.line(openLine.number + 1).from,
            to: closeLine.to,
            containerFrom: node.from,
            containerTo: node.to
          })
        }
        return false
      }
      const panels = codeGroupPanels(state, body.from, body.to)
      const head = selection.head
      let active = panels.findIndex((panel) => head >= panel.from && head <= panel.to)
      if (active < 0) active = state.field(codeGroupTabs, false)?.get(openFrom) ?? 0
      panels.forEach((panel, index) => {
        // 当前标签的开头围栏也藏起来了（标题和语言在标签栏上改）
        const to = index === active ? state.doc.lineAt(panel.from).to : panel.to
        bodies.push({ from: panel.from, to, containerFrom: node.from, containerTo: node.to })
      })
      const openLineTo = openLine.to
      const closeFrom = closeLine.from
      for (const gap of codeGroupGaps(openLineTo, closeFrom, panels)) {
        bodies.push({ ...gap, containerFrom: node.from, containerTo: node.to })
      }
      return false
    }
  })
  return bodies
}

/** 光标落进藏起来的行时，按移动方向跳过去：往下走就落到后面，往上走就落到前面。 */
function clampCursorAcrossHidden(
  head: number,
  previous: number,
  bodies: Array<{ from: number; to: number }>,
  length: number
): { from: number; to: number } | null {
  let pos = head
  let moved = false
  for (let guard = 0; guard <= bodies.length; guard += 1) {
    const body = bodies.find((item) => pos >= item.from && pos <= item.to)
    if (!body) break
    moved = true
    pos = previous < body.from ? body.to + 1 : body.from - 1
  }
  if (!moved) return null
  const at = Math.max(0, Math.min(pos, length))
  return { from: at, to: at }
}

export const keepCursorOutOfHiddenCodeGroup = EditorStateValue.transactionFilter.of((tr) => {
  if (!tr.selection) return tr
  if (tr.annotation(Transaction.userEvent) === 'select.code-clamp') return tr
  const main = tr.newSelection.main
  const mapped = hiddenCodeGroupBodies(tr.startState).flatMap((body) => {
    const containerFrom = tr.changes.mapPos(body.containerFrom, 1)
    const containerTo = tr.changes.mapPos(body.containerTo, -1)
    if (main.from < containerFrom || main.to > containerTo) return []
    return [{ from: tr.changes.mapPos(body.from, 1), to: tr.changes.mapPos(body.to, -1) }]
  })
  const clamped =
    main.empty
      ? clampCursorAcrossHidden(main.head, tr.changes.mapPos(tr.startState.selection.main.head), mapped, tr.newDoc.length)
      : clampRangeAroundCollapsed(main.from, main.to, mapped)
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

/** 源码模式不画预览，但代码组正文不是语法节点，嵌套高亮进不去，这里按围栏语言补上。 */
function sourceCodeHighlights(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const doc = state.doc
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'ContainerBody') return
      for (const panel of codeGroupPanels(state, node.from, node.to)) {
        const start = doc.lineAt(panel.from)
        const end = doc.lineAt(Math.max(panel.from, panel.to))
        if (end.number <= start.number) continue
        const lang = fenceLang(start.text).replace(/[{:].*$/, '').toLowerCase()
        const codeFrom = Math.min(doc.length, start.to + 1)
        const codeTo = end.from > codeFrom ? end.from - 1 : start.to
        const code = codeTo > codeFrom ? doc.sliceString(codeFrom, codeTo).replace(/\n$/, '') : ''
        if (code) highlightCode(ranges, codeFrom, codeFrom + code.length, lang, code)
      }
      return false
    }
  })
  return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none
}

function build(state: EditorState): LivePreviewState {
  if (!state.facet(livePreviewEnabled)) return { decorations: sourceCodeHighlights(state), blocks: [] }
  const doc = state.doc
  const ranges: Range<Decoration>[] = []
  const blocks: HiddenBlock[] = []
  const selection = state.field(interactionField, false)?.focused === false ? [] : state.selection.ranges
  const touches = (from: number, to: number): boolean =>
    selection.some((range) => range.from <= to && range.to >= from)
  const lineTouched = (pos: number): boolean => {
    const line = doc.lineAt(pos)
    return touches(line.from, line.to)
  }
  const hide = (from: number, to: number): void => {
    if (to > from) ranges.push(hidden.range(from, to))
  }
  const lineClass = (pos: number, className: string): void => {
    ranges.push(Decoration.line({ class: className }).range(doc.lineAt(pos).from))
  }
  const linesClass = (from: number, to: number, className: string): void => {
    const first = doc.lineAt(from).number
    const last = doc.lineAt(to).number
    for (let number = first; number <= last; number += 1) {
      ranges.push(Decoration.line({ class: className }).range(doc.line(number).from))
    }
  }
  /** 整行替换为组件；节点前面有列表/引用前缀时退回行内替换 */
  const replaceBlock = (from: number, to: number, widget: WidgetType): void => {
    const start = doc.lineAt(from)
    const end = doc.lineAt(to)
    const atLineStart = doc.sliceString(start.from, from).trim() === ''
    if (atLineStart) {
      ranges.push(Decoration.replace({ widget, block: true }).range(start.from, end.to))
      blocks.push({ from: start.from, to: end.to })
    } else {
      ranges.push(Decoration.replace({ widget }).range(from, to))
    }
  }
  const kbId = state.facet(cardKnowledgeBase)
  const card = (node: SyntaxNode, kind: CardKind, revealOffset: number): void => {
    const start = doc.lineAt(node.from)
    const source = doc.sliceString(start.from, node.to)
    replaceBlock(node.from, node.to, new CardWidget(kind, source, revealOffset, kbId))
  }
  const listDepth = (node: SyntaxNode): number => {
    let depth = -1
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth += 1
    }
    return Math.max(0, depth)
  }

  const sections = headingSections(state)
  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node
      const { from, to } = ref
      const name = ref.name
      if (name.startsWith('ATXHeading')) {
        const level = Number(name.slice(-1))
        const line = doc.lineAt(from)
        const section = sections.find((item) => item.lineEnd === line.to && item.end > item.lineEnd)
        const folded = section ? isHeadingFolded(state, section.lineEnd, section.end) : false
        lineClass(from, `cm-lp-heading cm-lp-h${level}${folded ? ' cm-lp-heading-folded' : ''}`)
        if (section) {
          const label = line.text.replace(/^#{1,6}[ \t]*/, '').trim() || '章节'
          ranges.push(
            Decoration.widget({
              widget: new HeadingFoldToggle(folded, label),
              side: -1
            }).range(line.from)
          )
        }
        if (!lineTouched(from)) {
          const line = doc.lineAt(from)
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name !== 'HeaderMark') continue
            if (child.from <= from) {
              let end = child.to
              while (end < line.to && doc.sliceString(end, end + 1) === ' ') end += 1
              hide(line.from, end)
            } else {
              let start = child.from
              while (start > line.from && doc.sliceString(start - 1, start) === ' ') start -= 1
              hide(start, child.to)
            }
          }
        }
        return
      }
      switch (name) {
        case 'SetextHeading1':
        case 'SetextHeading2': {
          const level = name.endsWith('1') ? 1 : 2
          const mark = node.getChild('HeaderMark')
          const textEnd = mark ? doc.lineAt(mark.from).from - 1 : to
          linesClass(from, Math.max(from, textEnd), `cm-lp-heading cm-lp-h${level}`)
          if (mark && !touches(from, to)) hide(mark.from, mark.to)
          return
        }
        case 'Blockquote':
          linesClass(from, to, 'cm-lp-quote')
          return
        case 'QuoteMark': {
          if (lineTouched(from)) return
          const next = doc.sliceString(to, to + 1)
          hide(from, next === ' ' ? to + 1 : to)
          return
        }
        case 'ListMark': {
          const list = node.parent?.parent
          if (list?.name === 'BulletList') {
            if (!touches(from, to)) {
              ranges.push(Decoration.replace({ widget: new BulletWidget(listDepth(node)) }).range(from, to))
            }
          } else {
            ranges.push(Decoration.mark({ class: 'cm-lp-ol-mark' }).range(from, to))
          }
          return
        }
        case 'TaskMarker': {
          if (touches(from, to)) return
          const checked = /x/i.test(doc.sliceString(from + 1, from + 2))
          ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, to))
          if (checked) {
            const line = doc.lineAt(to)
            if (line.to > to) ranges.push(Decoration.mark({ class: 'cm-lp-task-done' }).range(to, line.to))
          }
          return
        }
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough': {
          if (touches(from, to)) return
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'EmphasisMark' || child.name === 'StrikethroughMark') {
              hide(child.from, child.to)
            }
          }
          return
        }
        case 'InlineCode': {
          const marks = node.getChildren('CodeMark')
          const open = marks[0]
          const close = marks[marks.length - 1]
          if (open && close && close.from > open.to) {
            ranges.push(Decoration.mark({ class: 'cm-lp-inline-code' }).range(open.to, close.from))
          }
          if (!touches(from, to)) for (const mark of marks) hide(mark.from, mark.to)
          return false
        }
        case 'Link': {
          const marks = node.getChildren('LinkMark')
          const url = node.getChild('URL')
          const href = url ? doc.sliceString(url.from, url.to) : ''
          const closeBracket = marks.find((mark) => doc.sliceString(mark.from, mark.to) === ']')
          const textFrom = from + 1
          const textTo = closeBracket ? closeBracket.from : to
          if (textTo > textFrom) {
            ranges.push(
              Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': href } }).range(textFrom, textTo)
            )
          }
          if (!touches(from, to)) {
            hide(from, textFrom)
            hide(textTo, to)
          }
          return
        }
        case 'Autolink': {
          const url = node.getChild('URL')
          if (url) {
            ranges.push(
              Decoration.mark({
                class: 'cm-lp-link',
                attributes: { 'data-href': doc.sliceString(url.from, url.to) }
              }).range(url.from, url.to)
            )
          }
          if (!touches(from, to)) {
            hide(from, from + 1)
            hide(to - 1, to)
          }
          return false
        }
        case 'URL': {
          const parent = node.parent?.name
          if (parent === 'Link' || parent === 'Image' || parent === 'Autolink') return
          ranges.push(
            Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': doc.sliceString(from, to) } }).range(
              from,
              to
            )
          )
          return
        }
        case 'Image': {
          const image = readImage(state, node)
          if (!image) return false
          if (!touches(image.from, image.attrTo)) {
            ranges.push(
              Decoration.replace({
                widget: new ImageWidget(image.src, image.alt, image.width, image.align, false)
              }).range(image.from, image.attrTo)
            )
          } else {
            ranges.push(
              Decoration.widget({
                widget: new ImageWidget(image.src, image.alt, image.width, image.align, true),
                side: 1
              }).range(image.attrTo)
            )
          }
          return false
        }
        case 'InlineMath': {
          if (touches(from, to)) return false
          const content = node.getChild('MathContent')
          const source = content ? doc.sliceString(content.from, content.to) : ''
          ranges.push(Decoration.replace({ widget: new MathWidget(source, false) }).range(from, to))
          return false
        }
        case 'BlockMath': {
          if (touches(from, to)) {
            linesClass(from, to, 'cm-lp-source-block')
            return false
          }
          const content = node.getChild('MathContent')
          const source = content ? doc.sliceString(content.from, content.to) : ''
          replaceBlock(from, to, new MathWidget(source, true))
          return false
        }
        case 'Escape':
          if (!touches(from, to)) hide(from, from + 1)
          return false
        case 'HorizontalRule':
          if (!lineTouched(from)) {
            ranges.push(Decoration.replace({ widget: new HorizontalRuleWidget() }).range(from, to))
          }
          return false
        case 'FencedCode': {
          const info = node.getChild('CodeInfo')
          const infoText = info ? doc.sliceString(info.from, info.to).trim() : ''
          const lang = infoText.split(/\s+/)[0]?.toLowerCase() ?? ''
          const openLine = doc.lineAt(from)
          const closeLine = doc.lineAt(to)
          if (lang === 'mermaid' || lang === 'mindmap') {
            if (!touches(from, to)) {
              card(node, lang, openLine.to - openLine.from + 1)
              return false
            }
            linesClass(from, to, 'cm-lp-codeblock')
            return false
          }
          const closed = node.getChildren('CodeMark').length > 1 && closeLine.number > openLine.number
          const chrome = codeChromeAt(state, openLine.from)
          const nowrap = chrome?.wrapped ? '' : ' cm-lp-code-nowrap'
          for (let number = openLine.number; number <= closeLine.number; number += 1) {
            const className =
              (number === openLine.number
                ? 'cm-lp-codeblock cm-lp-codeblock-first'
                : number === closeLine.number
                  ? 'cm-lp-codeblock cm-lp-codeblock-last'
                  : 'cm-lp-codeblock') + (number === openLine.number ? '' : nowrap)
            ranges.push(Decoration.line({ class: className }).range(doc.line(number).from))
          }
          if (!chrome?.collapsed) {
            ranges.push(
              ...codeLineDecorations(doc, openLine.number, closed ? closeLine.number - 1 : closeLine.number)
            )
          }
          // 选区跨出围栏时露出源码，藏住的 ``` 才不会被悄悄选中。选区只在代码正文里时仍用标题栏。
          const spansOutside = selection.some(
            (range) =>
              range.from !== range.to &&
              range.from < to &&
              range.to > from &&
              (range.from < from || range.to > to)
          )
          if (spansOutside) return false
          const meta = infoText.slice(lang.length).trim()
          const title = parseFenceTitleFromMeta(meta) || /\[([^\]]+)\]/.exec(meta)?.[1] || ''
          const codeText = node.getChild('CodeText')
          const code = codeText ? doc.sliceString(codeText.from, codeText.to) : ''
          const fullscreen = Boolean(chrome?.fullscreen)
          if (fullscreen) {
            for (let number = openLine.number; number <= closeLine.number; number += 1) {
              ranges.push(Decoration.line({ class: 'cm-lp-codeblock-fs' }).range(doc.line(number).from))
            }
          }
          ranges.push(
            Decoration.replace({
              widget: new CodeFenceHeaderWidget(
                lang,
                title,
                code,
                openLine.from,
                Boolean(chrome?.collapsed),
                fullscreen,
                Boolean(chrome?.wrapped)
              )
            }).range(Math.max(openLine.from, from), openLine.to)
          )
          const closeMarks = node.getChildren('CodeMark')
          const closing = closeMarks.length > 1 ? closeMarks[closeMarks.length - 1] : null
          if (closing && closeLine.number > openLine.number && !chrome?.collapsed) {
            ranges.push(Decoration.replace({ widget: new EmptyWidget() }).range(closing.from, closing.to))
          }
          if (chrome?.collapsed && closeLine.number > openLine.number) {
            const bodyFrom = doc.line(openLine.number + 1).from
            ranges.push(Decoration.replace({ block: true }).range(bodyFrom, closeLine.to))
          }
          return false
        }
        case 'Container': {
          const infoNode = node.getChild('ContainerInfo')
          const info = infoNode ? doc.sliceString(infoNode.from, infoNode.to).trim() : ''
          const containerName = info.split(/\s+/)[0]?.toLowerCase() ?? ''
          const openLine = doc.lineAt(from)
          const closeLine = doc.lineAt(to)
          const body = node.getChild('ContainerBody')
          // 代码组和普通代码块一样始终是装饰后的源码：换成卡片再换回来，聚焦时高度会跳。
          if (!touches(from, to) && !(containerName === 'code-group' && body)) {
            card(node, 'container', openLine.to - openLine.from + 1)
            return false
          }
          if (containerName === 'code-group' && body) {
            const spansOutside = selection.some(
              (range) =>
                range.from !== range.to &&
                range.from < to &&
                range.to > from &&
                (range.from < from || range.to > to)
            )
            if (spansOutside) return false
            const panels = codeGroupPanels(state, body.from, body.to)
            const head = state.selection.main.head
            let active = panels.findIndex((panel) => head >= panel.from && head <= panel.to)
            if (active < 0) active = state.field(codeGroupTabs).get(openLine.from) ?? 0
            active = Math.min(Math.max(0, active), Math.max(0, panels.length - 1))
            // 折叠和全屏按整组记，键是 `::: code-group` 那一行
            const groupChrome = codeChromeAt(state, openLine.from)
            const groupCollapsed = Boolean(groupChrome?.collapsed) && closeLine.number > openLine.number
            const groupFullscreen = Boolean(groupChrome?.fullscreen)
            const groupWrapped = Boolean(groupChrome?.wrapped)
            const activeLang = panels[active] ? fenceLang(doc.lineAt(panels[active].from).text) : ''
            const openClasses = ['cm-lp-code-group-open']
            if (groupCollapsed) openClasses.push('cm-lp-code-group-collapsed')
            if (groupFullscreen) openClasses.push('cm-lp-codeblock-fs')
            ranges.push(Decoration.line({ class: openClasses.join(' ') }).range(openLine.from))
            ranges.push(
              Decoration.replace({
                widget: new CodeGroupTabsWidget(
                  panels.map((panel) => panel.label),
                  active,
                  openLine.from,
                  activeLang,
                  groupCollapsed,
                  groupFullscreen,
                  groupWrapped
                )
              }).range(openLine.from, openLine.to)
            )
            if (groupCollapsed) {
              ranges.push(
                Decoration.replace({ block: true }).range(doc.line(openLine.number + 1).from, closeLine.to)
              )
              return false
            }
            for (const gap of codeGroupGaps(openLine.to, closeLine.from, panels)) {
              ranges.push(Decoration.replace({ block: true }).range(gap.from, gap.to))
            }
            panels.forEach((panel, index) => {
              const start = doc.lineAt(panel.from)
              const end = doc.lineAt(panel.to)
              if (index !== active) {
                ranges.push(Decoration.replace({ block: true }).range(start.from, end.to))
                return
              }
              const lang = fenceLang(start.text).replace(/[{:].*$/, '').toLowerCase()
              const codeFrom = Math.min(doc.length, start.to + 1)
              const codeTo = end.from > codeFrom ? end.from - 1 : start.to
              const code = codeTo > codeFrom ? doc.sliceString(codeFrom, codeTo).replace(/\n$/, '') : ''
              // 标签栏已经承担标题、语言、复制和全屏，开头围栏整行藏起来
              ranges.push(Decoration.replace({ block: true }).range(start.from, start.to))
              if (end.number > start.number + 1) {
                for (let number = start.number + 1; number < end.number; number += 1) {
                  ranges.push(
                    Decoration.line({
                      class: groupWrapped ? 'cm-lp-codeblock' : 'cm-lp-codeblock cm-lp-code-nowrap'
                    }).range(doc.line(number).from)
                  )
                }
              }
              if (code.length > 0) highlightCode(ranges, codeFrom, codeFrom + code.length, lang, code)
              const endIsFence = end.number > start.number && /^[ \t]*(?:`{3,}|~{3,})[ \t]*$/.test(end.text)
              ranges.push(...codeLineDecorations(doc, start.number, endIsFence ? end.number - 1 : end.number))
              if (end.number > start.number) {
                const marks = /^[ \t]*`{3,}|^[ \t]*~{3,}/.exec(end.text)
                if (marks) {
                  ranges.push(
                    Decoration.replace({ widget: new EmptyWidget() }).range(end.from, end.from + marks[0].length)
                  )
                }
              }
              if (groupFullscreen) {
                for (let number = start.number + 1; number <= end.number; number += 1) {
                  ranges.push(Decoration.line({ class: 'cm-lp-codeblock-fs' }).range(doc.line(number).from))
                }
              }
            })
            if (closeLine.number > openLine.number && closeLine.length > 0) {
              ranges.push(Decoration.replace({ widget: new EmptyWidget() }).range(closeLine.from, closeLine.to))
            }
            return false
          }
          lineClass(openLine.from, `cm-lp-container-mark cm-lp-container-open cm-lp-callout-${containerName}`)
          if (body) linesClass(body.from, body.to, `cm-lp-container-body cm-lp-callout-${containerName}`)
          if (closeLine.number > openLine.number) {
            lineClass(closeLine.from, `cm-lp-container-mark cm-lp-container-close cm-lp-callout-${containerName}`)
          }
          return false
        }
        case 'Frontmatter': {
          // 可视化不画 frontmatter 卡片；源码模式不跑本层装饰，仍显示完整 Markdown。
          // 缓冲里的 --- 块保留，选区偏移 / id 拦截 / 保存字节都不需要再映射。
          const start = doc.lineAt(from)
          const end = doc.lineAt(to)
          ranges.push(Decoration.replace({ block: true }).range(start.from, end.to))
          blocks.push({ from: start.from, to: end.to })
          return false
        }
        case 'HTMLTag': {
          if (BREAK_TAG.test(doc.sliceString(from, to)) && !touches(from, to)) {
            ranges.push(Decoration.replace({ widget: new BreakWidget(false) }).range(from, to))
          }
          return false
        }
        case 'ComponentBlock': {
          if (touches(from, to)) {
            linesClass(from, to, 'cm-lp-source-block')
            return false
          }
          card(node, 'component', 0)
          return false
        }
        case 'HTMLBlock': {
          const source = doc.sliceString(from, to)
          if (BREAK_TAG.test(source.trim())) {
            if (!lineTouched(from)) ranges.push(Decoration.replace({ widget: new BreakWidget(true) }).range(from, to))
            return false
          }
          if (touches(from, to)) {
            linesClass(from, to, 'cm-lp-source-block')
            return false
          }
          card(node, isKnownComponent(source) ? 'component' : 'html', 0)
          return false
        }
        case 'LinkReference':
          lineClass(from, lineTouched(from) ? 'cm-lp-link-ref is-active' : 'cm-lp-link-ref')
          return false
        case 'CommentBlock':
          linesClass(from, to, 'cm-lp-comment-block')
          return false
        case 'Table': {
          if (touches(from, to)) {
            linesClass(from, to, 'cm-lp-source-block cm-lp-table-source')
            return false
          }
          card(node, 'table', 2)
          return false
        }
        default:
          return
      }
    }
  })

  return { decorations: Decoration.set(ranges, true), blocks }
}

const livePreviewStateField = StateField.define<LivePreviewState>({
  create: (state) => build(state),
  update(value, tr) {
    const modeChanged = tr.startState.facet(livePreviewEnabled) !== tr.state.facet(livePreviewEnabled)
    const interactionChanged = tr.startState.field(interactionField) !== tr.state.field(interactionField)
    const frozen = tr.state.field(interactionField).pointerSelecting && !tr.docChanged && !interactionChanged
    if (frozen) return value
    if (
      tr.docChanged ||
      tr.selection ||
      modeChanged ||
      interactionChanged ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      headingFoldKey(tr.startState) !== headingFoldKey(tr.state) ||
      tr.startState.field(codeBlockChrome, false) !== tr.state.field(codeBlockChrome, false) ||
      tr.startState.field(codeHighlightEpoch, false) !== tr.state.field(codeHighlightEpoch, false) ||
      tr.effects.some((effect) => effect.is(setCodeGroupTab))
    ) {
      return build(tr.state)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

/** 实时预览显示层（含焦点与拖选状态跟踪） */
export const livePreviewField: Extension = [
  interactionField,
  codeHighlightEpoch,
  codeHighlightLoader,
  livePreviewStateField,
  pointerTracker,
  // 标题输入框在编辑器内部。焦点从正文移到输入框时仍算在编辑，否则分组会退回卡片并把输入框拆掉。
  EditorView.domEventHandlers({
    focusin(_event, view) {
      if (!view.state.field(interactionField).focused) view.dispatch({ effects: setFocused.of(true) })
      return false
    },
    focusout(event, view) {
      const next = event.relatedTarget
      if (next instanceof Node && view.dom.contains(next)) return false
      if (view.state.field(interactionField).focused) view.dispatch({ effects: setFocused.of(false) })
      return false
    }
  })
]

/** 当前被组件整块替换掉的源码范围 */
export function hiddenBlocks(state: EditorState): HiddenBlock[] {
  return state.field(livePreviewStateField, false)?.blocks ?? []
}
