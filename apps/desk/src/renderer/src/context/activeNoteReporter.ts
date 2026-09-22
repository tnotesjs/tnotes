/**
 * 「当前活动笔记」上报（渲染端 → 主进程）。
 *
 * `get_current_note` 只认**调用时**活动分组里的活动标签：
 * - 笔记标签 → 上报路径 / 标题 / 知识库 / 视图与未保存标记；
 * - 网页、设置、资源、历史等非笔记标签 → 清除（主进程返回 `no_focused_note`，
 *   **不回退**到上一次笔记）；
 * - Desk 失焦不算"活动标签变了"：这里只看 store 里的活动标签，与窗口焦点无关。
 *
 * 代次规则与选区快照一致：每次「活动笔记变了」+1；主进程只接受不小于水位的上报，
 * 并丢掉已结束代次上的消息 —— 关闭笔记标签后迟到的上报不会把旧路径放回来。
 */
import type {
  ActiveNoteReportRequest,
  DeskApi,
  EditorTab,
  KnowledgeBaseDetail
} from '../../../shared/contracts'
import type { DocumentSession } from '../stores/workspace/helpers'

const THROTTLE_MS = 60

let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null
let pending: ActiveNoteReportRequest | null = null
let pendingClear = false
/** 只记录**已成功落地**的上报签名，避免重复刷 IPC */
let lastSignature = ''

export interface ActiveNoteSource {
  /** 活动分组里的活动标签（`editor.activeTab`） */
  tab: EditorTab | null
  /** 当前打开的知识库详情 */
  knowledgeBase: KnowledgeBaseDetail | null
  /** 活动笔记的文档会话（非笔记 / 未加载时为 null） */
  session: DocumentSession | null
}

function bridge(): DeskApi['context'] | null {
  const desk = (window as unknown as { desk?: DeskApi }).desk
  return desk?.context ?? null
}

/** 能给 `get_current_note` 用的活动笔记信息（不能时为 null） */
function describe(source: ActiveNoteSource): Omit<ActiveNoteReportRequest, 'generation'> | null {
  const { tab, knowledgeBase, session } = source
  if (!tab || tab.type !== 'note') return null
  if (!knowledgeBase || knowledgeBase.id !== tab.knowledgeBaseId) return null
  const document = session?.document
  if (!document) return null
  return {
    knowledgeBase: {
      id: knowledgeBase.id,
      name: knowledgeBase.displayName || knowledgeBase.name,
      rootPath: knowledgeBase.rootPath
    },
    note: {
      id: document.uuid,
      title: document.title,
      absolutePath: document.filePath,
      relPath: document.relPath
    },
    editor: {
      viewMode: tab.viewMode,
      hasUnsavedChanges: Boolean(session?.dirty || session?.unsavedDraft)
    }
  }
}

function signatureOf(report: Omit<ActiveNoteReportRequest, 'generation'>): string {
  return JSON.stringify([
    report.knowledgeBase.id,
    report.note.id,
    report.note.absolutePath,
    report.note.title,
    report.editor.viewMode,
    report.editor.hasUnsavedChanges
  ])
}

function flush(): void {
  const report = pending
  const clear = pendingClear
  pending = null
  pendingClear = false
  timer = null
  const api = bridge()
  if (!api) return
  if (clear) {
    const sent = generation
    void api
      .clearActiveNote({ reason: '当前标签不是笔记', generation: sent })
      .then((result) => {
        // 迟到的结果不改新代次的缓存
        if (sent !== generation) return
        if (!result.ok || !result.value.cleared) lastSignature = ''
      })
      .catch(() => undefined)
    return
  }
  if (!report) return
  const signature = signatureOf(report)
  if (signature === lastSignature) return
  const request: ActiveNoteReportRequest = { ...report, generation }
  void api
    .reportActiveNote(request)
    .then((result) => {
      if (request.generation !== generation) return
      if (!result.ok || !result.value.accepted) {
        lastSignature = ''
        return
      }
      lastSignature = signature
    })
    .catch(() => undefined)
}

function schedule(): void {
  if (timer) return
  timer = setTimeout(flush, THROTTLE_MS)
}

/** 同步一次活动笔记（由 App 层的 watcher 调用） */
export function syncActiveNote(source: ActiveNoteSource): void {
  const report = describe(source)
  if (!report) {
    // 不是笔记（或文档还没加载）：作废当前上下文并清掉主进程里的活动笔记
    generation += 1
    lastSignature = ''
    pending = null
    pendingClear = true
    schedule()
    return
  }
  const signature = signatureOf(report)
  if (signature === lastSignature && !pendingClear && pending === null) return
  generation += 1
  pending = { ...report, generation }
  pendingClear = false
  schedule()
}
