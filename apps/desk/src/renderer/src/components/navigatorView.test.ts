// @vitest-environment happy-dom

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { isConfiguredIde } from './configuredIde'
import { readNavigatorView, setNavigatorView } from './navigatorView'

const STORAGE_KEY = 'tnotes-desk-navigator-view'

/**
 * Node 26 的 `globalThis.localStorage` 在没有 `--localstorage-file` 时一访问就抛错，
 * happy-dom 也替换不掉这个 getter。产品代码遇到这种情况会退回笔记目录。
 * 这里换成一块只属于本文件的内存存储，让「写入后再读回」测的是视图记忆本身。
 */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }

  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.items.delete(String(key))
  }

  setItem(key: string, value: string): void {
    this.items.set(String(key), String(value))
  }
}

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

function installStorage(): Storage {
  const storage = new MemoryStorage()
  const descriptor: PropertyDescriptor = {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage
  }
  Object.defineProperty(globalThis, 'localStorage', descriptor)
  if (typeof window !== 'undefined' && window !== (globalThis as unknown as Window)) {
    Object.defineProperty(window, 'localStorage', descriptor)
  }
  return storage
}

beforeEach(() => {
  installStorage()
})

afterAll(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
  else delete globalThis.localStorage
})

describe('isConfiguredIde', () => {
  it('只把用户选过的 Cursor 或 VS Code 当成已配置', () => {
    expect(isConfiguredIde('cursor')).toBe(true)
    expect(isConfiguredIde('vscode')).toBe(true)
    expect(isConfiguredIde(null)).toBe(false)
    expect(isConfiguredIde(undefined)).toBe(false)
    expect(isConfiguredIde('')).toBe(false)
  })
})

describe('navigatorView', () => {
  it('defaults to the note TOC on first use', () => {
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(readNavigatorView()).toBe('toc')
  })

  it('remembers the last view and ignores unknown values', () => {
    setNavigatorView('git')
    expect(readNavigatorView()).toBe('git')
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBe('git')

    globalThis.localStorage.setItem(STORAGE_KEY, 'bogus')
    expect(readNavigatorView()).toBe('toc')

    globalThis.localStorage.setItem(STORAGE_KEY, 'files')
    expect(readNavigatorView()).toBe('toc')
  })
})
