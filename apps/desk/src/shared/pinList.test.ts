import { describe, expect, it } from 'vitest'

import { flatPinnedNotes, pinToFront, prunePinIds, unpinId } from './pinList'

import type { DeskTocNode } from './contracts'

const child: Extract<DeskTocNode, { type: 'note' }> = {
  type: 'note',
  uuid: 'child',
  title: '子笔记',
  dirName: '0002. 子笔记',
  noteIndex: '0002',
  tocLineIndex: 2,
  nodeId: 'child',
  completed: false,
  children: []
}

const parent: Extract<DeskTocNode, { type: 'note' }> = {
  type: 'note',
  uuid: 'parent',
  title: '父笔记',
  dirName: '0001. 父笔记',
  noteIndex: '0001',
  tocLineIndex: 1,
  nodeId: 'parent',
  completed: true,
  children: [child]
}

describe('置顶顺序', () => {
  it('新置顶的排到最前，其余顺序保持不变', () => {
    expect(pinToFront(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
    expect(pinToFront(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(unpinId(['b', 'a', 'c'], 'a')).toEqual(['b', 'c'])
  })

  it('打开列表时丢掉已经不存在的 id，不改顺序', () => {
    expect(prunePinIds(['gone', 'a', 'a', 'b'], new Set(['b', 'a']))).toEqual(['a', 'b'])
  })

  it('笔记置顶按顺序平铺，不带出子笔记，目录里没有的丢掉', () => {
    const pinned = flatPinnedNotes([parent], ['missing', 'child', 'parent'])
    expect(pinned.map((node) => node.uuid)).toEqual(['child', 'parent'])
    expect(pinned.every((node) => node.children.length === 0)).toBe(true)
    expect(parent.children).toEqual([child])
  })
})
