// @vitest-environment happy-dom
//
// happy-dom 里跑不起真正的 Monaco（需要真实布局与 worker 环境），所以这里注入一个
// 行为对齐的假 Monaco：它实现本组件真正用到的那部分 API（模型读写、内容变更事件、
// 选区、executeEdits），编辑语义由**真实**的纯函数（sourceEdits / clearSourceLineStyles）
// 承担。集成层面的真实行为由 e2e 覆盖。
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DESK_SELECT_ALL_EVENT } from './documentSelection'

const refreshMonacoTheme = vi.fn()

interface FakeEdit {
  range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }
  text: string
}

class FakeSelection {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number
  ) {}
  getStartPosition(): { lineNumber: number; column: number } {
    return { lineNumber: this.startLineNumber, column: this.startColumn }
  }
  getEndPosition(): { lineNumber: number; column: number } {
    return { lineNumber: this.endLineNumber, column: this.endColumn }
  }
  isEmpty(): boolean {
    return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn
  }
}

class FakeModel {
  private value = ''
  private listeners = new Set<() => void>()

  constructor(initial: string) {
    this.value = initial
  }

  getValue(): string {
    return this.value
  }

  getValueLength(): number {
    return this.value.length
  }

  setValue(next: string): void {
    if (next === this.value) return
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }

  onDidChangeContent(listener: () => void): void {
    this.listeners.add(listener)
  }

  /** 1 基行列 ↔ 0 基偏移（与 Monaco 同语义） */
  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const target = Math.max(0, Math.min(offset, this.value.length))
    const before = this.value.slice(0, target)
    const lines = before.split('\n')
    return { lineNumber: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
  }

  getOffsetAt(position: { lineNumber: number; column: number }): number {
    const lines = this.value.split('\n')
    let offset = 0
    for (let index = 0; index < position.lineNumber - 1 && index < lines.length; index += 1) {
      offset += lines[index].length + 1
    }
    return Math.min(offset + position.column - 1, this.value.length)
  }

  /** 与 Monaco 同语义：按选区取原文（不 trim、不折叠空白） */
  getValueInRange(range: FakeEdit['range']): string {
    const from = this.getOffsetAt({
      lineNumber: range.startLineNumber,
      column: range.startColumn
    })
    const to = this.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn })
    return this.value.slice(Math.min(from, to), Math.max(from, to))
  }

  getFullModelRange(): FakeEdit['range'] {
    const end = this.getPositionAt(this.value.length)
    return {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: end.lineNumber,
      endColumn: end.column
    }
  }

  applyEdits(edits: FakeEdit[]): void {
    const withOffsets = edits
      .map((edit) => ({
        from: this.getOffsetAt({
          lineNumber: edit.range.startLineNumber,
          column: edit.range.startColumn
        }),
        to: this.getOffsetAt({
          lineNumber: edit.range.endLineNumber,
          column: edit.range.endColumn
        }),
        text: edit.text
      }))
      .sort((a, b) => b.from - a.from)
    for (const edit of withOffsets) {
      this.value = `${this.value.slice(0, edit.from)}${edit.text}${this.value.slice(edit.to)}`
    }
    for (const listener of [...this.listeners]) listener()
  }
}

const created: FakeEditor[] = []

class FakeEditor {
  model: FakeModel
  private contentListeners = new Set<() => void>()
  private cursorSelectionListeners = new Set<() => void>()
  private commands = new Map<number, () => void>()
  private keyDownListeners: Array<(event: { preventDefault(): void }) => void> = []
  selection: FakeSelection
  scrollTop = 0
  options: Record<string, unknown>
  container: HTMLDivElement
  focused = 0
  disposed = false

  constructor(host: HTMLElement, options: Record<string, unknown>) {
    this.options = options
    this.model = new FakeModel(String(options.value ?? ''))
    this.model.onDidChangeContent(() => {
      for (const listener of [...this.contentListeners]) listener()
    })
    this.selection = new FakeSelection(1, 1, 1, 1)
    this.container = document.createElement('div')
    this.container.className = 'monaco-editor'
    host.append(this.container)
    created.push(this)
  }

