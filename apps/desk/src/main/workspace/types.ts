import type { KbSnapshot, TNotesKbWorkspace } from '@tnotesjs/kb'
import type {
  AssetScanProgressDto,
  ExternalNoteChangeEvent,
  WorkspaceOverview
} from '../../shared/contracts'

export interface KnowledgeBaseHandle {
  id: string
  name: string
  rootPath: string
  workspace: TNotesKbWorkspace
  snapshot: KbSnapshot
  /** 最近一次提交的时间，毫秒。没有仓库或没有提交时为空。 */
  lastCommitAt: number | null
}

export interface WorkspaceChangeHint {
  /** 'content' = single note body edit; 'structural' = anything else. */
  kind: 'content' | 'structural'
  knowledgeBaseId?: string
  noteUuid?: string
}

export interface WorkspaceManagerEvents {
  changed: [WorkspaceOverview, WorkspaceChangeHint?]
  noteExternalChanged: [ExternalNoteChangeEvent]
  assetScanProgress: [AssetScanProgressDto]
}

export interface GitRepositoryDescriptor {
  knowledgeBaseId: string
  knowledgeBaseName: string
  configId: string
  rootPath: string
  /** 库级约定（tnotes.json）：自动提交推送。undefined = 未启用。 */
  autoPush?: { enabled: boolean; idleMinutes: number }
  notes: Array<{
    uuid: string
    index: string
    title: string
    dirName: string
    filePath: string
  }>
}
