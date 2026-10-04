import type { TabShortcutCommand } from '../shared/contracts'

type ShortcutInput = Pick<
  Electron.Input,
  'type' | 'key' | 'code' | 'shift' | 'control' | 'alt' | 'meta' | 'isComposing'
>

export interface TabShortcutResolution {
  handled: boolean
  command: TabShortcutCommand | null
}

function isPrimaryModifier(input: ShortcutInput, platform: NodeJS.Platform): boolean {
  return platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
}

/** Shift / Option 自己的按下不是组合键的第二下，不能把还没按完的 ⌘K 清掉。 */
function isModifierOnly(key: string): boolean {
  return (
    key === 'shift' ||
    key === 'control' ||
    key === 'alt' ||
    key === 'meta' ||
    key === 'capslock' ||
    key === 'fn'
  )
}

/**
 * macOS 按住 Option 时 `key` 会变成 ç、® 这类字符，物理键仍在 `code`（KeyC）。
 * 没带 code 时退回 `key`，单测和 Windows 都走这条。
 */
/** macOS 在 Option 下把字母换成 ç、®；没带 code 时用这张表认回物理键。 */
const OPTION_LETTER: Record<string, string> = {
  ç: 'c',
  '®': 'r'
}

function letterKey(input: ShortcutInput): string {
  const fromCode = /^Key([A-Z])$/.exec(input.code ?? '')
  if (fromCode) return fromCode[1].toLowerCase()
  const key = input.key.toLowerCase()
  return OPTION_LETTER[input.key] ?? OPTION_LETTER[key] ?? key
}

function isEnterKey(input: ShortcutInput): boolean {
  const key = input.key.toLowerCase()
  return key === 'enter' || key === 'return' || input.code === 'Enter' || input.code === 'NumpadEnter'
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
    const letter = letterKey(input)
    const primaryModifier = isPrimaryModifier(input, platform)

    if (this.chordExpiresAt > now && isModifierOnly(key)) {
      return { handled: false, command: null }
    }

    if (primaryModifier && !input.alt && !input.shift && /^[1-9]$/.test(key)) {
      this.chordExpiresAt = 0
      return { handled: true, command: { type: 'activate-tab-by-number', number: Number(key) } }
    }

    if (primaryModifier && !input.alt && letter === 'p') {
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
      if (!input.alt && input.shift && isEnterKey(input)) {
        return { handled: true, command: 'toggle-pin-active-tab' }
      }
      if (!input.alt && !input.shift && letter === 'v') {
        return { handled: true, command: 'toggle-note-view' }
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
    if (primaryModifier && input.alt && !input.shift && letter === 'c') {
      return { handled: true, command: 'copy-active-note-path' }
    }
    if (primaryModifier && input.alt && !input.shift && letter === 'r') {
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
