/**
 * 选区上报（渲染端 → 主进程）。
 *
 * 约定：
 * - 只有**当前活动编辑器**调用（活动分组 + 活动标签 + 活动视图由调用方判断）；
 * - 节流合并：同一批变化只发最后一次；与上一次内容完全相同就跳过 —— 光标在同一处
 *   反复移动不会刷 IPC；
 * - 只发选区本身与相关块，**不发整篇文档**；
 * - 失败只记诊断，不影响编辑（选区服务是旁路能力）。
 */
import type {
  SelectionBlockDto,
  SelectionCaptureDto,
  SelectionRangeDto,
  SelectionReportRequest
} from '../../../shared/contracts'

/** 编辑器层给出的选区（只描述"选了什么"，不含笔记身份与草稿状态） */
export interface EditorSelectionPayload {
  empty: boolean
  selectedText: string
  /** 不传表示没有精确源码范围（块级上下文） */
  range?: Omit<SelectionRangeDto, 'source'>
  blocks: Omit<SelectionBlockDto, 'source'>[]
  /** 不支持的原因（多选区等） */
  unsupportedReason?: string
}

export interface SelectionReportIdentity {
  knowledgeBase: SelectionReportRequest['knowledgeBase']
  note: SelectionReportRequest['note']
  editor: SelectionReportRequest['editor'] & { collector: SelectionCaptureDto['collector'] }
}

const THROTTLE_MS = 80

let timer: ReturnType<typeof setTimeout> | null = null
let pending: SelectionReportRequest | null = null
let lastSignature = ''

function signatureOf(request: SelectionReportRequest): string {
  const { note, editor, capture } = request
  return JSON.stringify([
    note.id,
    editor.viewMode,
    editor.contentSource,
    editor.revision,
    capture.collector,
    capture.empty,
    capture.unsupportedReason ?? '',
    capture.selectedText ?? '',
    capture.sourceRange ?? null,
    capture.blocks ?? []
  ])
}

function flush(): void {
  const request = pending
  pending = null
  timer = null
  if (!request) return
  const signature = signatureOf(request)
  if (signature === lastSignature) return
  lastSignature = signature
  void window.desk.selection
    .report(request)
    .then((result) => {
      if (result.ok) return
      // 上报失败要能被看见，但绝不能影响编辑
      console.warn('[desk] 选区快照上报失败', result.error.message)
    })
    .catch((error: unknown) => {
      console.warn('[desk] 选区快照上报异常', error)
    })
}

/** 上报一次有效选区（节流合并） */
export function reportSelection(
  identity: SelectionReportIdentity,
  capture: EditorSelectionPayload
): void {
  const contentSource = identity.editor.contentSource
  const blocks: SelectionBlockDto[] = capture.blocks.map((block) => ({
    ...block,
    // 源码视图给的是原文切片；可视化视图由它自己标注 reserialized
    source: (block as SelectionBlockDto).source ?? 'raw'
  }))
  pending = {
    knowledgeBase: identity.knowledgeBase,
    note: identity.note,
    editor: {
      viewMode: identity.editor.viewMode,
      contentSource,
      hasUnsavedChanges: identity.editor.hasUnsavedChanges,
      revision: identity.editor.revision
    },
    capture: {
      collector: identity.editor.collector,
      empty: capture.empty,
      ...(capture.empty ? {} : { selectedText: capture.selectedText }),
      ...(capture.range ? { sourceRange: { ...capture.range, source: contentSource } } : {}),
      ...(capture.unsupportedReason ? { unsupportedReason: capture.unsupportedReason } : {}),
      blocks
    }
  }
  if (timer) return
  timer = setTimeout(flush, THROTTLE_MS)
}

/** 用户主动取消选区 → 清除快照 */
export function clearSelection(noteId: string): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending = null
  lastSignature = ''
  void window.desk.selection.clear({ reason: 'selection-cancelled', noteId }).catch(() => undefined)
}

/**
 * 使快照失效（切笔记 / 切视图 / 关笔记 / 外部改动）。
 * 失效后读取到的是 `selection_invalidated`，不会回退成上一次的内容。
 */
export function invalidateSelection(reason: string): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending = null
  lastSignature = ''
  void window.desk.selection.clear({ reason }).catch(() => undefined)
}
