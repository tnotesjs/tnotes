import { describe, expect, it } from 'vitest'

import { createGroup } from '../../editor-groups/layoutModel'
import { collectAssetEditorSnapshot } from './assetWriteSnapshot'

import type { DocumentSession } from './helpers'

describe('collectAssetEditorSnapshot', () => {
  it('collects dirty documents, settings tabs, recoveries without requiring path', () => {
    const layout = createGroup([
      {
        id: 'note-1',
        type: 'note',
        knowledgeBaseId: 'kb-a',
        knowledgeBaseName: 'A',
        noteUuid: 'n1',
        title: '笔记一',
        icon: null,
        viewMode: 'visual',
        pageWidth: 'standard',
        dirty: true
      },
      {
        id: 'settings-1',
        type: 'kb-settings',
        knowledgeBaseId: 'kb-a',
        knowledgeBaseName: 'A',
        title: '设置',
        icon: null,
        dirty: true
      }
    ])
    const documents: Record<string, DocumentSession> = {
      'kb-a:n1': {
        document: {
          knowledgeBaseId: 'kb-a',
          uuid: 'n1',
          index: '0001',
          title: '笔记一',
          dirName: '0001. 笔记一',
          fileName: '0001. 笔记一.md',
          filePath: '/tmp/n1.md',
          relPath: 'notes/0001. 笔记一.md',
          content: 'x',
          revision: 'r',
          config: { done: false },
          readOnly: false
        },
        content: 'x',
        dirty: true,
        saving: false,
        externalConflict: false
      }
    }
    const snapshot = collectAssetEditorSnapshot({
      knowledgeBaseId: 'kb-a',
      editor: {
        layout,
        knowledgeBaseEditors: {}
      } as never,
      documents,
      pendingRecoveries: [
        {
          version: 1,
          knowledgeBaseId: 'kb-a',
          noteUuid: 'n2',
          title: '无 path 草稿',
          content: 'y',
          revision: 'r',
          updatedAt: '2026-09-10T00:00:00.000Z'
        }
      ]
    })
    expect(snapshot.dirtyDocuments).toEqual([{ noteUuid: 'n1', title: '笔记一', saving: false }])
    expect(snapshot.kbSettingsDirty).toBe(true)
    expect(snapshot.pendingRecoveries).toEqual([{ noteUuid: 'n2', title: '无 path 草稿' }])
  })

  it('把有未写入内容的画布标签算作写入门禁原因，其他库的画布不算', () => {
    const layout = createGroup([
      {
        id: 'canvas-1',
        type: 'excalidraw',
        knowledgeBaseId: 'kb-a',
        knowledgeBaseName: 'A',
        relPath: 'assets/0042-x.excalidraw',
        ownerNoteIndex: '0042',
        title: '0042-x.excalidraw',
        icon: null,
        dirty: true
      },
      {
        id: 'canvas-2',
        type: 'excalidraw',
        knowledgeBaseId: 'kb-b',
        knowledgeBaseName: 'B',
        relPath: 'assets/0043-y.excalidraw',
        ownerNoteIndex: '0043',
        title: '0043-y.excalidraw',
        icon: null,
        dirty: true
      }
    ])
    const snapshot = collectAssetEditorSnapshot({
      knowledgeBaseId: 'kb-a',
      editor: { layout, knowledgeBaseEditors: {} } as never,
      documents: {},
      pendingRecoveries: []
    })
    expect(snapshot.dirtyTabs).toEqual([{ type: 'excalidraw', title: '0042-x.excalidraw' }])
  })

  it('历史标签页只读：不进入脏标签门禁，也不暂停 Git/资源写入', () => {
    const layout = createGroup([
      {
        id: 'history-1',
        type: 'note-history',
        knowledgeBaseId: 'kb-a',
        knowledgeBaseName: 'A',
        noteIndex: '0042',
        commit: 'a'.repeat(40),
        title: '历史 · 0042',
        icon: null
      }
    ])
    const snapshot = collectAssetEditorSnapshot({
      knowledgeBaseId: 'kb-a',
      editor: { layout, knowledgeBaseEditors: {} } as never,
      documents: {},
      pendingRecoveries: []
    })
    expect(snapshot.dirtyTabs).toEqual([])
    expect(snapshot.kbSettingsDirty).toBe(false)
  })
})
