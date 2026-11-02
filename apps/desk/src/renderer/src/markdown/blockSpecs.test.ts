import { describe, expect, it } from 'vitest'

import { BLOCK_SPECS, blockTypeOfMenuItem, canNest, nestOf } from './blockSpecs'
import { TN_NOTES_SLASH_ITEMS } from './slashMenu'

describe('BlockSpec 嵌套角色', () => {
  it('未登记的块按普通内容处理', () => {
    expect(nestOf('table')).toBe('ordinary')
    expect(nestOf('paragraph')).toBe('ordinary')
    expect(nestOf('tip')).toBe('container')
    expect(nestOf('mermaid')).toBe('topLevel')
  })

  it('文档根下什么都能放', () => {
    for (const spec of BLOCK_SPECS) expect(canNest(null, spec.type)).toBe(true)
  })

  it('容器里只放普通内容：不套容器，也不放顶层特殊块', () => {
    for (const parent of ['tip', 'info', 'warning', 'danger', 'details']) {
      expect(canNest(parent, 'table')).toBe(true)
      expect(canNest(parent, 'tip')).toBe(false)
      expect(canNest(parent, 'details')).toBe(false)
      expect(canNest(parent, 'code')).toBe(false)
      expect(canNest(parent, 'mermaid')).toBe(false)
      expect(canNest(parent, 'excalidraw')).toBe(false)
    }
  })

  it('顶层特殊块不互嵌，白名单父级除外', () => {
    expect(canNest('swiper', 'excalidraw')).toBe(true)
    expect(canNest('code-group', 'code')).toBe(true)
    expect(canNest('swiper', 'mermaid')).toBe(false)
    expect(canNest('code-group', 'tip')).toBe(false)
    expect(canNest('swiper', 'table')).toBe(true)
  })

  it('插入菜单里的每一项都有确定的角色', () => {
    expect(blockTypeOfMenuItem('canvas')).toBe('excalidraw')
    const registered = new Set(BLOCK_SPECS.map((spec) => spec.type))
    for (const item of TN_NOTES_SLASH_ITEMS) {
      expect(registered.has(blockTypeOfMenuItem(item.id)), item.id).toBe(true)
    }
  })
})
