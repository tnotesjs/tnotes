import { describe, expect, it } from 'vitest'

import { noteFromTocDrag } from './tocDrag'

import type { DeskTocNode } from './contracts'

const note: Extract<DeskTocNode, { type: 'note' }> = {
  type: 'note',
  uuid: 'note-a',
  title: '第一篇',
  dirName: '0001. 第一篇',
  noteIndex: '0001',
  tocLineIndex: 1,
  nodeId: 'note-a',
  completed: false,
  children: []
}

function transfer(node: DeskTocNode | null): DataTransfer {
  const raw = node ? JSON.stringify(node) : ''
  return {
    getData: () => raw
  } as unknown as DataTransfer
}

describe('拖进置顶组', () => {
  it('笔记可以放下，分组不行', () => {
    expect(noteFromTocDrag(transfer(note))?.uuid).toBe('note-a')
    expect(
      noteFromTocDrag(
        transfer({
          type: 'group',
          title: '分组',
          tocLineIndex: 0,
          nodeId: 'group-a',
          folderPath: ['分组'],
          children: []
        })
      )
    ).toBeNull()
    expect(noteFromTocDrag(transfer(null))).toBeNull()
  })
})
