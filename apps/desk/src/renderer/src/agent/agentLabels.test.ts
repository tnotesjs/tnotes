import { describe, expect, it } from 'vitest'

import { selectionLabel, selectionLabelParts } from './agentLabels'

const item = {
  fileName: '0002. 111.md',
  startLine: 3,
  endLine: 5,
  knowledgeBaseId: 'kb-test',
  knowledgeBaseName: 'test'
}

describe('selection labels', () => {
  it('keeps the line range separate from the file name', () => {
    expect(selectionLabelParts(item, 'kb-test')).toEqual({ name: '0002. 111.md', lines: ':3–5' })
    expect(selectionLabel({ ...item, endLine: 3 }, 'kb-test')).toBe('0002. 111.md:3')
  })

  it('prefixes the knowledge base when the selection comes from another one', () => {
    expect(selectionLabel(item, 'kb-other')).toBe('test · 0002. 111.md:3–5')
  })
})
