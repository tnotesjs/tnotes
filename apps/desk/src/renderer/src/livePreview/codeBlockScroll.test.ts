// @vitest-environment happy-dom
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { codeGroupTabs, livePreviewField, setFocused } from './decorations'
import {
  CodeHScrollWidget,
  codeBlockWheelDelta,
  codeBlockWidthRule,
  layoutCodeBlockScroll,
  syncCodeBlockScroll
} from './codeBlockScroll'
import { codeBlockFullscreenClass } from './codeBlockChrome'
import { tnotesMarkdown } from './language'

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function mount(doc: string, cursor = 0): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        tnotesMarkdown(),
        codeGroupTabs,
        codeBlockFullscreenClass,
        livePreviewField,
        EditorView.lineWrapping
      ]
    })
  })
  view.dispatch({ effects: setFocused.of(true) })
  views.push(view)
  return view
}

describe('code block horizontal scroll', () => {
  it('puts one shared scrollbar on a nowrap block, including a code group', () => {
    const doc = [
      '```ts',
      '111',
      '',
      '222',
      '```',
      '',
      '::: code-group',
      '```js [a.js]',
      'aaa',
      '```',
      ':::',
      ''
    ].join('\n')
    const view = mount(doc, doc.indexOf('111'))
    expect(view.dom.querySelectorAll('.cm-lp-code-hscroll')).toHaveLength(2)
    const codeLines = [...view.dom.querySelectorAll<HTMLElement>('.cm-line')].filter((line) =>
      line.classList.contains('cm-lp-code-nowrap')
    )
    expect(codeLines.length).toBeGreaterThan(0)
    expect(codeLines.every((line) => line.dataset.codeScroll)).toBe(true)
    const header = [...view.dom.querySelectorAll('.cm-line')].find((line) =>
      line.querySelector('.cm-lp-code-header')
    )
    expect(header?.getAttribute('data-code-scroll')).toBeNull()
  })

  it('removes the shared scrollbar when wrapping is turned on', () => {
    const doc = ['```js', 'const value = 1', '```', ''].join('\n')
    const view = mount(doc, doc.indexOf('const'))
    expect(view.dom.querySelectorAll('.cm-lp-code-hscroll')).toHaveLength(1)
    view.dom
      .querySelector<HTMLElement>('.cm-lp-code-wrap')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(view.dom.querySelector('.cm-lp-code-hscroll')).toBeNull()
    const line = [...view.dom.querySelectorAll('.cm-line')].find(
      (item) => item.textContent === 'const value = 1'
    )
    expect(line?.className).not.toContain('cm-lp-code-nowrap')
  })

  it('syncs every line in the block to the scrollbar and hides the bar when nothing overflows', () => {
    const root = document.createElement('div')
    const line = document.createElement('div')
    line.className = 'cm-line'
    line.dataset.codeScroll = '4'
    const bar = document.createElement('div')
    bar.className = 'cm-lp-code-hscroll is-idle'
    bar.dataset.codeScroll = '4'
    const inner = document.createElement('div')
    inner.className = 'cm-lp-code-hscroll-inner'
    bar.append(inner)
    root.append(line, bar)

    syncCodeBlockScroll(root, '4', 36, line)
    expect(bar.scrollLeft).toBe(36)

    let lineScrollWidth = 480
    const lineClientWidth = 120
    Object.defineProperty(line, 'scrollWidth', { configurable: true, get: () => lineScrollWidth })
    Object.defineProperty(line, 'clientWidth', { configurable: true, get: () => lineClientWidth })
    Object.defineProperty(bar, 'clientWidth', { configurable: true, get: () => 120 })
    layoutCodeBlockScroll(root)
    expect(inner.style.width).toBe('480px')
    expect(bar.classList.contains('is-idle')).toBe(false)

    lineScrollWidth = 120
    layoutCodeBlockScroll(root)
    expect(bar.classList.contains('is-idle')).toBe(true)
  })

  it('gives every line the longest line width so they can scroll away together', () => {
    const root = document.createElement('div')
    const long = document.createElement('div')
    const short = document.createElement('div')
    long.className = 'cm-line'
    short.className = 'cm-line'
    long.dataset.codeScroll = '4'
    short.dataset.codeScroll = '4'
    const bar = new CodeHScrollWidget(4).toDOM()
    const inner = bar.querySelector<HTMLElement>('.cm-lp-code-hscroll-inner')!
    const rule = bar.querySelector<HTMLStyleElement>('style.cm-lp-code-hscroll-rule')!
    root.append(long, short, bar)
    const ruleWidth = () => Number(/width: (\d+)px/.exec(rule.textContent ?? '')?.[1] ?? 0)
    let longNatural = 480
    const widthOf = (node: HTMLElement, natural: () => number) => {
      Object.defineProperty(node, 'scrollWidth', {
        configurable: true,
        get: () => Math.max(120, natural(), ruleWidth())
      })
      Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => 120 })
    }
    widthOf(long, () => longNatural)
    widthOf(short, () => 40)
    Object.defineProperty(bar, 'clientWidth', { configurable: true, get: () => 120 })
    layoutCodeBlockScroll(root)
    expect(rule.textContent).toBe(codeBlockWidthRule(bar.dataset.scrollUid!, '4', 480))
    expect(long.getAttribute('style')).toBeNull()
    expect(short.getAttribute('style')).toBeNull()
    expect(short.scrollWidth - short.clientWidth).toBe(360)
    expect(inner.style.width).toBe('480px')

    longNatural = 200
    layoutCodeBlockScroll(root)
    expect(ruleWidth()).toBe(200)
  })

  function wheel(init: WheelEventInit): WheelEvent {
    const event = new WheelEvent('wheel', init)
    if (init.shiftKey) Object.defineProperty(event, 'shiftKey', { value: true })
    return event
  }

  it('turns shift+wheel into a horizontal delta, and leaves vertical wheel alone', () => {
    expect(codeBlockWheelDelta(wheel({ deltaY: 40, shiftKey: true }))).toBe(40)
    expect(codeBlockWheelDelta(wheel({ deltaX: -12, deltaY: 40, shiftKey: true }))).toBe(-12)
    expect(codeBlockWheelDelta(wheel({ deltaX: 18, deltaY: 4 }))).toBe(18)
    expect(codeBlockWheelDelta(wheel({ deltaY: 40 }))).toBe(0)
  })

  it('scrolls the block when shift+wheel happens on a line that does not overflow', () => {
    const doc = ['```ts', '1'.repeat(80), '', '```', ''].join('\n')
    const view = mount(doc, doc.indexOf('1'))
    const lines = [...view.dom.querySelectorAll<HTMLElement>('.cm-line[data-code-scroll]')]
    const blank = lines.find((line) => line.textContent === '')
    const bar = view.dom.querySelector<HTMLElement>('.cm-lp-code-hscroll')
    expect(blank).toBeTruthy()
    expect(bar).toBeTruthy()
    const widen = (node: HTMLElement, scrollWidth: number, clientWidth: number) => {
      Object.defineProperty(node, 'scrollWidth', { configurable: true, get: () => scrollWidth })
      Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => clientWidth })
    }
    widen(bar!, 400, 100)
    for (const line of lines) widen(line, line === blank ? 100 : 400, 100)
    blank!.dispatchEvent(wheel({ deltaY: 30, shiftKey: true, bubbles: true, cancelable: true }))
    expect(bar!.scrollLeft).toBe(30)
    expect(lines.find((line) => line !== blank)!.scrollLeft).toBe(30)
  })
})
