/**
 * 选区上报（渲染端 → 主进程）。
 *
 * 约定：
 * - 只有**当前活动编辑器**调用（活动分组 + 活动标签 + 活动视图由调用方判断）；
 * - **切换代次（generation）**：活动编辑器每换一次（换分组 / 换标签 / 换笔记 / 换视图）
 *   就 +1，随每次上报 / 失效 / 清除一起发给主进程。主进程只认「代次 ≥ 已见最大代次」，
 *   用它挡住旧编辑器的迟到上报 —— 而不是拿"上一个快照的笔记"当"当前活动笔记"
 *   （那会在切换瞬间互相拒收，旧笔记的选区会一直以 ok 返回）；
 * - 归属者（`分组:标签`）只用于"本编辑器还有没有发言权"：不是归属者的编辑器不许清空 / 失效，
 *   但**不是**靠它来决定主进程能不能收下新编辑器的上报（那是代次的事）；
 * - 节流合并：同一批变化只发最后一次；与**已成功落地**的内容完全相同就跳过；
 * - 只发选区本身与相关块，**不发整篇文档**；大到不适合塞进 IPC 时只发不带正文的超限状态；
 * - `accepted:false` 是业务结果，要和 IPC 失败一样处理（不记去重签名，允许重试）；
 * - 失败只记诊断，不影响编辑（选区服务是旁路能力）。
 */
import { SELECTION_LIMITS, SELECTION_TRANSPORT_LIMITS } from '../../../shared/contracts'

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

/** 当前快照的归属编辑器（`分组:标签`）；null = 还没有编辑器上报过 */
let owner: string | null = null
/**
 * 当前活动编辑器的**上下文代次**。换归属者、或对当前归属者做失效 / 清除时 +1。
 * 上报带当前值，失效 / 清除带**结束的那个值**（随后 +1），所以：
 * 旧上下文的上报、以及结束旧上下文的失效，都不可能覆盖 / 清掉新上下文的快照。
 */
let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null
let pending: SelectionReportRequest | null = null
/** 只记录**已成功落地**的上报签名，避免"上报被拒后同一内容再也发不出去" */
let lastSignature = ''
/**
 * 主进程那边是否可能有本上下文的状态（快照 / 超限提示）。
 *
 * 光标每动一下都会产生"空选区"，如果每次都发 clear，箭头键会刷一屏 IPC；
 * 这里只在"确实上报过东西"之后才发一次清除。
 */
let dirty = false

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

/** 认领归属：换编辑器就是换上下文，代次 +1 */
function claim(ownerKey: string): void {
  if (owner === ownerKey) return
  owner = ownerKey
  generation += 1
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
  dirty = true
  void selectionBridge()
    ?.report(request)
    .then((result) => {
      if (!result.ok) {
        // 上报失败要能被看见，但绝不能影响编辑；也不记签名，允许下次重试
        console.warn('[desk] 选区快照上报失败', result.error.message)
        return
      }
      if (!result.value.accepted) {
        // 主进程没收下（旧代次迟到 / 超限）：不能当成成功，否则同一内容再也发不出去
        console.warn('[desk] 选区快照未被接受', result.value.reason ?? result.value.status)
        return
      }
      lastSignature = signature
    })
    .catch((error: unknown) => {
      console.warn('[desk] 选区快照上报异常', error)
    })
}

/**
 * 大到不适合塞进 IPC 的选区：只报**不带正文**的超限状态。
 *
 * 只有超过传输上限才走这里；「刚刚超过语义上限」的负载照常发正文，
 * 由主进程统一判定（这样超限原因、上限数字只有一处真相）。
 */
function overLimitReason(selectedChars: number, blocks: SelectionBlockDto[]): string | null {
  const blockChars = blocks.reduce((total, block) => total + block.markdown.length, 0)
  const total = selectedChars + blockChars
  if (selectedChars > SELECTION_TRANSPORT_LIMITS.maxSelectedTextChars) {
    return `选中内容过长：${selectedChars} 字符，上限 ${SELECTION_LIMITS.maxSelectedChars} 字符（超过传输上限，未随上报发送正文）`
  }
  if (blocks.length > SELECTION_TRANSPORT_LIMITS.maxBlocks) {
    return `涉及块过多：${blocks.length} 块，上限 ${SELECTION_LIMITS.maxBlocks} 块（超过传输上限，未随上报发送正文）`
  }
  if (
    blockChars > SELECTION_TRANSPORT_LIMITS.maxBlockChars ||
    total > SELECTION_TRANSPORT_LIMITS.maxTotalChars
  ) {
    return `相关块内容过长：${blockChars} 字符，上限 ${SELECTION_LIMITS.maxBlockChars} 字符（超过传输上限，未随上报发送正文）`
  }
  return null
}

/** 上报一次有效选区（节流合并）。`ownerKey` 是上报的编辑器（分组:标签） */
export function reportSelection(
  ownerKey: string,
  identity: SelectionReportIdentity,
  capture: EditorSelectionPayload
): void {
  claim(ownerKey)
  const contentSource = identity.editor.contentSource
  const blocks: SelectionBlockDto[] = capture.blocks.map((block) => ({
    ...block,
    // 源码视图给的是原文切片；可视化视图自己标了 reserialized
    source: block.source ?? 'raw'
  }))
  const selectedText = capture.empty ? '' : capture.selectedText
  const overLimit = capture.empty ? null : overLimitReason(selectedText.length, blocks)
  pending = {
    generation,
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
      ...(overLimit
        ? { overLimit, selectedChars: selectedText.length }
        : {
            ...(capture.empty ? {} : { selectedText }),
            ...(capture.range ? { sourceRange: { ...capture.range, source: contentSource } } : {}),
            ...(capture.unsupportedReason ? { unsupportedReason: capture.unsupportedReason } : {}),
            blocks
          })
    }
  }
  if (timer) return
  timer = setTimeout(flush, THROTTLE_MS)
}

/**
 * 结束当前上下文：清掉待发上报，并把代次推进一格。
 *
 * 推进很关键：这样"结束旧上下文"的失效不会再清掉紧随其后的新上报，
 * 旧上下文里排队 / 在途的上报到了主进程也会因代次结束被丢掉。
 * 返回 `null` 表示主进程那边本来就没有本上下文的状态（不必发 IPC）。
 */
function endContext(): number | null {
  const ending = dirty ? generation : null
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending = null
  lastSignature = ''
  owner = null
  dirty = false
  generation += 1
  return ending
}

/** 用户主动取消选区 → 清除快照（不是当前归属者的编辑器不许清） */
export function clearSelection(ownerKey: string, noteId: string): void {
  if (owner !== null && owner !== ownerKey) return
  const ending = endContext()
  if (ending == null) return
  void selectionBridge()
    ?.clear({ reason: 'selection-cancelled', noteId, generation: ending })
    .catch(() => undefined)
}

/**
 * 使快照失效（切笔记 / 切视图 / 关笔记 / 外部改动）。
 * 失效后读取到的是 `selection_invalidated`，不会回退成上一次的内容。
 */
export function invalidateSelection(ownerKey: string, reason: string): void {
  if (owner !== null && owner !== ownerKey) return
  const ending = endContext()
  if (ending == null) return
  void selectionBridge()
    ?.clear({ reason, generation: ending })
    .catch(() => undefined)
}
