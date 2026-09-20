import { describe, expect, it } from 'vitest'

import type { DeskTocNode } from '../../../shared/contracts'
import {
  baseNameOf,
  buildKbPathSegments,
  buildNoteIndex,
  decideKbPathOpen,
  extensionOf,
  findTocNoteByIndex,
  foldKbPathSegments,
  formatKbEntryBytes,
  isExcalidrawPath,
  isUnderNotesDir,
  looksLikeTextPath,
  noteIndexFromFileName,
  parentDirOf,
  splitKbRelPath
} from './kbPathBreadcrumb'

const noteNode = (
  noteIndex: string,
  uuid: string,
  title: string,
  children: DeskTocNode[] = []
): DeskTocNode => ({
  type: 'note',
  uuid,
  title,
  dirName: `${noteIndex}. ${title}`,
  noteIndex,
  tocLineIndex: 0,
  nodeId: `node-${noteIndex}`,
  completed: false,
  children
})

describe('kb path splitting', () => {
  it('splits posix paths and tolerates backslashes / stray separators', () => {
    expect(splitKbRelPath('notes/0001. a.md')).toEqual(['notes', '0001. a.md'])
    expect(splitKbRelPath('notes\\0001. a.md')).toEqual(['notes', '0001. a.md'])
    expect(splitKbRelPath('/notes//sub/./a.md/')).toEqual(['notes', 'sub', 'a.md'])
    expect(splitKbRelPath('')).toEqual([])
    expect(splitKbRelPath('.')).toEqual([])
  })

  it('derives parent, base name and extension', () => {
    expect(parentDirOf('notes/0001. a.md')).toBe('notes')
    expect(parentDirOf('notes')).toBe('')
    expect(parentDirOf('')).toBe('')
    expect(baseNameOf('a/b/c.txt')).toBe('c.txt')
    expect(baseNameOf('')).toBe('')
    expect(extensionOf('a/b/C.TXT')).toBe('.txt')
    expect(extensionOf('a/b/.gitignore')).toBe('')
    expect(extensionOf('a/b/LICENSE')).toBe('')
    expect(extensionOf('a/b/archive.tar.gz')).toBe('.gz')
  })

  it('builds breadcrumb segments from the knowledge-base root', () => {
    expect(buildKbPathSegments('hello-algo', 'notes/0001. hello-algo.md')).toEqual([
      { label: 'hello-algo', relPath: '', isRoot: true },
      { label: 'notes', relPath: 'notes', isRoot: false },
      { label: '0001. hello-algo.md', relPath: 'notes/0001. hello-algo.md', isRoot: false }
    ])
    expect(buildKbPathSegments('kb', '')).toEqual([{ label: 'kb', relPath: '', isRoot: true }])
  })
})

describe('foldKbPathSegments', () => {
  const segments = buildKbPathSegments('kb', 'a/b/c/d/file.md')

  it('keeps every segment when it fits', () => {
    expect(foldKbPathSegments(segments, segments.length)).toEqual(segments)
    expect(foldKbPathSegments(segments, 99)).toEqual(segments)
  })

  it('folds middle levels into an ellipsis that still carries them', () => {
    const items = foldKbPathSegments(segments, 3)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ label: 'kb', relPath: '' })
    expect(items[items.length - 1]).toMatchObject({
      label: 'file.md',
      relPath: 'a/b/c/d/file.md'
    })
    const ellipsis = items[1]
    expect(ellipsis).toMatchObject({ isEllipsis: true, label: '…' })
    if (!('isEllipsis' in ellipsis)) throw new Error('expected ellipsis')
    expect(ellipsis.hidden.map((segment) => segment.label)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never folds when it cannot keep head + ellipsis + tail', () => {
    expect(foldKbPathSegments(segments, 2)).toEqual(segments)
    expect(foldKbPathSegments(segments, Number.NaN)).toEqual(segments)
  })

  it('keeps as many leading levels as capacity allows', () => {
    const items = foldKbPathSegments(segments, 4)
    expect(items.map((item) => item.label)).toEqual(['kb', 'a', '…', 'file.md'])
  })
})

