import { CanvasViewer, MindmapSession } from '@tnotesjs/mindmap-core'

interface FencedCode {
  lang: string
  code: string
  title: string
  /** Mermaid fence keyword `center` (absent → false). */
  center: boolean
}

/** Extracts the fence language and code body from a full fenced-code source. */
export function parseFencedCode(source: string): FencedCode {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const opening = lines[0]?.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s]*)\s*(.*)$/)
  if (!opening) return { lang: '', code: source, title: '', center: false }
  const lang = opening[2] ?? ''
  const meta = opening[3] ?? ''
  const title = meta.match(/\[([^\]]+)\]/)?.[1]?.trim() ?? ''
  const center = meta.split(/\s+/).some((part) => part.toLowerCase() === 'center')
  const marker = opening[1][0]
  const length = opening[1].length
  let end = lines.length - 1
  while (end > 0 && !new RegExp(`^ {0,3}${marker}{${length},}[ \\t]*$`).test(lines[end])) end -= 1
  return { lang, code: lines.slice(1, end).join('\n'), title, center }
}

/**
 * Rebuild a mermaid fence; toggles the `center` info keyword and/or body.
 * Keeps the original fence marker (``` / ```` / ~~~), indentation and other meta (e.g. `[title]`).
 */
export function rebuildMermaidFence(source: string, center: boolean, body?: string): string {
  const parsed = parseFencedCode(source)
  const trailingNewline = /\r?\n$/.test(source)
  const firstLine = source.replace(/\r\n?/g, '\n').split('\n')[0] ?? ''
  const opening = firstLine.match(/^( {0,3})(`{3,}|~{3,})\s*([^\s]*)\s*(.*)$/)
  const indent = opening?.[1] ?? ''
  const marker = opening?.[2] ?? '```'
  const lang = opening?.[3] || 'mermaid'
  const meta = (opening?.[4] ?? '')
    .split(/\s+/)
    .filter((part) => part && part.toLowerCase() !== 'center')
  if (center) meta.unshift('center')
  const info = [lang, ...meta].join(' ')
  const code = body ?? parsed.code
  const fence = `${indent}${marker}${info}\n${code}\n${indent}${marker}`
  return trailingNewline ? `${fence}\n` : fence
}

type MermaidInstance = {
  initialize(config: Record<string, unknown>): void
  render(id: string, code: string): Promise<{ svg: string }>
}

let mermaidModule: Promise<MermaidInstance> | null = null

function loadMermaid(): Promise<MermaidInstance> {
  mermaidModule ??= import('mermaid').then(
    (module) =>
      (module as { default?: MermaidInstance }).default ?? (module as unknown as MermaidInstance)
  )
  return mermaidModule
}

let diagramCounter = 0

function renderError(message: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'desk-diagram__error'
  el.textContent = `图表渲染失败：${message}`
  return el
}

function renderEmpty(label: string): HTMLElement {
  const empty = document.createElement('div')
  empty.className = 'desk-diagram__empty'
  empty.textContent = `输入 ${label} 源码后显示预览`
  return empty
}

function wrapSvg(svg: string): HTMLElement {
  const host = document.createElement('div')
  host.className = 'desk-diagram__svg'
  // Mermaid 11 emits a sanitized SVG (securityLevel: 'strict') that relies on an
  // inline <style> block for label/colour CSS. DOMPurify strips that <style>, so
  // we insert the SVG untouched to keep node captions & theme colours visible.
  host.innerHTML = svg
  return host
}

export interface RenderedDiagram {
  node: HTMLElement
  activate?: (host: HTMLElement) => void
  destroy?: () => void
}

function normalizeMindmapMarkdown(source: string, title?: string): string {
  const rootTitle = title?.trim() || 'root'
  const body = source.trim()
  return body ? `# ${rootTitle}\n\n${body}\n` : `# ${rootTitle}\n`
}

function renderFallback(lang: string): HTMLElement {
  const fallback = document.createElement('div')
  fallback.className = 'desk-diagram__fallback'
  fallback.textContent = `${lang || '代码'}（图表渲染待支持）`
  return fallback
}

async function renderMermaid(source: string): Promise<RenderedDiagram> {
  const { code } = parseFencedCode(source)
  if (!code.trim()) return { node: renderEmpty('Mermaid') }
  try {
    const mermaid = await loadMermaid()
    const isDark = document.documentElement.dataset.theme === 'dark'
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: isDark ? 'dark' : 'default'
    })
    const id = `desk-mermaid-${++diagramCounter}`
    const { svg } = await mermaid.render(id, code)
    return { node: wrapSvg(svg) }
  } catch (cause) {
    return { node: renderError(cause instanceof Error ? cause.message : String(cause)) }
  }
}

function renderMindmap(source: string): RenderedDiagram {
  const { code, title } = parseFencedCode(source)
  if (!code.trim()) return { node: renderEmpty('思维导图') }
  const node = document.createElement('div')
  node.className = 'desk-diagram__mindmap'
  let viewer: CanvasViewer | null = null
  let resizeObserver: ResizeObserver | null = null
  const zoomTimers: Array<ReturnType<typeof setTimeout>> = []
  return {
    node,
    // Create the canvas only after the host has been attached to the DOM so it
    // has real dimensions (CanvasViewer reads clientWidth/clientHeight).
    activate: (host: HTMLElement) => {
      try {
        const session = new MindmapSession({
          markdown: normalizeMindmapMarkdown(code, title),
          fileName: 'mindmap-preview.tn-mindmap.md'
        })
        viewer = new CanvasViewer(host, session, {
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
        })
        // The controller's own zoomToFit can race the layout; re-fit whenever
        // the host settles and after a few delays so the tree ends up centered.
        const fit = (): void => viewer?.zoomToFit()
        resizeObserver = new ResizeObserver(() => fit())
        resizeObserver.observe(host)
        ;[120, 500, 1200].forEach((delay) => zoomTimers.push(setTimeout(fit, delay)))
      } catch (cause) {
        host.replaceChildren(renderError(cause instanceof Error ? cause.message : String(cause)))
      }
    },
    destroy: () => {
      resizeObserver?.disconnect()
      resizeObserver = null
      zoomTimers.forEach((timer) => clearTimeout(timer))
      zoomTimers.length = 0
      viewer?.destroy()
      viewer = null
    }
  }
}

/**
 * Renders a diagram fence into a DOM node. Rendering is async; on failure a
 * readable error card is returned instead of throwing. Mindmap uses the core's
 * canvas viewer (canvas output must be verified in a real browser).
 */
export async function renderDiagram(source: string): Promise<RenderedDiagram> {
  const { lang } = parseFencedCode(source)
  if (lang === 'mermaid') return renderMermaid(source)
  if (lang === 'mindmap') return renderMindmap(source)
  return { node: renderFallback(lang) }
}
