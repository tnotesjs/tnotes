/**
 * 选区上下文服务（主进程，**与 MCP 无关**）。
 *
 * 三层里中间那层：渲染端把"当前活动编辑器的选区"整包上报上来，这里做校验、原子替换、
 * 失效与清除，对外只暴露一个 `read()` —— MCP 工具直接读它，将来内置 Agent 也能直接复用，
 * 不需要绕本机 HTTP。
 *
 * 设计要点（对应验收里的生命周期规则）：
 * - **原子替换**：一份快照整包写入，绝不出现"路径来自 A、选区来自 B"；
 * - **只接受当前活动笔记的更新**：调用方在渲染端按活动分组/标签过滤，这里再用
 *   `noteId` 做一次防竞态校验（切笔记后迟到的旧上报会被拒）；
 * - **失效**：切笔记 / 切视图 / 关笔记 / 内容变动 → `invalidate()`，之后读到的是
 *   `selection_invalidated`，**不会**回退成上一次其它笔记的内容；
 * - **上限**：选字与块 Markdown 都有硬上限，超限返回 `context_too_large` 并说明原因，
 *   不静默截断；
 * - 空选区、多选区、无法映射都表达成结构化状态，不抛异常。
 */
import { randomUUID } from 'node:crypto'

import type {
  SelectionCaptureDto,
  SelectionContextSnapshotDto,
  SelectionReportRequest,
  SelectionStatus
} from '../../shared/contracts'

/** 硬上限：超过就返回 `context_too_large`（明确拒绝，不截断） */
export const SELECTION_LIMITS = {
  maxSelectedChars: 20_000,
  maxBlockChars: 60_000,
  maxBlocks: 20
} as const

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
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(options: SelectionServiceOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
  }

  /**
   * 整包替换快照。
   *
   * 返回 `accepted:false` 的情形：上报的笔记已经不是当前快照的笔记（切笔记后的迟到上报），
   * 或者选字/块超限。两种都不动已有快照 —— 避免半新半旧。
   */
  update(request: SelectionReportRequest): SelectionReportOutcome {
    const limitIssue = this.checkLimits(request.capture)
    if (limitIssue) {
      return { accepted: false, reason: limitIssue, status: 'context_too_large' }
    }
    const current = this.snapshot
    if (current && current.request.note.id !== request.note.id) {
      // 上一个快照属于另一篇笔记：说明这是切换过程中的迟到上报。
      // 只有当前快照来自同一篇笔记时才允许替换；不同笔记一律先失效再等新上报。
      return {
        accepted: false,
        reason: 'note-changed',
        status: 'selection_invalidated'
      }
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
    return { accepted: true, status: 'ok' }
  }

  /** 显式清除（用户主动取消选区）。`noteId` 给定时只清除该笔记的快照。 */
  clear(noteId?: string): boolean {
    if (!this.snapshot) return false
    if (noteId && this.snapshot.request.note.id !== noteId) return false
    this.snapshot = null
    this.invalidReason = null
    return true
  }

  /**
   * 使快照失效但**记住原因**：切笔记 / 切视图 / 关笔记 / 内容变动都走这里。
   * 失效后 `read()` 返回 `selection_invalidated`，不会给出过期的文本与范围。
   */
  invalidate(reason: string): void {
    this.invalidReason = reason
    this.snapshot = null
  }

  /** 与协议无关的读取接口（MCP 工具、将来的内置 Agent 都读它） */
  read(): SelectionContextSnapshotDto {
    const stored = this.snapshot
    if (!stored) {
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
