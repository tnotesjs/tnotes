import { describe, expect, it } from 'vitest'

import { resolveTabShortcut, TabShortcutResolver } from './tabShortcuts'

function input(overrides: Partial<Electron.Input> = {}): Electron.Input {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...overrides
  }
}

describe('tab shortcuts', () => {
  it('maps unmodified primary+1…9 to one-based tab positions on each platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const modifier = platform === 'darwin' ? { meta: true } : { control: true }
      for (let number = 1; number <= 9; number += 1) {
        const key = String(number)
        expect(resolveTabShortcut(input({ key, ...modifier }), platform)).toEqual({
          type: 'activate-tab-by-number',
          number
        })
        for (const extra of [
          { shift: true },
          { alt: true },
          { meta: true, control: true },
          { isComposing: true },
          { type: 'keyUp' as const }
        ]) {
          expect(resolveTabShortcut(input({ key, ...modifier, ...extra }), platform)).toBeNull()
        }
        expect(resolveTabShortcut(input({ key }), platform)).toBeNull()
      }
      expect(resolveTabShortcut(input({ key: '0', ...modifier }), platform)).toBe('reset-app-zoom')
    }
    expect(resolveTabShortcut(input({ key: '1', control: true }), 'darwin')).toBeNull()
    expect(resolveTabShortcut(input({ key: '1', meta: true }), 'win32')).toBeNull()
  })

  it('cancels a pending chord when a numbered tab shortcut is used', () => {
    const resolver = new TabShortcutResolver()
    resolver.resolve(input({ key: 'k', meta: true }), 'darwin', 100)
    expect(resolver.resolve(input({ key: '2', meta: true }), 'darwin', 200).command).toEqual({
      type: 'activate-tab-by-number',
      number: 2
    })
    expect(resolver.resolve(input({ key: 'u' }), 'darwin', 300).handled).toBe(false)
  })

  it('handles app zoom before Electron page zoom, including shifted plus and numpad keys', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const modifier = platform === 'darwin' ? { meta: true } : { control: true }
      for (const key of ['+', '=']) {
        for (const shift of [false, true]) {
          expect(resolveTabShortcut(input({ key, shift, ...modifier }), platform)).toBe(
            'increase-app-zoom'
          )
        }
      }
      expect(resolveTabShortcut(input({ key: '-', ...modifier }), platform)).toBe(
        'decrease-app-zoom'
      )
      expect(resolveTabShortcut(input({ key: '0', ...modifier }), platform)).toBe('reset-app-zoom')
      expect(resolveTabShortcut(input({ key: '+', alt: true, ...modifier }), platform)).toBeNull()
      expect(
        resolveTabShortcut(input({ key: '+', isComposing: true, ...modifier }), platform)
      ).toBeNull()
      expect(
        resolveTabShortcut(input({ key: '+', type: 'keyUp', ...modifier }), platform)
      ).toBeNull()
      expect(resolveTabShortcut(input({ key: '+' }), platform)).toBeNull()
    }
  })

  it('opens quick search with Command+P and the command palette with Shift', () => {
    expect(resolveTabShortcut(input({ key: 'p', meta: true }), 'darwin')).toBe('open-quick-open')
    expect(resolveTabShortcut(input({ key: 'p', meta: true, shift: true }), 'darwin')).toBe(
      'open-command-palette'
    )
    expect(resolveTabShortcut(input({ key: 'p', control: true }), 'win32')).toBe('open-quick-open')
    expect(resolveTabShortcut(input({ key: 'p', control: true, shift: true }), 'win32')).toBe(
      'open-command-palette'
    )
    expect(resolveTabShortcut(input({ key: 'p', control: true }), 'darwin')).toBeNull()
  })

  it('maps Command+W on macOS and Ctrl+W on Windows', () => {
    expect(resolveTabShortcut(input({ key: 'w', meta: true }), 'darwin')).toBe(
      'close-active-tab-or-window'
    )
    expect(resolveTabShortcut(input({ key: 'w', control: true }), 'win32')).toBe(
      'close-active-tab-or-window'
    )
    expect(resolveTabShortcut(input({ key: 'w', control: true }), 'darwin')).toBeNull()
  })

  it('maps Command+A and Ctrl+A to in-editor select-all', () => {
    expect(resolveTabShortcut(input({ key: 'a', meta: true }), 'darwin')).toEqual({
      type: 'select-all'
    })
    expect(resolveTabShortcut(input({ key: 'a', control: true }), 'win32')).toEqual({
      type: 'select-all'
    })
    expect(resolveTabShortcut(input({ key: 'a', control: true }), 'darwin')).toBeNull()
    expect(resolveTabShortcut(input({ key: 'a', meta: true, shift: true }), 'darwin')).toBeNull()
  })

  it('cycles tabs forward and backward with Control+Tab', () => {
    expect(resolveTabShortcut(input({ key: 'Tab', control: true }), 'darwin')).toBe('next-tab')
    expect(resolveTabShortcut(input({ key: 'Tab', control: true, shift: true }), 'darwin')).toBe(
      'previous-tab'
    )
  })

  it('supports VS Code-style Command+K chords', () => {
    const resolver = new TabShortcutResolver()
    expect(resolver.resolve(input({ key: 'k', meta: true }), 'darwin', 100)).toEqual({
      handled: true,
      command: null
    })
    expect(resolver.resolve(input({ key: 'u', meta: true }), 'darwin', 200)).toEqual({
      handled: true,
      command: 'close-saved-note-tabs'
    })
    expect(resolver.resolve(input({ key: 'k', meta: true }), 'darwin', 300).handled).toBe(true)
    expect(resolver.resolve(input({ key: 'w', meta: true }), 'darwin', 400).command).toBe(
      'close-all-tabs'
    )
    expect(resolver.resolve(input({ key: 'k', meta: true }), 'darwin', 500).handled).toBe(true)
    expect(
      resolver.resolve(input({ key: 'Enter', meta: true, shift: true }), 'darwin', 600).command
    ).toBe('toggle-pin-active-tab')
  })

  it('copies and reveals the active note with VS Code platform shortcuts', () => {
    expect(resolveTabShortcut(input({ key: 'c', meta: true, alt: true }), 'darwin')).toBe(
      'copy-active-note-path'
    )
    expect(resolveTabShortcut(input({ key: 'r', meta: true, alt: true }), 'darwin')).toBe(
      'reveal-active-note-in-file-manager'
    )
    expect(resolveTabShortcut(input({ key: 'c', control: true, alt: true }), 'win32')).toBe(
      'copy-active-note-path'
    )
  })

  it('ignores key-up, composing and unrelated modified input', () => {
    expect(resolveTabShortcut(input({ type: 'keyUp', key: 'w', meta: true }), 'darwin')).toBeNull()
    expect(
      resolveTabShortcut(input({ key: 'Tab', control: true, isComposing: true }), 'darwin')
    ).toBeNull()
    expect(resolveTabShortcut(input({ key: 'Tab', control: true, alt: true }), 'darwin')).toBeNull()
  })
})
