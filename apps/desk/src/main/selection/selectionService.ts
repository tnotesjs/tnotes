/**
 * 选区上下文服务（主进程，**与 MCP 无关**）。
 *
 * 三层里中间那层：渲染端把"当前活动编辑器的选区"整包上报上来，这里做校验、原子替换、
 * 失效与清除，对外只暴露一个 `read()` —— MCP 工具直接读它，将来内置 Agent 也能直接复用，
 * 不需要绕本机 HTTP。
 *
 * 设计要点（对应验收里的生命周期规则）：
 * - **原子替换**：一份快照整包写入，绝不出现"路径来自 A、选区来自 B"；
 * - **按切换代次判定"谁是当前活动编辑器"**：渲染端每次换活动编辑器就 +1，这里只接受
 *   「代次 ≥ 已见最大代次」的上报 / 失效。**不能**拿"上一个快照的笔记"当"当前活动笔记"——
 *   切换瞬间两个编辑器会互相拒收（新编辑器报到被拒、旧编辑器的失效又被跳过），
 *   结果是旧笔记的选区一直以 `ok` 返回；
 * - **失效**：切笔记 / 切视图 / 关笔记 / 内容变动 → `invalidate()`，之后读到的是
 *   `selection_invalidated`，**不会**回退成上一次其它笔记的内容；
 * - **上限**：选字与块 Markdown 都有硬上限，超限（含渲染端报来的 `overLimit` 状态）
 *   返回 `context_too_large` 并**先让旧快照失效**，不静默截断、也不回退旧内容；
 * - 空选区、多选区、无法映射都表达成结构化状态，不抛异常。
 */
import { randomUUID } from 'node:crypto'

import { SELECTION_LIMITS } from '../../shared/contracts'

import type {
  SelectionCaptureDto,
  SelectionContextSnapshotDto,
  SelectionReportRequest,
  SelectionStatus
} from '../../shared/contracts'

export { SELECTION_LIMITS }

interface StoredSnapshot {
  snapshotId: string
  capturedAt: string
  request: SelectionReportRequest
  selectedChars: number
  blockChars: number
}

export interface SelectionServiceOptions {
  /** 注入时钟便于测试 */
  now?: () => Date
  /** 生成 id 便于测试 */
  newId?: () => string
}

/** 上报结果：被接受 / 被拒绝（含原因），拒绝不改变已有快照 */
export interface SelectionReportOutcome {
  accepted: boolean
  reason?: string
  status: SelectionStatus
}

export class SelectionContextService {
  private snapshot: StoredSnapshot | null = null
  private invalidReason: string | null = null
  /** 最近一次因超限被拒的原因：此后读到的是 `context_too_large`，不回退成上一次的选区 */
  private tooLargeReason: string | null = null
  /**
   * 已见最大切换代次（水位）。上报 / 失效 / 清除都必须不小于它才会被处理，
   * 这样旧编辑器的迟到消息不会覆盖新编辑器的快照，也不会把新快照清掉。
   */
  private watermark = 0
  /**
   * 已明确结束的最高代次。一个代次一旦被结束（用户取消 / 切笔记 / 切视图 …），
   * 它的上报就再也不接受 —— 否则"结束"和"在途上报"谁先到都能让旧内容复活。
   */
  private endedAt = 0
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(options: SelectionServiceOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
  }

  /**
   * 整包替换快照。
   *
   * 返回 `accepted:false` 的情形：
   * - **旧代次的迟到上报**（代次已落后或已被结束）：保持不动，避免旧编辑器覆盖新快照；
   * - **超限**（选中过长 / 块过多 / 块内容过长，或渲染端直接报来 `overLimit`）：
   *   必须让旧快照失效 —— 否则工具会把上一次的选区当成当前选区返回（静默给出过期内容）。
   */
  update(request: SelectionReportRequest): SelectionReportOutcome {
    if (this.isStale(request.generation)) {
      return {
        accepted: false,
        reason: this.hasEnded(request.generation) ? 'generation-ended' : 'stale-generation',
        status: this.read().status
      }
    }
    this.watermark = Math.max(this.watermark, request.generation)
    const limitIssue = request.capture.overLimit ?? this.checkLimits(request.capture)
    if (limitIssue) {
      // 用户当前选中的是一大段：如实说"太大"，绝不回退成上一次的选区
      this.snapshot = null
      this.invalidReason = null
      this.tooLargeReason = limitIssue
      return { accepted: false, reason: limitIssue, status: 'context_too_large' }
    }
    this.snapshot = {
      snapshotId: this.newId(),
      capturedAt: this.now().toISOString(),
      request,
      selectedChars: request.capture.selectedText?.length ?? 0,
      blockChars: (request.capture.blocks ?? []).reduce(
        (total, block) => total + block.markdown.length,
        0
      )
    }
    this.invalidReason = null
    this.tooLargeReason = null
    return { accepted: true, status: 'ok' }
  }

  /** 显式清除（用户主动取消选区）。`noteId` 给定时只清除该笔记的快照。 */
  clear(noteId: string | undefined, generation: number): boolean {
    if (this.isStale(generation)) return false
    // 说的不是这篇笔记：不动（也不结束这个代次——那是另一篇笔记的竞态消息）
    if (this.snapshot && noteId && this.snapshot.request.note.id !== noteId) return false
    this.settle(generation)
    if (!this.snapshot) {
      // 没有快照时也要收起"上次选区太大"的提示：用户已经取消选择 / 换了内容
      this.tooLargeReason = null
      return false
    }
    this.snapshot = null
    this.invalidReason = null
    this.tooLargeReason = null
    return true
  }

