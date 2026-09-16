/** Enhances static article HTML after hydration. State belongs to this reading session. */
export function setupHeadingFolds(root: HTMLElement, changed: (anyCollapsed: boolean) => void) {
  const updates: Array<() => void> = []
  const headings = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]
  const sections: Array<{ heading: HTMLElement; body: HTMLElement; button: HTMLButtonElement }> = []
  const level = (node: Element) =>
    /^H[1-6]$/.test(node.tagName) ? Number(node.tagName.slice(1)) : 0

  // Complete sections absent from the build-time wrappers (adjacent headings,
  // blockquotes and custom containers). Work backwards to retain nested sections.
  for (const heading of [...headings].reverse()) {
    if (heading.nextElementSibling?.classList.contains('tn-heading-body')) continue
    const nodes: ChildNode[] = []
    for (let node = heading.nextSibling; node; node = node.nextSibling) {
      if (node instanceof Element && level(node) && level(node) <= level(heading)) break
      nodes.push(node)
    }
    if (!nodes.some((node) => node.nodeType === 1 || node.textContent?.trim())) continue
    const body = document.createElement('div')
    body.className = 'tn-heading-body'
    heading.after(body)
    body.append(...nodes)
  }

  for (const heading of headings) {
    const body = heading.nextElementSibling
    if (!(body instanceof HTMLElement) || !body.classList.contains('tn-heading-body')) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tn-heading-toggle'
    const label = heading.textContent?.trim() || '章节'
    // Avoid collisions with author-provided anchor ids.
    let id = `tn-heading-body-${sections.length}`
    while (document.getElementById(id)) id += '-section'
    body.id ||= id
    button.setAttribute('aria-controls', body.id)
    button.innerHTML =
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>'
    const update = () => {
      button.setAttribute('aria-expanded', String(!body.hidden))
      button.setAttribute('aria-label', `${body.hidden ? '展开' : '折叠'} ${label}`)
      button.title = `${body.hidden ? '展开' : '折叠'} ${label}`
    }
    update()
    button.onclick = () => {
      body.hidden = !body.hidden
      sync()
    }
    heading.classList.add('tn-foldable-heading')
    heading.prepend(button)
    sections.push({ heading, body, button })
    updates.push(update)
  }

  function sync() {
    updates.forEach((update) => update())
    changed(sections.some((section) => section.body.hidden))
  }
  function reveal(target: Element) {
    for (const section of sections) {
      if (section.body.contains(target) || section.heading === target) section.body.hidden = false
    }
    sync()
  }
  function revealHash() {
    let id: string
    try {
      id = decodeURIComponent(location.hash.slice(1))
    } catch {
      return
    }
    const target = document.getElementById(id)
    if (target && root.contains(target)) reveal(target)
  }
  const onClick = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!(link instanceof HTMLAnchorElement)) return
    const url = new URL(link.href)
    if (url.pathname !== location.pathname || url.origin !== location.origin || !url.hash) return
    try {
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)))
      if (target && root.contains(target)) reveal(target)
    } catch {
      /* malformed author anchor */
    }
  }
  root.addEventListener('click', onClick)
  window.addEventListener('hashchange', revealHash)
  revealHash()
  return {
    toggleAll() {
      const collapse = !sections.some((section) => section.body.hidden)
      sections.forEach((section) => {
        section.body.hidden = collapse
      })
      sync()
    },
    reveal,
    destroy() {
      root.removeEventListener('click', onClick)
      window.removeEventListener('hashchange', revealHash)
      sections.forEach((section) => {
        section.heading.classList.remove('tn-foldable-heading')
        section.button.remove()
        section.body.hidden = false
      })
    }
  }
}