  getModel(): FakeModel {
    return this.model
  }
  getContainerDomNode(): HTMLDivElement {
    return this.container
  }
  onDidChangeModelContent(listener: () => void): void {
    this.contentListeners.add(listener)
  }
  onDidChangeCursorSelection(listener: () => void): void {
    this.cursorSelectionListeners.add(listener)
  }
  /** 选区变了 → 通知选区监听器（真实 Monaco 的行为） */
  private emitCursorSelection(): void {
    for (const listener of [...this.cursorSelectionListeners]) listener()
  }
  getSelections(): FakeSelection[] {
    return [this.selection]
  }
  onKeyDown(listener: (event: { preventDefault(): void }) => void): void {
    this.keyDownListeners.push(listener)
  }
  addCommand(key: number, handler: () => void): void {
    this.commands.set(key, handler)
  }
  /** 右键菜单动作（固定为 Agent 上下文走这里） */
  actions: Array<{
    id: string
    label: string
    contextMenuGroupId?: string
    precondition?: string
    run: () => void
  }> = []
  addAction(action: {
    id: string
    label: string
    contextMenuGroupId?: string
    precondition?: string
    run: () => void
  }): { dispose(): void } {
    this.actions.push(action)
    return { dispose: () => undefined }
  }
  runAction(id: string): boolean {
    const action = this.actions.find((item) => item.id === id)
    if (!action) return false
    action.run()
    return true
  }
  runCommand(key: number): void {
    this.commands.get(key)?.()
  }
  triggerKeyDown(event: { preventDefault(): void }): void {
    for (const listener of [...this.keyDownListeners]) listener(event)
  }
  executeEdits(_source: string, edits: FakeEdit[]): void {
    this.model.applyEdits(edits)
  }
  getSelection(): FakeSelection {
    return this.selection
  }
  setSelection(range: FakeEdit['range'] | FakeSelection): void {
    const source = range as unknown as {
      startLineNumber?: number
      startColumn?: number
      endLineNumber?: number
      endColumn?: number
    }
    this.selection = new FakeSelection(
      source.startLineNumber ?? 1,
      source.startColumn ?? 1,
      source.endLineNumber ?? source.startLineNumber ?? 1,
      source.endColumn ?? source.startColumn ?? 1
    )
    this.emitCursorSelection()
  }
  getScrollTop(): number {
    return this.scrollTop
  }
  setScrollTop(value: number): void {
    this.scrollTop = value
  }
  updateOptions(options: Record<string, unknown>): void {
    this.options = { ...this.options, ...options }
  }
  focus(): void {
    this.focused += 1
  }
  layout(): void {
    // 真实 Monaco 会重排；测试里不需要
  }
  dispose(): void {
    this.disposed = true
  }
}

const fakeMonaco = {
  editor: {
    create: (host: HTMLElement, options: Record<string, unknown>) => new FakeEditor(host, options)
  },
  Selection: FakeSelection,
  KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
  KeyCode: {
    KeyB: 32,
    KeyI: 39,
    KeyE: 20,
    KeyX: 53,
    KeyS: 44,
    KeyT: 45,
    KeyU: 46,
    Digit0: 21,
    Digit1: 22,
    Digit7: 28,
    Digit8: 29
  }
}

/** 可切换的懒加载实现：用来测「Monaco 加载失败」这条路径。 */
let loadMonacoImpl: () => Promise<typeof fakeMonaco> = async () => fakeMonaco

vi.mock('../monaco/monaco', () => ({
  loadMonaco: () => loadMonacoImpl(),
  monacoThemeName: () => 'tnotes-light',
  readOnlyEditorOptions: () => ({}),
  baseEditorOptions: () => ({}),
  refreshMonacoTheme: (api: unknown) => refreshMonacoTheme(api)
}))

const { default: MarkdownSourceEditor } = await import('./MarkdownSourceEditor.vue')

