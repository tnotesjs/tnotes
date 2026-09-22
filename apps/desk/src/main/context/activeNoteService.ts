/**
 * 当前活动笔记服务（主进程，**与 MCP 无关**）。
 *
 * `get_current_note` 要回答「调用时 Desk 活动分组里的活动标签是哪篇笔记」：
 * 渲染端是活动标签的唯一真相（主进程没有布局），所以由渲染端上报，这里只做
 * 校验、原子替换与失效 —— 与选区快照同一套代次水位规则：
 *
 * - 只接受「代次 ≥ 水位」的上报，旧代次的迟到上报不会把上一次的路径放回来；
 * - 被明确结束（切换标签 / 关闭标签 / 切到网页或设置）的代次一律丢弃，
 *   所以**关闭活动笔记后不会返回旧路径**；
 * - 只保存定位所需信息（路径 / 标题 / 知识库 / 视图与未保存标记），不保存正文，
 *   也不做任何文件读写。
 */
import type {
  ActiveNoteContextDto,
  ActiveNoteReportRequest,
  NoteViewMode
} from '../../shared/contracts'

interface StoredActiveNote {
  request: ActiveNoteReportRequest
}

export interface ActiveNoteServiceOptions {
  /** 注入时钟便于测试 */
  now?: () => Date
}

export class ActiveNoteService {
  private current: StoredActiveNote | null = null
  private lastReason: string | null = null
  /** 已见最大代次 */
  private watermark = 0
  /** 已明确结束的最高代次（结束代次上的上报一律丢弃） */
  private endedAt = 0
  private readonly now: () => Date

  constructor(options: ActiveNoteServiceOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  /** 整包替换：同一次读取的活动笔记身份 + 编辑器状态 */
  update(request: ActiveNoteReportRequest): { accepted: boolean; reason?: string } {
    if (this.isStale(request.generation)) {
      return {
        accepted: false,
        reason: this.hasEnded(request.generation) ? 'generation-ended' : 'stale-generation'
      }
    }
    this.watermark = Math.max(this.watermark, request.generation)
    this.current = { request }
    this.lastReason = null
    return { accepted: true }
  }

  /** 当前活动的不是笔记（网页 / 设置 / 资源 …）或没有活动标签 */
  clear(reason: string, generation: number): boolean {
    if (this.isStale(generation)) return false
    this.settle(generation)
    const had = this.current !== null
    this.current = null
    this.lastReason = reason
    return had
  }

  /**
   * **无条件清除**：主进程内部兜底用（上报负载不合法，没有代次可用）。
   * 宁可没有当前笔记，也不留旧路径；不动代次水位，避免影响后续正常上报。
   */
  clearNow(reason: string): void {
    this.current = null
    this.lastReason = reason
  }

  /** `get_current_note` 的读取接口（与协议无关） */
  read(): ActiveNoteContextDto {
    const stored = this.current
    if (!stored) {
      return {
        status: 'no_focused_note',
        capturedAt: null,
        message: this.lastReason ? `当前没有聚焦的笔记（${this.lastReason}）` : '当前没有聚焦的笔记'
      }
    }
    const { request } = stored
    return {
      status: 'ok',
      capturedAt: this.now().toISOString(),
      knowledgeBase: { ...request.knowledgeBase },
      note: { ...request.note },
      editor: {
        viewMode: request.editor.viewMode as NoteViewMode,
        hasUnsavedChanges: request.editor.hasUnsavedChanges
      }
    }
  }

  hasActiveNote(): boolean {
    return this.current !== null
  }

  private isStale(generation: number): boolean {
    return generation < this.watermark || this.hasEnded(generation)
  }

  private hasEnded(generation: number): boolean {
    return generation <= this.endedAt
  }

  private settle(generation: number): void {
    this.watermark = Math.max(this.watermark, generation)
    this.endedAt = Math.max(this.endedAt, generation)
  }
}

/** 主进程单例（MCP 工具与 IPC 共用） */
export const activeNoteService = new ActiveNoteService()
