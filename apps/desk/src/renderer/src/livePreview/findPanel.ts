import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery
} from '@codemirror/search'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type Panel, type ViewUpdate } from '@codemirror/view'

import { setEditorInteracting } from './decorations'

/**
 * 当前笔记的查找 / 替换条（对齐 VS Code 编辑器内的 Find）。
 *
 * 查询状态全部交给 `@codemirror/search`：高亮、跳转、替换（含 `$1` 捕获组）都用它的命令，
 * 这里只负责界面、计数、开关记忆和「在选区中查找」。
 */

const OPTIONS_KEY = 'tnotes.find.options'
/** macOS 上 Ctrl+H 是输入框里的「向后删除」，替换只认 ⌥⌘F */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
/** 超过这个数就不再往下数，显示 `1000+`，避免超长文档每次按键都全量遍历 */
const COUNT_LIMIT = 1000

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

export function loadFindOptions(): FindOptions {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? '{}')
    return {
      caseSensitive: raw.caseSensitive === true,
      wholeWord: raw.wholeWord === true,
      regexp: raw.regexp === true
    }
  } catch {
    return { caseSensitive: false, wholeWord: false, regexp: false }
  }
}

function saveFindOptions(options: FindOptions): void {
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(options))
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

/* ---------- 在选区中查找 ---------- */

const setFindScope = StateEffect.define<{ from: number; to: number } | null>({
  map: (value, change) =>
    value && { from: change.mapPos(value.from, -1), to: change.mapPos(value.to, 1) }
})

const scopeMark = Decoration.mark({ class: 'cm-find-scope' })

/** 查找范围：随编辑映射，null 表示整篇 */
export const findScopeField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    let next = value && {
      from: tr.changes.mapPos(value.from, -1),
      to: tr.changes.mapPos(value.to, 1)
    }
    for (const effect of tr.effects) if (effect.is(setFindScope)) next = effect.value
    return next
  },
  provide: (field) =>
    EditorView.decorations.from(field, (scope) =>
      scope && scope.to > scope.from
        ? Decoration.set([scopeMark.range(scope.from, scope.to)])
        : Decoration.none
    )
})

/**
 * 每次范围变化都换一个新的过滤函数：`SearchQuery.eq` 比较的是函数身份，
 * 同一个函数不会触发高亮重算。
 */
function scopeTest(): (match: string, state: EditorState, from: number, to: number) => boolean {
  return (_match, state, from, to) => {
    const scope = state.field(findScopeField, false)
    return !scope || (from >= scope.from && to <= scope.to)
  }
}

/* ---------- 计数 ---------- */

export interface FindCount {
  /** 当前选区落在第几个匹配上（从 1 开始）；不在匹配上为 0 */
  current: number
  total: number
  /** 达到上限后不再往下数 */
  capped: boolean
}

export function countMatches(state: EditorState, query = getSearchQuery(state)): FindCount {
  if (!query.valid) return { current: 0, total: 0, capped: false }
  const main = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let current = 0
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1
    if (next.value.from === main.from && next.value.to === main.to) current = total
    if (total >= COUNT_LIMIT) return { current, total, capped: true }
  }
  return { current, total, capped: false }
}

export function formatCount(count: FindCount, query: SearchQuery): string {
  if (!query.search) return ''
  if (!query.valid) return '表达式无效'
  if (count.total === 0) return '无结果'
  const total = count.capped ? `${COUNT_LIMIT}+` : String(count.total)
  return `${count.current > 0 ? count.current : '?'} / ${total}`
}

/* ---------- 面板 ---------- */

const panels = new WeakMap<EditorView, FindPanel>()

function button(
  label: string,
  title: string,
  onClick: () => void,
  className = 'cm-find-button'
): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  element.title = title
  element.setAttribute('aria-label', title)
  // 按下时不抢走输入框焦点
  element.addEventListener('mousedown', (event) => event.preventDefault())
  element.addEventListener('click', onClick)
  return element
}

