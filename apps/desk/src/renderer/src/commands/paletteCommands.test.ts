import { describe, expect, it } from 'vitest'

import { createCommandHistory } from './commandHistory'
import {
  createPaletteCommands,
  filterPaletteCommands,
  groupPaletteCommands,
  isCommandMode,
  matchesQuery,
  rememberPaletteCommand
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
    expect(filterPaletteCommands(commands, '>重排标题编号').map((command) => command.id)).toEqual([
      'add-heading-numbers'
    ])
    expect(filterPaletteCommands(commands, '>移除标题编号').map((command) => command.id)).toEqual([
      'remove-heading-numbers'
    ])
    expect(
      filterPaletteCommands(commands, '>Fold Level 1').map((command) => command.hint)
    ).toContain('Fold Level 1')
  })

  it('lists the three theme choices and marks the current one', () => {
    const themes = filterPaletteCommands(commands, '>主题', { peek: () => undefined })
    expect(themes.map((command) => command.title)).toEqual(
      ['主题：跟随系统', '主题：浅色', '主题：深色'].sort((left, right) =>
        left.localeCompare(right, 'zh')
      )
    )
    expect(themes.find((command) => command.id === 'theme-dark')?.hint).toBe('当前')
    expect(themes.find((command) => command.id === 'theme-light')?.hint).toBe('Light')
  })

  it('puts the most recent command first, once, and keeps it first while filtering', () => {
    const history = createCommandHistory(null)
    rememberPaletteCommand('open-settings', history)
    rememberPaletteCommand('toggle-terminal', history)
    rememberPaletteCommand('open-settings', history)
    const grouped = groupPaletteCommands(commands, '>', history)
    expect(grouped[0]?.category).toBe('最近使用')
    expect(grouped[0]?.items.map((item) => item.command.id)).toEqual([
      'open-settings',
      'toggle-terminal'
    ])
    expect(grouped[1]?.category).toBe('其他命令')
    expect(grouped.flatMap((group) => group.items.map((item) => item.command.id))).toEqual(
      filterPaletteCommands(commands, '>', history).map((command) => command.id)
    )
    const ids = grouped.flatMap((group) => group.items.map((item) => item.command.id))
    expect(ids.filter((id) => id === 'open-settings')).toHaveLength(1)
    expect(filterPaletteCommands(commands, '>设置', history)[0]?.id).toBe('open-settings')
  })

  it('does not invent a recent group before any command has run', () => {
    const grouped = groupPaletteCommands(commands, '>', { peek: () => undefined })
    expect(grouped.map((group) => group.category)).toEqual([''])
    expect(grouped[0]?.items[0]?.index).toBe(0)
  })

  it('matches queries as substrings or subsequences', () => {
    expect(matchesQuery('全部折叠标题', '折叠')).toBe(true)
    expect(matchesQuery('fold all headings', 'fal')).toBe(true)
    expect(matchesQuery('fold all headings', 'xyz')).toBe(false)
  })
})