describe('note index', () => {
  it('reads the four-digit prefix', () => {
    expect(noteIndexFromFileName('0001. hello-algo.md')).toBe('0001')
    expect(noteIndexFromFileName('0042-other.md')).toBe('0042')
    expect(noteIndexFromFileName('0001.md')).toBe('0001')
    expect(noteIndexFromFileName('00012.md')).toBeNull()
    expect(noteIndexFromFileName('readme.md')).toBeNull()
    expect(noteIndexFromFileName('')).toBeNull()
  })

  it('only treats files inside notes/ as note candidates', () => {
    expect(isUnderNotesDir('notes/0001. a.md')).toBe(true)
    expect(isUnderNotesDir('notes/sub/0001. a.md')).toBe(true)
    expect(isUnderNotesDir('0001. a.md')).toBe(false)
    expect(isUnderNotesDir('notes')).toBe(false)
  })

  it('indexes notes recursively and keeps the first hit for duplicate indexes', () => {
    const toc: DeskTocNode[] = [
      {
        type: 'group',
        title: '分组',
        tocLineIndex: 0,
        nodeId: 'group-1',
        folderPath: ['分组'],
        children: [noteNode('0001', 'uuid-1', '第一篇', [noteNode('0002', 'uuid-2', '子笔记')])]
      },
      noteNode('0001', 'uuid-duplicate', '重复编号')
    ]
    const index = buildNoteIndex(toc)
    expect(index.get('0001')).toEqual({ uuid: 'uuid-1', title: '第一篇' })
    expect(index.get('0002')).toEqual({ uuid: 'uuid-2', title: '子笔记' })
    expect(index.size).toBe(2)
  })

  it('finds the live note node (completed included) by index, first hit wins', () => {
    const toc: DeskTocNode[] = [
      {
        type: 'group',
        title: '分组',
        tocLineIndex: 0,
        nodeId: 'group-1',
        folderPath: ['分组'],
        children: [
          noteNode('0001', 'uuid-1', '第一篇'),
          { ...noteNode('0002', 'uuid-2', '子笔记'), completed: true }
        ]
      },
      noteNode('0001', 'uuid-duplicate', '重复编号')
    ]
    // 返回的是节点本身（不是 buildNoteIndex 那种快照），所以 completed 一起带回来
    expect(findTocNoteByIndex(toc, '0002')).toMatchObject({ uuid: 'uuid-2', completed: true })
    expect(findTocNoteByIndex(toc, '0001')).toMatchObject({ uuid: 'uuid-1' })
    expect(findTocNoteByIndex(toc, '0099')).toBeNull()
  })
})

describe('decideKbPathOpen', () => {
  const noteIndex = buildNoteIndex([noteNode('0001', 'uuid-1', '第一篇')])

  it('pushes into directories instead of opening a file', () => {
    expect(decideKbPathOpen({ relPath: 'notes', kind: 'directory', noteIndex })).toEqual({
      action: 'enter-directory',
      relPath: 'notes'
    })
  })

  it('routes notes/ markdown with a known index to the note session', () => {
    expect(decideKbPathOpen({ relPath: 'notes/0001. hello.md', kind: 'file', noteIndex })).toEqual({
      action: 'open-note',
      relPath: 'notes/0001. hello.md',
      noteIndex: '0001',
      note: { uuid: 'uuid-1', title: '第一篇' }
    })
  })

  it('falls back to a text tab with an explanatory notice for unknown index', () => {
    const decision = decideKbPathOpen({
      relPath: 'notes/0099. gone.md',
      kind: 'file',
      noteIndex
    })
    expect(decision).toMatchObject({ action: 'open-text', relPath: 'notes/0099. gone.md' })
    if (decision.action !== 'open-text') throw new Error('expected open-text')
    expect(decision.notice).toContain('0099')
  })

  it('opens markdown outside notes/ as a plain text file', () => {
    expect(decideKbPathOpen({ relPath: 'README.md', kind: 'file', noteIndex })).toEqual({
      action: 'open-text',
      relPath: 'README.md'
    })
    expect(decideKbPathOpen({ relPath: 'notes/readme.md', kind: 'file', noteIndex })).toEqual({
      action: 'open-text',
      relPath: 'notes/readme.md'
    })
  })

  it('opens dotfiles, lockfiles and unknown extensions as text', () => {
    for (const relPath of [
      '.gitignore',
      'package.json',
      '.github/workflows/ci.yml',
      'Cargo.lock'
    ]) {
      expect(decideKbPathOpen({ relPath, kind: 'file', noteIndex })).toEqual({
        action: 'open-text',
        relPath
      })
    }
  })

  it('refuses known binary files', () => {
    for (const relPath of ['assets/cover.png', 'assets/video.mp4', 'doc.pdf']) {
      const decision = decideKbPathOpen({ relPath, kind: 'file', noteIndex })
      expect(decision.action).toBe('blocked')
      if (decision.action !== 'blocked') throw new Error('expected blocked')
      expect(decision.reason).toContain('不是文本文件')
    }
  })

  it('refuses excalidraw with a pointer to the assets panel', () => {
    const decision = decideKbPathOpen({
      relPath: 'assets/0001-x.excalidraw',
      kind: 'file',
      noteIndex
    })
    expect(decision.action).toBe('blocked')
    if (decision.action !== 'blocked') throw new Error('expected blocked')
    expect(decision.reason).toContain('资源面板')
    expect(isExcalidrawPath('assets/0001-x.excalidraw')).toBe(true)
    expect(isExcalidrawPath('assets/0001-x.svg')).toBe(false)
  })

  it('classifies text paths by extension only', () => {
    expect(looksLikeTextPath('notes/0001. a.md')).toBe(true)
    expect(looksLikeTextPath('.github/workflows/ci.yml')).toBe(true)
    expect(looksLikeTextPath('assets/a.png')).toBe(false)
    expect(looksLikeTextPath('assets/A.PNG')).toBe(false)
  })
})

describe('formatKbEntryBytes', () => {
  it('formats file sizes and leaves directories blank', () => {
    expect(formatKbEntryBytes(null)).toBe('')
    expect(formatKbEntryBytes(0)).toBe('0 B')
    expect(formatKbEntryBytes(999)).toBe('999 B')
    expect(formatKbEntryBytes(2048)).toBe('2.0 KB')
    expect(formatKbEntryBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatKbEntryBytes(Number.NaN)).toBe('')
  })
})
