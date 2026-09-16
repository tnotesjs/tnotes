import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ProseMirror's virtual-cursor sets `caret-color: transparent` on the whole
 * document, and `milkdownMarkdownEditor.scoped.css` restores a visible caret for
 * the mindmap island's text surfaces. A surface missing from that list is
 * silently un-typeable-looking: the field focuses and the arrow keys work, but
 * no caret is drawn.
 *
 * Pinned as a CSS contract because the desk size makes a mounted reproduction
 * expensive, and because the regression is invisible to every other test.
 */
const css = readFileSync(join(__dirname, 'milkdownMarkdownEditor.scoped.css'), 'utf8')

describe('mindmap island caret visibility', () => {
  it('restores the caret for the chrome’s native inputs, not just contenteditable', () => {
    expect(css).toMatch(/\.desk-raw-block--mindmap input:not\(\[type='checkbox'\]\)/)
    expect(css).toMatch(/caret-color:\s*var\(--accent-strong/)
  })

  it('never restores a caret through a bare element or universal selector', () => {
    // The regression this guards against is a blanket rule (a bare `input`, `*`)
    // fighting the virtual cursor editor-wide. Naming the surface — any class or
    // `:deep(...)` — is what keeps it local, so that is the only shape rejected.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const offenders: string[] = []
    for (
      let at = stripped.indexOf('caret-color');
      at !== -1;
      at = stripped.indexOf('caret-color', at + 1)
    ) {
      const declaration = stripped.slice(at, stripped.indexOf(';', at))
      if (/transparent/.test(declaration)) continue // hiding the caret is deliberate
      const blockStart = stripped.lastIndexOf('}', at) + 1
      const selector = stripped.slice(blockStart, stripped.indexOf('{', at))
      const scoped = /[.:#[]/.test(selector.replace(/^\.milkdown-markdown-editor/, ''))
      if (!scoped) offenders.push(selector.trim())
    }
    expect(offenders).toEqual([])
  })
})
