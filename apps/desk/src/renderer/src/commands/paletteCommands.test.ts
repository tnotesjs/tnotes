import { describe, expect, it } from 'vitest'

import {
  createPaletteCommands,
  filterPaletteCommands,
  isCommandMode,
  matchesQuery
} from './paletteCommands'

const commands = createPaletteCommands({
  saveDocument: async () => undefined,
  openSettings: () => undefined,
  openKbSettings: () => undefined,
  openKbAssets: () => undefined,
  hasSelectedKnowledgeBase: () => true,
  toggleTerminal: () => {}
})

describe('palette commands', () => {
  it('treats a leading > as command mode', () => {
    expect(isCommandMode('>fold')).toBe(true)
    expect(isCommandMode('fold')).toBe(false)
  })

  it('filters fold commands by title or keyword', () => {
    expect(filterPaletteCommands(commands, '>全部折叠').map((command) => command.id)).toEqual([
      'fold-all'
    ])
    expect(filterPaletteCommands(commands, '>全部展开').map((command) => command.id)).toEqual([
      'unfold-all'
    ])
    expect(
      filterPaletteCommands(commands, '>2').some((command) => command.id === 'fold-level-2')
    ).toBe(true)
    expect(filterPaletteCommands(commands, '>Unfold Level 3').map((command) => command.id)).toEqual(
      ['unfold-level-3']
    )
    expect(
      filterPaletteCommands(commands, '>Fold Level 1').map((command) => command.hint)
    ).toContain('Fold Level 1')
  })

  it('matches queries as substrings or subsequences', () => {
    expect(matchesQuery('全部折叠标题', '折叠')).toBe(true)
    expect(matchesQuery('fold all headings', 'fal')).toBe(true)
    expect(matchesQuery('fold all headings', 'xyz')).toBe(false)
  })
})
