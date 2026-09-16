import { copyText } from './clipboard'
/**
 * Progressive enhancement for SSR article HTML. The client hydrates chrome
 * (search / theme / sidebar) and leaves the article as static markup; these
 * helpers restore tab / copy / diagram behavior without compiling every note
 * SFC into the client graph.
 */

import { createApp } from 'vue'
import {
  applyCollapseChrome,
  expandCollapsedCodeBlocks,
  isCodeBlockCollapsed,
  toggleCodeBlockCollapsed
} from '@tnotesjs/ui/code'
import { hydrateTnSwipers } from '@tnotesjs/ui/swiper'

export interface HydrateIslandsOptions {
  /** Site base (`/` or `/TNotes.example/`); used to resolve note asset URLs. */
  base?: string
}

/**
 * 笔记里的脑图 fence 保存的是 `./assets/x.png` 这类相对路径，而站点页面在
 * `<base>notes/<slug>`，浏览器会把它解析到 `notes/assets/...` 而 404。Desk 会
 * 注入 resolveImageSrc，站点这边也必须把相对资源解析到站点 base 下。
 */
export function resolveNoteAssetSrc(src: string, base = '/'): string {
  const match = src.match(/^(?:\.\.\/|\.\/)?assets\/(.+)$/)
  if (!match) return src
  const queryAt = match[1].search(/[?#]/)
  const pathPart = queryAt < 0 ? match[1] : match[1].slice(0, queryAt)
  const suffix = queryAt < 0 ? '' : match[1].slice(queryAt)
  const prefix = base.endsWith('/') ? base : `${base}/`
  return `${prefix}assets/${pathPart}${suffix}`
}

function decodeData(value: string | undefined): string {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function hydrateCodeGroups(root: ParentNode): void {
  for (const group of root.querySelectorAll<HTMLElement>('.tn-code-group')) {
    if (group.dataset.tnReady === '1') continue
    group.dataset.tnReady = '1'
    // 只认 tab：tab 行最左侧还有折叠 Icon，不能按「里面所有 button」取。
    const tabs = [
      ...group.querySelectorAll<HTMLButtonElement>(
        ':scope > .tn-code-group__tabs button[role="tab"], :scope > .code-group-tabs button[role="tab"]'
      )
    ]
    const panels = [
      ...group.querySelectorAll<HTMLElement>(
        ':scope > .tn-code-group__panels > .tn-code-group__panel, :scope > .code-group-panels > .tn-code-group__panel'
      )
    ]
    if (tabs.length === 0 || panels.length === 0) continue

    const collapseBtn = group.querySelector<HTMLButtonElement>(
      ':scope > .tn-code-group__tabs .tn-code-group__collapse-btn, :scope > .code-group-tabs .tn-code-group__collapse-btn'
    )
    const activeBlock = (index: number): HTMLElement | null =>
      panels[index]?.querySelector<HTMLElement>('.tn-code-block') ?? null
    let current = 0

    const activate = (index: number) => {
      current = index
      tabs.forEach((tab, i) => {
        const on = i === index
        tab.classList.toggle('active', on)
        tab.setAttribute('aria-selected', on ? 'true' : 'false')
        tab.tabIndex = on ? 0 : -1
      })
      panels.forEach((panel, i) => {
        const on = i === index
        panel.classList.toggle('active', on)
        panel.hidden = !on
        panel.style.display = on ? '' : 'none'
      })
      // 切到的面板若是收起状态，自动展开：读者不该看到一片被裁掉的代码。
      expandCollapsedCodeBlocks(panels[index] ?? null)
      if (collapseBtn) {
        applyCollapseChrome(collapseBtn, isCodeBlockCollapsed(activeBlock(index)))
      }
    }

    collapseBtn?.addEventListener('click', () => {
      const block = activeBlock(current)
      if (!block) return
      toggleCodeBlockCollapsed(block)
      applyCollapseChrome(collapseBtn, isCodeBlockCollapsed(block))
    })

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(index))
      tab.addEventListener('keydown', (event) => {
        let next = index
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = tabs.length - 1
        else return
        event.preventDefault()
        activate(next)
        tabs[next]?.focus()
      })
    })

    // SSR slot content has no v-show — hide all but the active panel now.
    const initial = tabs.findIndex(
      (tab) => tab.classList.contains('active') || tab.getAttribute('aria-selected') === 'true'
    )
    activate(initial < 0 ? 0 : initial)
  }
}