class FindPanel implements Panel {
  readonly dom: HTMLElement
  readonly top = true
  private readonly findInput: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly countLabel: HTMLElement
  private readonly replaceRow: HTMLElement
  private readonly expandButton: HTMLButtonElement
  private readonly toggles: Record<keyof FindOptions | 'scope', HTMLButtonElement>
  private query: SearchQuery

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state)

    this.findInput = document.createElement('input')
    this.findInput.className = 'cm-find-input'
    this.findInput.placeholder = '查找'
    this.findInput.setAttribute('aria-label', '查找')
    this.findInput.setAttribute('main-field', 'true')
    this.findInput.spellcheck = false
    this.findInput.addEventListener('input', () => this.commit())
    this.findInput.addEventListener('keydown', (event) => this.onFindKeydown(event))

    this.replaceInput = document.createElement('input')
    this.replaceInput.className = 'cm-find-input'
    this.replaceInput.placeholder = '替换'
    this.replaceInput.setAttribute('aria-label', '替换')
    this.replaceInput.spellcheck = false
    this.replaceInput.addEventListener('input', () => this.commit())
    this.replaceInput.addEventListener('keydown', (event) => this.onReplaceKeydown(event))

    this.countLabel = document.createElement('span')
    this.countLabel.className = 'cm-find-count'
    this.countLabel.setAttribute('aria-live', 'polite')

    this.toggles = {
      caseSensitive: button(
        'Aa',
        '区分大小写（⌥⌘C）',
        () => this.toggle('caseSensitive'),
        'cm-find-toggle'
      ),
      wholeWord: button('ab', '全字匹配（⌥⌘W）', () => this.toggle('wholeWord'), 'cm-find-toggle'),
      regexp: button('.*', '使用正则表达式（⌥⌘R）', () => this.toggle('regexp'), 'cm-find-toggle'),
      scope: button('≡', '在选区中查找（⌥⌘L）', () => this.toggleScope(), 'cm-find-toggle')
    }

    this.expandButton = button(
      '›',
      '切换替换（⌥⌘F）',
      () => this.setReplaceOpen(!this.replaceOpen),
      'cm-find-expand'
    )

    const findRow = document.createElement('div')
    findRow.className = 'cm-find-row'
    findRow.append(
      this.findInput,
      this.countLabel,
      this.toggles.caseSensitive,
      this.toggles.wholeWord,
      this.toggles.regexp,
      button('↑', '上一个（⇧Enter / ⇧⌘G）', () => findPrevious(this.view)),
      button('↓', '下一个（Enter / ⌘G）', () => findNext(this.view)),
      this.toggles.scope,
      button('×', '关闭（Esc）', () => this.close(), 'cm-find-button cm-find-close')
    )

    this.replaceRow = document.createElement('div')
    this.replaceRow.className = 'cm-find-row cm-find-replace-row'
    this.replaceRow.append(
      this.replaceInput,
      button('替换', '替换（Enter）', () => replaceNext(this.view), 'cm-find-text-button'),
      button('全部替换', '全部替换（⌘Enter）', () => replaceAll(this.view), 'cm-find-text-button')
    )

    const rows = document.createElement('div')
    rows.className = 'cm-find-rows'
    rows.append(findRow, this.replaceRow)

    this.dom = document.createElement('div')
    this.dom.className = 'cm-find-panel'
    this.dom.append(this.expandButton, rows)
    this.dom.addEventListener('keydown', (event) => this.onPanelKeydown(event))
    this.dom.addEventListener('focusin', () => setEditorInteracting(this.view, true))
    this.dom.addEventListener('focusout', (event) => {
      const next = event.relatedTarget
      if (next instanceof Node && this.view.dom.contains(next)) return
      setEditorInteracting(this.view, false)
    })

    this.setReplaceOpen(false)
    this.syncFromQuery()
    panels.set(view, this)
  }

  get replaceOpen(): boolean {
    return !this.replaceRow.hidden
  }

  mount(): void {
    this.refreshCount()
  }

  destroy(): void {
    panels.delete(this.view)
    if (this.view.state.field(findScopeField, false)) {
      // 关面板即退出「在选区中查找」，下次打开从整篇开始
      queueMicrotask(() => this.view.dispatch({ effects: setFindScope.of(null) }))
    }
  }

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value
          this.syncFromQuery()
        }
      }
    }
    if (
      update.docChanged ||
      update.selectionSet ||
      update.transactions.some((tr) => tr.effects.length > 0)
    ) {
      this.refreshCount()
    }
  }

  focusFind(): void {
    this.findInput.focus()
    this.findInput.select()
  }

  setReplaceOpen(open: boolean, focus = false): void {
    this.replaceRow.hidden = !open
    this.expandButton.textContent = open ? '⌄' : '›'
    this.expandButton.setAttribute('aria-expanded', String(open))
    if (focus && open) {
      this.replaceInput.focus()
      this.replaceInput.select()
    }
  }

  private options(): FindOptions {
    return {
      caseSensitive: this.query.caseSensitive,
      wholeWord: this.query.wholeWord,
      regexp: this.query.regexp
    }
  }

  private syncFromQuery(): void {
    if (this.findInput.value !== this.query.search) this.findInput.value = this.query.search
    if (this.replaceInput.value !== this.query.replace) this.replaceInput.value = this.query.replace
    const options = this.options()
    for (const key of ['caseSensitive', 'wholeWord', 'regexp'] as const) {
      this.toggles[key].classList.toggle('is-active', options[key])
      this.toggles[key].setAttribute('aria-pressed', String(options[key]))
    }
    const scoped = Boolean(this.view.state.field(findScopeField, false))
    this.toggles.scope.classList.toggle('is-active', scoped)
    this.toggles.scope.setAttribute('aria-pressed', String(scoped))
  }

  private commit(overrides: Partial<FindOptions> & { test?: SearchQuery['test'] } = {}): void {
    const options = { ...this.options(), ...overrides }
    const query = new SearchQuery({
      search: this.findInput.value,
      replace: this.replaceInput.value,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      regexp: options.regexp,
      test: 'test' in overrides ? overrides.test : this.query.test
    })
    if (query.eq(this.query)) return
    this.query = query
    this.view.dispatch({ effects: setSearchQuery.of(query) })
    this.syncFromQuery()
  }

  private toggle(key: keyof FindOptions): void {
    const next = { ...this.options(), [key]: !this.options()[key] }
    saveFindOptions(next)
    this.commit(next)
  }

  /** 打开时记下当前选区；选区为空时无事可做 */
  private toggleScope(): void {
    const current = this.view.state.field(findScopeField, false)
    if (current) {
      this.view.dispatch({ effects: setFindScope.of(null) })
    } else {
      const main = this.view.state.selection.main
      if (main.empty) {
        this.toggles.scope.title = '先选中一段文本，再在选区中查找'
        return
      }
      this.view.dispatch({
        effects: setFindScope.of({ from: main.from, to: main.to }),
        // 把光标收到选区开头：否则第一次「下一个」会跳过选区里最前面的匹配
        selection: { anchor: main.from }
      })
    }
    this.commit({ test: scopeTest() })
  }

  private refreshCount(): void {
    const count = countMatches(this.view.state, this.query)
    this.countLabel.textContent = formatCount(count, this.query)
    const missing = Boolean(this.query.search) && (count.total === 0 || !this.query.valid)
    this.findInput.classList.toggle('is-missing', missing)
    this.findInput.setAttribute('aria-invalid', String(missing))
  }

  private close(): void {
    closeSearchPanel(this.view)
    this.view.focus()
  }

  private onFindKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.shiftKey) findPrevious(this.view)
    else findNext(this.view)
  }

  private onReplaceKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.metaKey || event.ctrlKey) replaceAll(this.view)
    else replaceNext(this.view)
  }

  private onPanelKeydown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    const handled = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (event.key === 'Escape') {
      handled()
      this.close()
    } else if (event.key === 'F3') {
      handled()
      if (event.shiftKey) findPrevious(this.view)
      else findNext(this.view)
    } else if (mod && key === 'g') {
      handled()
      if (event.shiftKey) findPrevious(this.view)
      else findNext(this.view)
    } else if (mod && event.altKey && event.code === 'KeyF') {
      handled()
      this.setReplaceOpen(true, true)
    } else if (mod && !event.altKey && key === 'f') {
      handled()
      this.focusFind()
    } else if (!IS_MAC && event.ctrlKey && key === 'h') {
      handled()
      this.setReplaceOpen(true, true)
    } else if (mod && event.altKey && ['KeyC', 'KeyW', 'KeyR', 'KeyL'].includes(event.code)) {
      handled()
      if (event.code === 'KeyC') this.toggle('caseSensitive')
      else if (event.code === 'KeyW') this.toggle('wholeWord')
      else if (event.code === 'KeyR') this.toggle('regexp')
      else this.toggleScope()
    }
  }
}

/** 打开查找条（`replace` 时同时展开替换行并聚焦替换框）。 */
export function openFind(view: EditorView, replace = false): boolean {
  if (!searchPanelOpen(view.state)) openSearchPanel(view)
  const panel = panels.get(view)
  if (!panel) return false
  if (replace) panel.setReplaceOpen(true, true)
  else panel.focusFind()
  return true
}

/** 编辑器的查找扩展：自定义面板 + 记住的开关 + 选区范围 */
export function findExtension(): Extension {
  const options = loadFindOptions()
  return [
    findScopeField,
    search({
      top: true,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      regexp: options.regexp,
      createPanel: (view) => new FindPanel(view)
    })
  ]
}
