import { describe, expect, it } from 'vitest'

import { parseNoteContent, serializeNoteContent, updateNoteFrontmatter } from '../src/frontmatter'

describe('parseNoteContent', () => {
  it('parses whitelisted fields only', () => {
    const { frontmatter, body } = parseNoteContent(
      `---\nid: abc-123\ndescription: 描述\ndraft: true\ntitle: 忽略我\nfoo: 1\n---\n# 正文\n`
    )
    expect(frontmatter).toEqual({ id: 'abc-123', description: '描述' })
    expect(body.trim()).toBe('# 正文')
  })

  it('returns empty frontmatter for plain markdown', () => {
    const { frontmatter, body } = parseNoteContent('# 标题\n\n正文\n')
    expect(frontmatter).toEqual({})
    expect(body).toBe('# 标题\n\n正文\n')
  })

  it('keeps an unquoted numeric description as text', () => {
    const { frontmatter } = parseNoteContent(`---\nid: abc\ndescription: 111\n---\n\n正文\n`)
    expect(frontmatter.description).toBe('111')
    const roundTrip = serializeNoteContent(frontmatter, '正文\n')
    expect(roundTrip).toContain('description: 111\n')
    expect(roundTrip).not.toContain("'111'")
    expect(parseNoteContent(roundTrip).frontmatter.description).toBe('111')
  })

  it('ignores empty strings and unknown keys', () => {
    const { frontmatter } = parseNoteContent(
      `---\nid: ""\ndescription: "  "\ndraft: true\n---\nx\n`
    )
    expect(frontmatter).toEqual({})
  })
})

describe('serializeNoteContent', () => {
  it('writes keys in whitelist order', () => {
    const content = serializeNoteContent({ id: 'abc', description: 'd' }, '# 正文\n')
    expect(content).toBe(`---\nid: abc\ndescription: d\n---\n\n# 正文\n`)
  })

  it('omits the frontmatter block when empty', () => {
    expect(serializeNoteContent({}, '# 正文\n')).toBe('# 正文\n')
  })

  it('skips empty strings', () => {
    expect(serializeNoteContent({ id: 'x', description: '' }, 'b\n')).toBe(`---\nid: x\n---\n\nb\n`)
  })
})

describe('updateNoteFrontmatter', () => {
  it('merges updates and preserves the body', () => {
    const next = updateNoteFrontmatter(`---\nid: old\n---\n\n# 正文\n`, {
      description: '新描述'
    })
    const { frontmatter, body } = parseNoteContent(next)
    expect(frontmatter).toEqual({ id: 'old', description: '新描述' })
    expect(body.trim()).toBe('# 正文')
  })

  it('deletes keys set to undefined/empty/false', () => {
    const next = updateNoteFrontmatter(`---\nid: x\ndescription: d\n---\n\nb\n`, {
      description: ''
    })
    expect(parseNoteContent(next).frontmatter).toEqual({ id: 'x' })
  })
})
