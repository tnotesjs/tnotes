import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const prose = readFileSync(join(process.cwd(), '../../packages/ui/src/styles/prose.css'), 'utf8')
const CARD = '.cm-lp-card .tn-custom-block'

function scopeOf(target: string): string | undefined {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return prose.match(new RegExp(`^:is\\(([^)]*)\\) :where\\(${escaped}\\) \\{`, 'm'))?.[1]
}

describe('prose scope inside ::: container cards', () => {
  it.each(['table', 'th, td', 'th', ':not(pre) > code', 'ul, ol', 'blockquote', 'hr'])(
    'styles %s like body content',
    (target) => {
      expect(scopeOf(target)).toContain(CARD)
    }
  )

  it('leaves paragraph and heading rhythm to the card itself', () => {
    expect(scopeOf('p')).not.toContain(CARD)
    expect(scopeOf('h1, h2, h3, h4, h5, h6')).not.toContain(CARD)
  })
})