function hydrateCodeBlocks(root: ParentNode): void {
  for (const host of root.querySelectorAll<HTMLElement>('[data-tn-code]')) {
    if (host.dataset.tnReady === '1') continue
    host.dataset.tnReady = '1'
    const code = decodeData(host.dataset.tnCode).replace(/\n$/, '')
    const block = host.querySelector('.tn-code-block')
    const header = block?.querySelector(':scope > .tn-code-block__header')
    // 按类名取，别按顺序：标题左侧还可能有折叠 Icon。
    const collapseBtn = header?.querySelector<HTMLButtonElement>('.tn-code-block__collapse-btn')
    const copyBtn = header?.querySelector<HTMLButtonElement>('.tn-code-block__copy-btn')
    const fullBtn = header?.querySelector<HTMLButtonElement>('.tn-code-block__fullscreen-btn')
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        toggleCodeBlockCollapsed(block)
      })
    }
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        void copyText(code).then(() => {
          const previous = copyBtn.getAttribute('aria-label')
          copyBtn.setAttribute('aria-label', '已复制')
          window.setTimeout(() => {
            if (previous) copyBtn.setAttribute('aria-label', previous)
          }, 1500)
        })
      })
    }
    if (fullBtn) {
      fullBtn.addEventListener('click', () => openCodeFullscreen(block, code))
    }
  }
}

function openCodeFullscreen(block: Element | null, code: string): void {
  const existing = document.querySelector('.tn-code-fullscreen')
  existing?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'tn-code-fullscreen'
  overlay.tabIndex = -1
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', '代码全屏预览')
  const title =
    block?.querySelector('.tn-code-block__title')?.textContent?.trim() ||
    block?.querySelector('.tn-code-block__language')?.textContent?.trim() ||
    'code'
  const content =
    block?.querySelector('.tn-code-block__content')?.innerHTML ??
    `<pre><code>${escapeHtml(code)}</code></pre>`
  overlay.innerHTML = `<header><span>${escapeHtml(title)}</span><button type="button">关闭（Esc）</button></header><div class="tn-code-block">${content}</div>`
  const close = () => overlay.remove()
  overlay.querySelector('button')?.addEventListener('click', close)
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  document.body.append(overlay)
  overlay.focus({ preventScroll: true })
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const values: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return values[character] ?? character
  })
}

async function hydrateMermaids(root: ParentNode): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-tn-island="mermaid"]')].filter(
    (el) => el.dataset.tnReady !== '1'
  )
  if (!nodes.length) return
  const mermaidMod = await import('@tnotesjs/ui/mermaid')
  const Mermaid = mermaidMod.default
  for (const el of nodes) {
    el.dataset.tnReady = '1'
    createApp(Mermaid, {
      graph: el.dataset.graph ?? '',
      id: el.dataset.id ?? '',
      center: el.dataset.center === 'true'
    }).mount(el)
  }
}

async function hydrateMindmaps(root: ParentNode, base: string): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-tn-island="mindmap"]')].filter(
    (el) => el.dataset.tnReady !== '1'
  )
  if (!nodes.length) return
  const mindmapMod = await import('@tnotesjs/ui/mindmap')
  const Mindmap = mindmapMod.default
  for (const el of nodes) {
    el.dataset.tnReady = '1'
    const expand = el.dataset.expand
    createApp(Mindmap, {
      content: el.dataset.content ?? '',
      initialExpandLevel: expand === undefined ? undefined : Number(expand),
      // Readers get the same 「层」 control the editor has. The level is a view
      // concern — `applyInitialExpandLevel` drives the session — so a read-only
      // canvas can offer it without writing anything back to the note.
      expandLevelControl: true,
      resolveImageSrc: (src: string) => resolveNoteAssetSrc(src, base)
    }).mount(el)
  }
}

export async function hydrateIslands(
  root: ParentNode = document,
  options: HydrateIslandsOptions = {}
): Promise<void> {
  hydrateCodeGroups(root)
  hydrateCodeBlocks(root)
  hydrateTnSwipers(root)
  await Promise.all([hydrateMermaids(root), hydrateMindmaps(root, options.base ?? '/')])
}