interface EditorHandle {
  insertTextAt(text: string, position?: number): void
  wrapSelection(prefix: string, suffix: string, placeholder?: string): void
  prefixSelection(prefix: string): void
  setLinePrefix(prefix: string): void
  insertTable(): void
  addHeadingNumbers(maxDepth: number): void
  removeHeadingNumbers(): void
  selectAll(): void
}

function mountEditor(
  content = 'alpha',
  props: Partial<InstanceType<typeof MarkdownSourceEditor>['$props']> = {}
): VueWrapper {
  return mount(MarkdownSourceEditor, {
    attachTo: document.body,
    props: {
      content,
      mode: 'source',
      readOnly: false,
      knowledgeBaseId: 'kb-a',
      noteUuid: 'note-a',
      active: true,
      ...props
    }
  })
}

const handle = (wrapper: VueWrapper): EditorHandle => wrapper.vm as unknown as EditorHandle
/** 等 onMounted 里的异步加载与编辑器创建完成 */
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}
const editorOf = (): FakeEditor => created.at(-1)!
const textOf = (wrapper: VueWrapper): string => {
  void wrapper
  return editorOf().model.getValue()
}

describe('MarkdownSourceEditor（Monaco）', () => {
  beforeEach(() => {
    created.length = 0
    refreshMonacoTheme.mockClear()
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.body.replaceChildren()
  })

  it('初始内容与外同步都不回抛 change', async () => {
    const wrapper = mountEditor()
    await settle()

    expect(textOf(wrapper)).toBe('alpha')
    expect(wrapper.emitted('change')).toBeUndefined()

    await wrapper.setProps({ content: 'external\ncontent' })
    await settle()
    expect(textOf(wrapper)).toBe('external\ncontent')
    expect(wrapper.emitted('change')).toBeUndefined()
    wrapper.unmount()
  })

  it('页宽在标准与超宽之间切换（class 与折行同步）', async () => {
    const wrapper = mountEditor('alpha', { pageWidth: 'wide' })
    await settle()
    expect(wrapper.get('.markdown-source-editor').classes()).toContain('is-wide')
    expect(editorOf().options.wordWrap).toBe('off')

    await wrapper.setProps({ pageWidth: 'standard' })
    await settle()
    expect(wrapper.get('.markdown-source-editor').classes()).not.toContain('is-wide')
    expect(editorOf().options.wordWrap).toBe('on')
    wrapper.unmount()
  })

  it('工具栏接口产出与旧版逐字节相同的 Markdown', async () => {
    const insertion = mountEditor()
    await settle()
    handle(insertion).insertTextAt('!', 5)
    expect(insertion.emitted<string[]>('change')?.at(-1)?.[0]).toBe('alpha!')
    insertion.unmount()

    const inline = mountEditor()
    await settle()
    handle(inline).wrapSelection('**', '**')
    expect(inline.emitted<string[]>('change')?.at(-1)?.[0]).toBe('**文字**alpha')
    inline.unmount()

    const block = mountEditor()
    await settle()
    handle(block).setLinePrefix('## ')
    expect(block.emitted<string[]>('change')?.at(-1)?.[0]).toBe('## alpha')
    block.unmount()

    const quoted = mountEditor('one\ntwo')
    await settle()
    handle(quoted).prefixSelection('> ')
    expect(quoted.emitted<string[]>('change')?.at(-1)?.[0]).toBe('> one\ntwo')
    quoted.unmount()

    const table = mountEditor()
    await settle()
    handle(table).insertTable()
    expect(table.emitted<string[]>('change')?.at(-1)?.[0]).toBe(
      '\n|  |  |\n| --- | --- |\n|  |  |\nalpha'
    )
    table.unmount()
  })

  it('标题编号仍是一步整体重写（有变化才写）', async () => {
    const wrapper = mountEditor('# one\n## two')
    await settle()
    handle(wrapper).addHeadingNumbers(6)
    const numbered = wrapper.emitted<string[]>('change')?.at(-1)?.[0] ?? ''
    expect(numbered).not.toBe('# one\n## two')
    expect(numbered).toContain('one')
    wrapper.unmount()

    // 已经是编号标题时，剥除回到无编号（编号格式为 `1. ` / `1.1. `）
    const numberedSource = '# 1. one\n## 1.1. two'
    const stripped = mountEditor(numberedSource)
    await settle()
    handle(stripped).removeHeadingNumbers()
    expect(stripped.emitted<string[]>('change')?.at(-1)?.[0]).toBe('# one\n## two')
    stripped.unmount()
  })

  it('注册了 Markdown 格式快捷键，触发后产出正确编辑', async () => {
    const wrapper = mountEditor()
    await settle()
    const editor = editorOf()
    // Mod-B：加粗
    editor.runCommand(fakeMonaco.KeyMod.CtrlCmd | fakeMonaco.KeyCode.KeyB)
    expect(wrapper.emitted<string[]>('change')?.at(-1)?.[0]).toBe('**文字**alpha')
    // Mod-E：行内代码（作用在上一步选中的占位文字上）
    editor.runCommand(fakeMonaco.KeyMod.CtrlCmd | fakeMonaco.KeyCode.KeyE)
    expect(wrapper.emitted<string[]>('change')?.at(-1)?.[0]).toBe('**`文字`**alpha')
    wrapper.unmount()
  })

  it('Mod-\\ 清掉选区内行的样式标记，只读时不动', async () => {
    const source = '**first**\n*second* ~~more~~\n**last**'
    const wrapper = mountEditor(source)
    await settle()
    const editor = editorOf()
    editor.setSelection(new FakeSelection(1, 2, 2, 15))
    const preventDefault = vi.fn()
    editor.triggerKeyDown({ metaKey: true, preventDefault, browserEvent: { key: '\\' } })
    expect(preventDefault).toHaveBeenCalled()
    expect(editor.model.getValue()).toBe('first\nsecond more\n**last**')

    await wrapper.setProps({ readOnly: true })
    await settle()
    editor.setSelection(new FakeSelection(1, 1, 1, 1))
    const blocked = vi.fn()
    editor.triggerKeyDown({ metaKey: true, preventDefault: blocked, browserEvent: { key: '\\' } })
    expect(blocked).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('只读时暴露的方法全部被挡住', async () => {
    const wrapper = mountEditor('alpha', { readOnly: true })
    await settle()
    handle(wrapper).insertTextAt('blocked')
    handle(wrapper).wrapSelection('**', '**')
    handle(wrapper).setLinePrefix('# ')
    expect(textOf(wrapper)).toBe('alpha')
    expect(wrapper.emitted('change')).toBeUndefined()
    expect(editorOf().options.readOnly).toBe(true)
    wrapper.unmount()
  })

  it('明暗切换时重算主题，且不产生内容变化', async () => {
    document.documentElement.dataset.theme = 'light'
    const wrapper = mountEditor()
    await settle()
    refreshMonacoTheme.mockClear()

    document.documentElement.dataset.theme = 'dark'
    await vi.waitFor(() => expect(refreshMonacoTheme).toHaveBeenCalled())
    expect(wrapper.emitted('change')).toBeUndefined()
    wrapper.unmount()
  })

  it('粘贴图片在当前光标处 emit，并拦下默认粘贴', async () => {
    const wrapper = mountEditor('head\ntail')
    await settle()
    const editor = editorOf()
    editor.setSelection(new FakeSelection(2, 1, 2, 1))
    const transfer = new DataTransfer()
    const image = new File(['image'], 'paste.png', { type: 'image/png' })
    transfer.items.add(image)
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    })
    editor.getContainerDomNode().dispatchEvent(event)

    const pasted = wrapper.emitted<[File, number]>('pasteImage')
    expect(pasted).toHaveLength(1)
    expect(pasted?.[0][0]).toBe(image)
    expect(pasted?.[0][1]).toBe(5) // 第二行行首 = 'head\n'.length
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.emitted('change')).toBeUndefined()
    wrapper.unmount()
  })

  it('应用菜单的全选覆盖整篇文档', async () => {
    const wrapper = mountEditor('alpha\nbeta')
    await settle()
    window.dispatchEvent(new Event(DESK_SELECT_ALL_EVENT))
    const editor = editorOf()
    expect(editor.selection.getStartPosition()).toEqual({ lineNumber: 1, column: 1 })
    expect(editor.selection.getEndPosition()).toEqual({ lineNumber: 2, column: 5 })
    expect(editor.focused).toBeGreaterThan(0)
    wrapper.unmount()
  })

  it('卸载时释放编辑器', async () => {
    const wrapper = mountEditor()
    await settle()
    const editor = editorOf()
    wrapper.unmount()
    expect(editor.disposed).toBe(true)
  })
})

