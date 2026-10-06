// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { parseFencedCode, rebuildMermaidFence, renderDiagram } from './diagramRenderer'

describe('parseFencedCode', () => {
  it('extracts the language and body from a mermaid fence', () => {
    const result = parseFencedCode('```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```')
    expect(result).toEqual({
      lang: 'mermaid',
      code: 'flowchart TD\n  A[开始] --> B[结束]',
      title: '',
      center: false
    })
  })

  it('detects the center keyword on mermaid fences', () => {
    expect(parseFencedCode('```mermaid center\nA-->B\n```').center).toBe(true)
  })
})

describe('rebuildMermaidFence', () => {
  it('adds and removes the center keyword', () => {
    const base = '```mermaid\nA-->B\n```\n'
    expect(rebuildMermaidFence(base, true)).toBe('```mermaid center\nA-->B\n```\n')
    expect(rebuildMermaidFence('```mermaid center\nA-->B\n```\n', false)).toBe(base)
  })

  it('replaces the body while preserving center', () => {
    const source = '```mermaid center\nA-->B\n```\n'
    expect(rebuildMermaidFence(source, true, 'flowchart LR\n  X --> Y')).toBe(
      '```mermaid center\nflowchart LR\n  X --> Y\n```\n'
    )
  })

  it('keeps the fence marker and other meta when toggling center', () => {
    expect(rebuildMermaidFence('````mermaid [流程]\nA-->B\n````', true)).toBe(
      '````mermaid center [流程]\nA-->B\n````'
    )
    expect(rebuildMermaidFence('~~~mermaid center [流程]\nA-->B\n~~~', false)).toBe(
      '~~~mermaid [流程]\nA-->B\n~~~'
    )
    expect(rebuildMermaidFence('```mermaid\nA-->B\n```', false)).toBe('```mermaid\nA-->B\n```')
  })
})

describe('renderDiagram', () => {
  it.each([
    ['```mermaid\n\n```', 'Mermaid'],
    ['```mindmap\n\n```', '思维导图']
  ])('renders a calm empty-state for a blank %s fence', async (source, label) => {
    const rendered = await renderDiagram(source)
    expect(rendered.node.className).toBe('desk-diagram__empty')
    expect(rendered.node.textContent).toContain(label)
    expect(rendered.activate).toBeUndefined()
  })

  it('renders a fallback card for languages that are not yet rendered', async () => {
    const rendered = await renderDiagram('```markmap\n- A\n- B\n```')
    expect(rendered.node.className).toBe('desk-diagram__fallback')
    expect(rendered.node.textContent).toContain('markmap')
  })

  it('does not throw when mermaid layout is not available (test env)', async () => {
    const rendered = await renderDiagram('```mermaid\nflowchart TD\n  A --> B\n```')
    expect(['desk-diagram__svg', 'desk-diagram__error']).toContain(rendered.node.className)
  })

  it('renders a host node for a mindmap fence (canvas needs a real browser)', async () => {
    const rendered = await renderDiagram('```mindmap\n- 前端\n- 后端\n```')
    expect(['desk-diagram__mindmap', 'desk-diagram__error']).toContain(rendered.node.className)
  })
})
