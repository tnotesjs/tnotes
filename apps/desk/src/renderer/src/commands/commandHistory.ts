/**
 * 命令面板的最近使用，对齐 VS Code `CommandsHistory`：
 * 每条命令一个递增计数，越大越近；再次执行只更新计数，不出现第二次；
 * 默认记住 50 条，并在重启后还在。
 */
const STORAGE_KEY = 'desk.commandPalette.mru'
export const COMMAND_HISTORY_LIMIT = 50

export interface CommandHistoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface CommandHistory {
  peek(commandId: string): number | undefined
  push(commandId: string): void
  clear(): void
}

export function createCommandHistory(
  storage: CommandHistoryStorage | null,
  limit = COMMAND_HISTORY_LIMIT
): CommandHistory {
  const entries = new Map<string, number>()
  let counter = 1

  const persist = (): void => {
    if (!storage) return
    const serialized = {
      counter,
      entries: [...entries.entries()].map(([key, value]) => ({ key, value }))
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(serialized))
  }

  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as {
          counter?: number
          entries?: Array<{ key: string; value: number }>
        }
        for (const entry of parsed.entries ?? []) {
          if (entry.key && Number.isFinite(entry.value)) entries.set(entry.key, entry.value)
        }
        while (entries.size > limit) dropOldest()
        let next = typeof parsed.counter === 'number' ? parsed.counter : 1
        for (const value of entries.values()) next = Math.max(next, value + 1)
        counter = Math.max(1, next)
      }
    } catch {
      entries.clear()
      counter = 1
    }
  }

  function dropOldest(): void {
    let oldest: string | null = null
    let min = Infinity
    for (const [key, value] of entries) {
      if (value < min) {
        min = value
        oldest = key
      }
    }
    if (oldest) entries.delete(oldest)
  }

  return {
    peek(commandId: string): number | undefined {
      return entries.get(commandId)
    },
    push(commandId: string): void {
      if (!commandId) return
      entries.delete(commandId)
      entries.set(commandId, counter)
      counter += 1
      while (entries.size > limit) dropOldest()
      persist()
    },
    clear(): void {
      entries.clear()
      counter = 1
      storage?.removeItem(STORAGE_KEY)
    }
  }
}

function browserStorage(): CommandHistoryStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const commandHistory = createCommandHistory(browserStorage())
