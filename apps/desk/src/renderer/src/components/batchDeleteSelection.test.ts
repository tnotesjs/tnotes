import { describe, expect, it } from 'vitest'

import type { DeskTocNode } from '../../../shared/contracts'
import {
  batchCheckState,
  batchTargetIds,
  collectNoteIds,
  descendantNoteIds,
  toggleBatchIds
} from './batchDeleteSelection'

const child: Extract<DeskTocNode, { type: 'note' }> = {
  type: 'note',
  uuid: 'child',
  title: '子',
  dirName: '0002. 子',
  noteIndex: '0002',
  tocLineIndex: 2,
  nodeId: 'child',
  completed: false,
  children: []
}

const parent: Extract<DeskTocNode, { type: 'note' }> = {
  type: 'note',
  uuid: 'parent',
  title: '父',
  dirName: '0001. 父',
  noteIndex: '0001',
  tocLineIndex: 1,
  nodeId: 'parent',
  completed: false,
  children: [child]
}

const group: Extract<DeskTocNode, { type: 'group' }> = {
  type: 'group',
  title: '分组',
  tocLineIndex: 0,
  nodeId: 'group',
  folderPath: ['分组'],
  children: [parent]
}

describe('批量删除的勾选', () => {
  it('点笔记会连子集一起勾上，再点一次一起取消', () => {
    expect(batchTargetIds(parent)).toEqual(['parent', 'child'])
    expect(batchTargetIds(group)).toEqual(['parent', 'child'])
    expect(collectNoteIds([group])).toEqual(['parent', 'child'])

    const selected = toggleBatchIds(new Set(), batchTargetIds(parent))
    expect(selected).toEqual(new Set(['parent', 'child']))
    expect(batchCheckState(batchTargetIds(parent), selected)).toBe('all')
    expect(batchCheckState(batchTargetIds(parent), new Set(['parent']))).toBe('some')
    expect(toggleBatchIds(selected, batchTargetIds(child))).toEqual(new Set(['parent']))
    expect(toggleBatchIds(selected, batchTargetIds(parent))).toEqual(new Set())
    expect(descendantNoteIds(parent)).toEqual(['child'])
    expect(batchCheckState([], new Set())).toBe('empty')
    expect(toggleBatchIds(new Set(['parent']), [])).toEqual(new Set(['parent']))
  })
})