/** 本机 MCP 选区快照：源码视图这一层给出的编辑器数据（笔记身份由上层补） */
describe('MarkdownSourceEditor 选区采集（供本机 MCP 使用）', () => {
  beforeEach(() => {
    created.length = 0
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  const capture = (wrapper: VueWrapper): { selectedText: string; range: unknown } =>
    (
      wrapper.vm as unknown as {
        selectionCapture(): { selectedText: string; range: unknown }
      }
    ).selectionCapture()

  it('给出一段原文与精确范围（不 trim、emoji 完整、结束不含）', async () => {
    const content = '# 标题\n\n第一段 emoji 🎯 与末尾空格 \n\n第二段\n'
    const wrapper = mountEditor(content)
    await settle()
    const from = content.indexOf('第一段')
    const text = '第一段 emoji 🎯 与末尾空格 '

    editorOf().setSelection({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: text.length + 1,
      text: ''
    })
    await settle()
    const payload = capture(wrapper)
    expect(payload.selectedText).toBe(text)
    expect(payload.range).toMatchObject({
      startLine: 3,
      endLine: 3,
      startOffset: from,
      endOffset: from + text.length,
      lineBase: 1,
      columnBase: 1,
      endExclusive: true
    })
    wrapper.unmount()
  })

  it('右键菜单注册了「固定为 Agent 上下文」，触发后 emit pinSelection', async () => {
    const wrapper = mountEditor('alpha\nbeta\n')
    await settle()
    const editor = editorOf()
    const action = editor.actions.find((item) => item.id === 'desk-pin-selection')
    expect(action?.label).toBe('固定为 Agent 上下文')
    expect(action?.contextMenuGroupId).toBe('1_modification')
    expect(action?.precondition).toBe('editorHasSelection')

    editor.runAction('desk-pin-selection')
    expect(wrapper.emitted('pinSelection')).toHaveLength(1)
    wrapper.unmount()
  })

  it('没有选区 → empty；不是活动标签时不 emit', async () => {
    const wrapper = mountEditor('alpha\nbeta\n')
    await settle()
    const vm = wrapper.vm as unknown as { selectionCapture(): { empty: boolean } }
    expect(vm.selectionCapture()).toMatchObject({ empty: true })

    await wrapper.setProps({ active: false })
    await settle()
    editorOf().setSelection({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 6,
      text: ''
    })
    await settle()
    expect(wrapper.emitted('selectionChange')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('Monaco 懒加载失败', () => {
  afterEach(() => {
    loadMonacoImpl = async () => fakeMonaco
  })

  it('落成可见错误态（而不是未处理的 mounted hook 异常），重试后恢复', async () => {
    loadMonacoImpl = async () => {
      throw new TypeError('Failed to fetch dynamically imported module: monaco-editor.js?v=stale')
    }
    const wrapper = mountEditor()
    await settle()

    // 加载失败：可见错误态，且此时没有编辑器实例（用增量判断，避免同文件其它
    // 用例遗留的挂载实例干扰）
    const baseline = created.length
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('源码编辑器加载失败')
    expect(alert.text()).toContain('重新加载窗口')
    expect(wrapper.find('.monaco-editor').exists()).toBe(false)
    expect(created.length).toBe(baseline)

    // 依赖恢复（或换了新地址）后重试：应当真的建出编辑器
    loadMonacoImpl = async () => fakeMonaco
    await wrapper.findAll('button')[0]!.trigger('click')
    await settle()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(created.length).toBe(baseline + 1)
    wrapper.unmount()
  })
})
