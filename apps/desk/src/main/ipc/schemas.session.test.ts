import { describe, expect, it } from 'vitest'

import { workspaceSessionSchema } from './schemas'

const OID = 'a'.repeat(40)

function session(tabs: Array<Record<string, unknown>>): unknown {
  return {
    version: 1,
    selectedKnowledgeBaseId: 'kb-1',
    layout: { type: 'group', id: 'group-1', tabs, activeTabId: tabs[0]?.id ?? null },
    activeGroupId: 'group-1',
    knowledgeBaseEditors: {},
    knowledgeSidebarWidth: 200,
    navigatorSidebarWidth: 300,
    knowledgeSidebarCollapsed: false,
    navigatorSidebarCollapsed: false,
    expandedTocNodes: {}
  }
}

describe('工作区会话 schema', () => {
  it('接受画布标签（此前会话保存必然 INVALID_REQUEST）', () => {
    const result = workspaceSessionSchema.safeParse(
      session([
        {
          id: 'excalidraw:kb-1:assets/0042-x.excalidraw',
          type: 'excalidraw',
          knowledgeBaseId: 'kb-1',
          knowledgeBaseName: 'KB',
          relPath: 'assets/0042-x.excalidraw',
          ownerNoteIndex: '0042',
          title: '0042-x.excalidraw',
          icon: null,
          pinned: false,
          openedAt: 1,
          dirty: true,
          invalid: false
        }
      ])
    )
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true)
    if (result.success) {
      expect(result.data.pinnedKnowledgeBasesCollapsed).toBe(false)
      expect(result.data.pinnedNotesCollapsed).toEqual({})
    }
  })

  it('接受历史标签，并拒绝非法 commit 与非法编号', () => {
    const tab = {
      id: 'note-history:kb-1:0042',
      type: 'note-history',
      knowledgeBaseId: 'kb-1',
      knowledgeBaseName: 'KB',
      noteIndex: '0042',
      noteUuid: 'note-1',
      commit: OID,
      title: '历史 · 0042',
      icon: null,
      pinned: false,
      openedAt: 1
    }
    expect(workspaceSessionSchema.safeParse(session([tab])).success).toBe(true)
    expect(workspaceSessionSchema.safeParse(session([{ ...tab, commit: 'HEAD~1' }])).success).toBe(
      false
    )
    expect(workspaceSessionSchema.safeParse(session([{ ...tab, noteIndex: '42' }])).success).toBe(
      false
    )
    // 恢复时还没定位到提交：空串是合法状态
    expect(workspaceSessionSchema.safeParse(session([{ ...tab, commit: '' }])).success).toBe(true)
  })

  it('仍拒绝未知标签类型', () => {
    const result = workspaceSessionSchema.safeParse(
      session([{ id: 'x', type: 'unknown-tab', title: 'x' }])
    )
    expect(result.success).toBe(false)
  })
})
