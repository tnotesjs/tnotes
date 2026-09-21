/**
 * 选区上报（渲染端 → 主进程）。
 *
 * 约定：
 * - 只有**当前活动编辑器**调用（活动分组 + 活动标签 + 活动视图由调用方判断）；
 * - 节流合并：同一批变化只发最后一次；与上一次内容完全相同就跳过 —— 光标在同一处
 *   反复移动不会刷 IPC；
 * - 只发选区本身与相关块，**不发整篇文档**；
 * - 多个编辑器分组同时挂载时用「归属者」判定：只有归属者能清空 / 失效快照，
 *   后台编辑器不会覆盖、也不会误清活动编辑器刚采集的选区；
 * - 失败只记诊断，不影响编辑（选区服务是旁路能力）。
 */
import type {
  DeskApi,
  SelectionBlockDto,
  SelectionCaptureDto,
  SelectionRangeDto,
  SelectionReportRequest
} from '../../../shared/contracts'

/**
 * 编辑器层给出的块：`source` 由编辑器按自己的能力标注 ——
 * 源码视图给的是逐字原文（`raw`），可视化视图序列化出来的标 `reserialized`，
 * 特殊组件的原始源码也是 `raw`。不标注时按 `raw` 处理（源码视图的默认）。
 */
export type EditorSelectionBlock = Omit<SelectionBlockDto, 'source'> & {
  source?: SelectionBlockDto['source']
}

/** 编辑器层给出的选区（只描述"选了什么"，不含笔记身份与草稿状态） */
export interface EditorSelectionPayload {
  empty: boolean
  selectedText: string
  /** 不传表示没有精确源码范围（块级上下文） */
  range?: Omit<SelectionRangeDto, 'source'>
  blocks: EditorSelectionBlock[]
  /** 不支持的原因（多选区等） */
  unsupportedReason?: string
}

export interface SelectionReportIdentity {
  knowledgeBase: SelectionReportRequest['knowledgeBase']
  note: SelectionReportRequest['note']
  editor: SelectionReportRequest['editor'] & { collector: SelectionCaptureDto['collector'] }
}

const THROTTLE_MS = 80

/**
 * 当前快照的归属编辑器（`分组:标签`）。
 *
 * 多个编辑器分组会同时挂载，切换活动分组时"新活动编辑器上报"与"旧编辑器失效"在同一个
 * tick 里发生，顺序不保证。用一个归属者标记把这种情况变成确定行为：
 * **只有归属者能清空 / 失效**，所以旧分组不会把新分组刚采集到的选区抹掉。
 */
let owner: string | null = null
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

/**
 * preload 桥。
 *
 * 单测与其它非 Electron 环境里 `window.desk` 不存在；选区服务是**旁路**能力，
 * 桥缺失时必须静默降级，绝不能因为上报失败把编辑流程带崩。
 */
function selectionBridge(): DeskApi['selection'] | null {
  const desk = (window as unknown as { desk?: DeskApi }).desk
  return desk?.selection ?? null
}

function flush(): void {
  const request = pending
  pending = null
  timer = null
  if (!request) return
  const signature = signatureOf(request)
  if (signature === lastSignature) return
  lastSignature = signature
  void selectionBridge()
    ?.report(request)
    .then((result) => {
      if (result.ok) return
      // 上报失败要能被看见，但绝不能影响编辑
      console.warn('[desk] 选区快照上报失败', result.error.message)
    })
    .catch((error: unknown) => {
      console.warn('[desk] 选区快照上报异常', error)
    })
}

/** 上报一次有效选区（节流合并）。`owner` 是上报的编辑器（分组:标签） */
export function reportSelection(
  ownerKey: string,
  identity: SelectionReportIdentity,
  capture: EditorSelectionPayload
): void {
  owner = ownerKey
  const contentSource = identity.editor.contentSource
  const blocks: SelectionBlockDto[] = capture.blocks.map((block) => ({
    ...block,
    // 源码视图给的是原文切片；可视化视图自己标了 reserialized
    source: block.source ?? 'raw'
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

/** 用户主动取消选区 → 清除快照（只允许当前归属者清，避免清掉别处刚上报的选区） */
export function clearSelection(ownerKey: string, noteId: string): void {
  if (owner !== null && owner !== ownerKey) return
  owner = null
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending = null
  lastSignature = ''
  void selectionBridge()
    ?.clear({ reason: 'selection-cancelled', noteId })
    .catch(() => undefined)
}

/**
 * 使快照失效（切笔记 / 切视图 / 关笔记 / 外部改动）。
 * 失效后读取到的是 `selection_invalidated`，不会回退成上一次的内容。
 */
export function invalidateSelection(ownerKey: string, reason: string): void {
  if (owner !== null && owner !== ownerKey) return
  owner = null
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending = null
  lastSignature = ''
  void selectionBridge()
    ?.clear({ reason })
    .catch(() => undefined)
}
