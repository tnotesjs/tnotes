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
  toggleTerminal: () => {},
  theme: 'dark',
  setTheme: () => undefined
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

  it('lists the three theme choices and marks the current one', () => {
    const themes = filterPaletteCommands(commands, '>主题')
    expect(themes.map((command) => command.title)).toEqual([
      '主题：跟随系统',
      '主题：浅色',
      '主题：深色'
    ])
    expect(themes.find((command) => command.id === 'theme-dark')?.hint).toBe('当前')
    expect(themes.find((command) => command.id === 'theme-light')?.hint).toBe('Light')
  })

  it('matches queries as substrings or subsequences', () => {
    expect(matchesQuery('全部折叠标题', '折叠')).toBe(true)
    expect(matchesQuery('fold all headings', 'fal')).toBe(true)
    expect(matchesQuery('fold all headings', 'xyz')).toBe(false)
  })
})
