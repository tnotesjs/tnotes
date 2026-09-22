import type { TabShortcutCommand } from '../shared/contracts'

type ShortcutInput = Pick<
  Electron.Input,
  'type' | 'key' | 'shift' | 'control' | 'alt' | 'meta' | 'isComposing'
>

export interface TabShortcutResolution {
  handled: boolean
  command: TabShortcutCommand | null
}

function isPrimaryModifier(input: ShortcutInput, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
}

export class TabShortcutResolver {
  private chordExpiresAt = 0

  resolve(
    input: ShortcutInput,
    platform: NodeJS.Platform = process.platform,
    now = Date.now()
  ): TabShortcutResolution {
    if (input.type !== 'keyDown' || input.isComposing) return { handled: false, command: null }
    const key = input.key.toLowerCase()
    const primaryModifier = isPrimaryModifier(input, platform)

    if (primaryModifier && !input.alt && !input.shift && /^[1-9]$/.test(key)) {
      this.chordExpiresAt = 0
      return { handled: true, command: { type: 'activate-tab-by-number', number: Number(key) } }
    }

    if (primaryModifier && !input.alt && key === 'p') {
      this.chordExpiresAt = 0
      return { handled: true, command: input.shift ? 'open-command-palette' : 'open-quick-open' }
    }

    if (primaryModifier && !input.alt) {
      const command =
        key === '+' || key === '='
          ? 'increase-app-zoom'
          : key === '-'
            ? 'decrease-app-zoom'
            : key === '0' && !input.shift
              ? 'reset-app-zoom'
              : null
      if (command) {
        this.chordExpiresAt = 0
        return { handled: true, command }
      }
    }

    if (this.chordExpiresAt > now) {
      this.chordExpiresAt = 0
      if (!input.alt && !input.shift && key === 'u') {
        return { handled: true, command: 'close-saved-note-tabs' }
      }
      if (!input.alt && !input.shift && key === 'w') {
        return { handled: true, command: 'close-all-tabs' }
      }
      if (!input.alt && key === 'enter') {
        return {
          handled: true,
          command: input.shift ? 'toggle-pin-active-tab' : 'keep-active-tab-open'
        }
      }
      if (!input.alt && !input.shift && key === 'v') {
        return { handled: true, command: 'toggle-note-view' }
      }
      if (!input.alt && !input.shift && key === 'p') {
        return { handled: true, command: 'pin-current-selection' }
      }
    } else {
      this.chordExpiresAt = 0
    }

    if (primaryModifier && !input.alt && !input.shift && key === 'k') {
      this.chordExpiresAt = now + 1500
      return { handled: true, command: null }
    }
    if (primaryModifier && !input.alt && !input.shift && key === 'w') {
      return { handled: true, command: 'close-active-tab-or-window' }
    }
    if (primaryModifier && !input.alt && !input.shift && key === 'a') {
      return { handled: true, command: { type: 'select-all' } }
    }
    if (primaryModifier && input.alt && !input.shift && key === 'c') {
      return { handled: true, command: 'copy-active-note-path' }
    }
    if (primaryModifier && input.alt && !input.shift && key === 'r') {
      return { handled: true, command: 'reveal-active-note-in-file-manager' }
    }
    if (input.control && !input.meta && !input.alt && key === 'tab') {
      return { handled: true, command: input.shift ? 'previous-tab' : 'next-tab' }
    }
    return { handled: false, command: null }
  }
}

export function resolveTabShortcut(
  input: ShortcutInput,
  platform: NodeJS.Platform = process.platform
): TabShortcutCommand | null {
  return new TabShortcutResolver().resolve(input, platform).command
}
