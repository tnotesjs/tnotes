import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  collapsedByDefaultKeys,
  filterSidebarKeys,
  noteNumber,
  sidebarGroupKeys,
  sidebarNotes
} from '../src/client/navigation'

const items = [
  { text: '第一组', items: [{ text: '两数之和', index: '0001', link: '/notes/1' }] },
  {
    text: '第二组',
    items: [
      { text: '整数反转', index: '0007', link: '/notes/7' },
      { text: '长标题', index: '0070', link: '/notes/70' }
    ]
  }
]
describe('directory filtering', () => {
  it('preserves original positions and ancestors', () => {
    expect([...filterSidebarKeys(items, '反转')!].sort()).toEqual(['1', '1/0'])
  })
  it('treats zero-padded and plain note numbers equally', () => {
    expect(filterSidebarKeys(items, '7')).toEqual(filterSidebarKeys(items, '0007'))
    expect([...filterSidebarKeys(items, '7')!]).not.toContain('1/1')
  })
  it('shows a matching group and its descendants', () => {
    expect([...filterSidebarKeys(items, '第二组')!].sort()).toEqual(['1', '1/0', '1/1'])
  })
  it('distinguishes cleared filter and no matches', () => {
    expect(filterSidebarKeys(items, ' ')).toBeNull()
    expect(filterSidebarKeys(items, '不存在')?.size).toBe(0)
  })
})
it('collects nested notes for exact numeric lookup', () => {
  expect(sidebarNotes(items).map((item) => item.index)).toEqual(['0001', '0007', '0070'])
  expect(noteNumber('/notes/7')).toBe('0007')
  expect(noteNumber('/')).toBe('')
})
describe('default fold', () => {
  it('keeps the branch holding the current note open and closes the rest', () => {
    expect(collapsedByDefaultKeys(items, '/notes/7')).toEqual(['0'])
  })
  it('closes every group when the current note is nowhere in the tree', () => {
    expect(collapsedByDefaultKeys(items, '/notes/999')).toEqual(['0', '1'])
  })
  it('walks past the groups above the current note', () => {
    const nested = [
      { text: '外层', items: [{ text: '内层', items: [{ text: '笔记', link: '/notes/1' }] }] }
    ]
    expect(collapsedByDefaultKeys(nested, '/notes/1')).toEqual([])
    expect(collapsedByDefaultKeys(nested, '/notes/2')).toEqual(['0', '0/0'])
  })
  it('opens the current group itself when the group carries the link', () => {
    const linked = [{ text: '组', link: '/notes/1', items: [{ text: '笔记', link: '/notes/2' }] }]
    expect(collapsedByDefaultKeys(linked, '/notes/1')).toEqual([])
    expect(collapsedByDefaultKeys(linked, '/notes/2')).toEqual([])
  })
  it('matches through the decorations the tree also ignores', () => {
    expect(collapsedByDefaultKeys(items, '/notes/7.md')).toEqual(['0'])
    expect(collapsedByDefaultKeys(items, '/notes/7/')).toEqual(['0'])
  })
})
describe('collapse-everything keys', () => {
  it('lists every node that can hold children, outermost first', () => {
    // Leaves are absent: a note row has nothing to fold.
    expect(sidebarGroupKeys(items)).toEqual(['0', '1'])
  })
  it('descends through nested groups', () => {
    const nested = [
      { text: '组', items: [{ text: '子组', items: [{ text: '笔记', link: '/notes/1' }] }] }
    ]
    expect(sidebarGroupKeys(nested)).toEqual(['0', '0/0'])
  })
  it('finds nothing to collapse in a flat tree or an empty child list', () => {
    expect(sidebarGroupKeys([{ text: '笔记', link: '/notes/1' }])).toEqual([])
    expect(sidebarGroupKeys([{ text: '空组', items: [] }])).toEqual([])
  })
})
it('bounds persisted and keyboard-selected widths', () => {
  expect(clampSidebarWidth(100)).toBe(220)
  expect(clampSidebarWidth(900)).toBe(420)
  expect(clampSidebarWidth(NaN)).toBe(272)
})