  /**
   * 使快照失效但**记住原因**：切笔记 / 切视图 / 关笔记 / 内容变动都走这里。
   * 失效后 `read()` 返回 `selection_invalidated`，不会给出过期的文本与范围。
   *
   * 旧代次的失效（另一个编辑器已经接管）不会动当前快照。
   */
  invalidate(reason: string, generation: number): boolean {
    if (this.isStale(generation)) return false
    this.settle(generation)
    this.invalidReason = reason
    this.snapshot = null
    this.tooLargeReason = null
    return true
  }

  /**
   * **无条件失效**：主进程内部兜底用（例如上报负载被 schema 挡下、根本没有代次可用）。
   * 宁可没有快照，也不留过期内容；不动代次水位，避免影响后续正常上报。
   */
  invalidateNow(reason: string): void {
    this.invalidReason = reason
    this.snapshot = null
    this.tooLargeReason = null
  }

  /** 代次是否已落后于水位 */
  private isStale(generation: number): boolean {
    return generation < this.watermark || this.hasEnded(generation)
  }

  /** 这个代次是否已经被明确结束过 */
  private hasEnded(generation: number): boolean {
    return generation <= this.endedAt
  }

  /** 记账：推进水位，并把这个代次标记为已结束 */
  private settle(generation: number): void {
    this.watermark = Math.max(this.watermark, generation)
    this.endedAt = Math.max(this.endedAt, generation)
  }

  /** 与协议无关的读取接口（MCP 工具、将来的内置 Agent 都读它） */
  read(): SelectionContextSnapshotDto {
    const stored = this.snapshot
    if (!stored) {
      if (this.tooLargeReason) return this.tooLargeSnapshot(this.tooLargeReason)
      return this.emptySnapshot(this.invalidReason ? 'selection_invalidated' : 'no_selection')
    }
    const { request } = stored
    const { capture } = request
    const base: SelectionContextSnapshotDto = {
      status: 'ok',
      snapshotId: stored.snapshotId,
      capturedAt: stored.capturedAt,
      knowledgeBase: { ...request.knowledgeBase },
      note: { ...request.note },
      editor: {
        viewMode: request.editor.viewMode,
        collector: capture.collector,
        contentSource: request.editor.contentSource,
        hasUnsavedChanges: request.editor.hasUnsavedChanges,
        revision: request.editor.revision
      },
      selection: {
        selectedText: capture.selectedText ?? '',
        mapping: capture.sourceRange ? 'source-range' : 'block',
        blocks: (capture.blocks ?? []).map((block) => ({ ...block }))
      },
      limits: { ...SELECTION_LIMITS }
    }
    if (capture.sourceRange) base.selection!.sourceRange = { ...capture.sourceRange }
    if (capture.empty) {
      return {
        ...this.emptySnapshot('no_selection'),
        note: base.note,
        knowledgeBase: base.knowledgeBase,
        editor: base.editor
      }
    }
    if (capture.unsupportedReason) {
      return {
        ...base,
        status: 'unsupported_selection',
        message: capture.unsupportedReason
      }
    }
    return base
  }

  /** 诊断用：当前是否有有效快照 */
  hasSnapshot(): boolean {
    return this.snapshot !== null
  }

  private checkLimits(capture: SelectionCaptureDto): string | null {
    const selected = capture.selectedText?.length ?? 0
    if (selected > SELECTION_LIMITS.maxSelectedChars) {
      return `选中内容过长：${selected} 字符，上限 ${SELECTION_LIMITS.maxSelectedChars} 字符`
    }
    const blocks = capture.blocks ?? []
    if (blocks.length > SELECTION_LIMITS.maxBlocks) {
      return `涉及块过多：${blocks.length} 块，上限 ${SELECTION_LIMITS.maxBlocks} 块`
    }
    const blockChars = blocks.reduce((total, block) => total + block.markdown.length, 0)
    if (blockChars > SELECTION_LIMITS.maxBlockChars) {
      return `相关块内容过长：${blockChars} 字符，上限 ${SELECTION_LIMITS.maxBlockChars} 字符`
    }
    return null
  }

  /** 选区超限：不给内容、不给坐标，只说明为什么拒绝（并提示怎么继续） */
  private tooLargeSnapshot(reason: string): SelectionContextSnapshotDto {
    return {
      status: 'context_too_large',
      snapshotId: null,
      capturedAt: null,
      message: `${reason}。请让用户缩小选择范围，或分段选择后再试；这里不会截断内容。`,
      limits: { ...SELECTION_LIMITS }
    }
  }

  private emptySnapshot(status: SelectionStatus): SelectionContextSnapshotDto {
    return {
      status,
      snapshotId: null,
      capturedAt: null,
      message:
        status === 'selection_invalidated'
          ? `上一次选区已失效（${this.invalidReason ?? '内容已变化'}），请在笔记里重新选择`
          : '当前没有选中的内容',
      limits: { ...SELECTION_LIMITS }
    }
  }
}

/** 主进程单例（MCP 工具与 IPC 共用） */
export const selectionContext = new SelectionContextService()
