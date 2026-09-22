/**
 * 固定选区上下文服务（主进程，**与 MCP 协议层分离**）。
 *
 * 解决的问题：用户选中 A 之后把需求交给外部 Agent，随后自己又选了 B；Agent 延迟调用
 * `get_current_selection` 时不能误读 B。固定的 A 是一份**不可变快照**，不跟随实时选区
 * 更新，只有下面这些情况才结束：
 *
 * | 事件                                   | 结果                                   |
 * | -------------------------------------- | -------------------------------------- |
 * | 用户再次固定                           | 替换（全局只留一份）                   |
 * | 固定内容 / 坐标变化（含外部修改文件）  | `invalidated` + 原因（不返回旧正文）   |
 * | 关闭**来源标签**（记到分组 + 标签）    | `invalidated`（关同笔记另一个标签不误清） |
 * | 来源笔记被删除 / 锚点无法定位          | `invalidated` + 原因                   |
 * | 用户显式解除                           | `none`（回到实时模式）                 |
 *
 * 不持久化：进程内状态，退出即清空。
 */
import { existsSync } from 'node:fs'

import { SELECTION_LIMITS } from '../../shared/contracts'

import type { PinnedContextDto, PinSelectionRequest } from '../../shared/contracts'

interface PinnedState {
  state: 'pinned' | 'invalidated'
  pinId: string
  pinnedAt: string
  request: PinSelectionRequest
  /** `invalidated` 时丢正文，只留身份与原因 */
  reason: string | null
}

export interface PinnedContextOptions {
  now?: () => Date
  newId?: () => string
  /** 校验来源笔记是否还在（便于测试注入） */
  exists?: (absolutePath: string) => boolean
}

export interface PinOutcome {
  accepted: boolean
  reason?: string
}

export class PinnedContextService {
  private current: PinnedState | null = null
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly exists: (absolutePath: string) => boolean
  private readonly listeners = new Set<(context: PinnedContextDto) => void>()

  constructor(options: PinnedContextOptions = {}) {
    this.now = options.now ?? (() => new Date())
    let counter = 0
    this.newId = options.newId ?? (() => `pin-${++counter}`)
    this.exists = options.exists ?? ((path) => existsSync(path))
  }

  /**
   * 固定（或替换）上下文。
   *
   * 超过语义上限、没有可校验锚点、锚点与选区不匹配 → 拒绝，且**保留原有固定**
   * （不会因为一次失败的固定把用户已有的上下文弄丢）。
   */
  pin(request: PinSelectionRequest, existingLimits = SELECTION_LIMITS): PinOutcome {
    // 失败的固定不会弄丢已有的上下文：先校验，通过了才替换
    const issue = this.checkLimits(request, existingLimits)
    if (issue) return { accepted: false, reason: issue }
    const anchorIssue = this.checkAnchor(request)
    if (anchorIssue) return { accepted: false, reason: anchorIssue }
    this.current = {
      state: 'pinned',
      pinId: this.newId(),
      pinnedAt: this.now().toISOString(),
      request,
      reason: null
    }
    this.broadcast()
    return { accepted: true }
  }

  /**
   * 校验结果：内容 / 坐标变化就失效。
   * `pinId` 用于防竞态（重新固定之后，旧校验结果不许影响新固定）。
   */
  validate(request: { pinId: string; valid: boolean; reason?: string }): boolean {
    const current = this.current
    if (!current || current.pinId !== request.pinId) return false
    if (request.valid) return true
    return this.invalidateWith(request.pinId, request.reason ?? '固定内容或坐标已变化')
  }

  /** 失效：**丢掉正文**，只留身份与原因（不返回旧内容） */
  invalidate(reason: string, pinId?: string): boolean {
    if (!this.current) return false
    if (pinId && this.current.pinId !== pinId) return false
    return this.invalidateWith(this.current.pinId, reason)
  }

  /**
   * 用**磁盘内容**复核固定锚点（来源笔记被外部修改后调用）。
   *
   * 只对"固定时来自磁盘"的锚点有意义：草稿固定的坐标属于编辑器草稿，拿磁盘比会误判，
   * 那种情况交给编辑器内容那一路校验。
   *
   * 判据是**位置锚（偏移 + 期望文本）**：全文搜索命中不能代替原位置校验。
   * 返回值是"复核之后固定是否仍然有效"。
   */
  revalidateAgainst(content: string, pinId: string): boolean {
    const current = this.current
    if (!current || current.pinId !== pinId || current.state !== 'pinned') return false
    const { request } = current
    if (request.editor.contentSource !== 'disk') return false
    const anchor = request.anchor
    // 只认**位置锚**：每个偏移范围上都还是不是同一段文字。
    // 用全文搜索（includes）会让"A 移位"或"别处有相同文字"逃过校验；
    // 跨段落固定有多个范围，任何一段变了都要失效。
    const ranges = [...(anchor.ranges ?? []), ...(anchor.textRange ? [anchor.textRange] : [])]
    const matched =
      ranges.length > 0 &&
      ranges.every((range) => content.slice(range.startOffset, range.endOffset) === range.expected)
    if (matched) return true
    this.invalidateWith(pinId, '磁盘上的来源笔记已被外部修改，固定时的位置或内容已经对不上')
    return false
  }

  /** 用户显式解除（显式恢复实时模式） */
  clear(reason: string): boolean {
    if (!this.current) {
      // 已经解除：仍然广播一次，便于界面把提示收掉
      this.broadcast()
      void reason
      return false
    }
    this.current = null
    this.broadcast()
    return true
  }

  /** 主进程内部兜底（例如来源笔记文件已删除） */
  read(): PinnedContextDto {
    const current = this.current
    if (!current) return this.emptyDto('none')
    if (current.state === 'pinned' && !this.exists(current.request.note.absolutePath)) {
      // 来源笔记没了：明确失效，绝不返回旧正文
      this.invalidateWith(current.pinId, '来源笔记已删除，固定上下文已失效')
      return this.read()
    }
    if (current.state === 'invalidated') {
      return {
        ...this.baseDto(current),
        state: 'invalidated',
        reason: current.reason ?? '固定上下文已失效'
      }
    }
    const { request } = current
    return {
      ...this.baseDto(current),
      state: 'pinned',
      selection: {
        selectedText: request.capture.selectedText ?? '',
        mapping: request.capture.sourceRange ? 'source-range' : 'block',
        ...(request.capture.sourceRange ? { sourceRange: { ...request.capture.sourceRange } } : {}),
        blocks: (request.capture.blocks ?? []).map((block) => ({ ...block }))
      }
    }
  }

  /** 状态栏 / MCP 都订阅它（MCP 直接 read，不必订阅） */
  onChanged(listener: (context: PinnedContextDto) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private invalidateWith(pinId: string, reason: string): boolean {
    const current = this.current
    if (!current || current.pinId !== pinId) return false
    // 失效时清掉正文与定位信息，只留身份、时间与原因
    // （锚点里的期望文本、块 Markdown 也是内容，一并丢掉）
    this.current = {
      state: 'invalidated',
      pinId: current.pinId,
      pinnedAt: current.pinnedAt,
      request: {
        ...current.request,
        capture: { collector: current.request.capture.collector, empty: true },
        anchor: { view: current.request.anchor.view, kind: current.request.anchor.kind }
      },
      reason
    }
    this.broadcast()
    return true
  }

  private baseDto(current: PinnedState): PinnedContextDto {
    const { request } = current
    return {
      state: current.state,
      pinId: current.pinId,
      pinnedAt: current.pinnedAt,
      owner: { ...request.owner },
      knowledgeBase: { ...request.knowledgeBase },
      note: { ...request.note },
      editor: { ...request.editor },
      anchor: structuredClone(request.anchor),
      limits: { ...SELECTION_LIMITS }
    }
  }

  private emptyDto(state: PinnedContextDto['state']): PinnedContextDto {
    return { state, pinId: null, pinnedAt: null, limits: { ...SELECTION_LIMITS } }
  }

  private broadcast(): void {
    const context = this.read()
    for (const listener of [...this.listeners]) listener(context)
  }

  private checkLimits(request: PinSelectionRequest, limits = SELECTION_LIMITS): string | null {
    const capture = request.capture
    if (capture.overLimit) return capture.overLimit
    const selected = capture.selectedText?.length ?? 0
    if (selected > limits.maxSelectedChars) {
      return `选中内容过长：${selected} 字符，上限 ${limits.maxSelectedChars} 字符，无法固定为 Agent 上下文`
    }
    const blocks = capture.blocks ?? []
    if (blocks.length > limits.maxBlocks) {
      return `涉及块过多：${blocks.length} 块，上限 ${limits.maxBlocks} 块，无法固定为 Agent 上下文`
    }
    const blockChars = blocks.reduce((total, block) => total + block.markdown.length, 0)
    if (blockChars > limits.maxBlockChars) {
      return `相关块内容过长：${blockChars} 字符，上限 ${limits.maxBlockChars} 字符，无法固定为 Agent 上下文`
    }
    return null
  }

  /**
   * 锚点必须能**可靠校验**，否则明确拒绝（不能固定一份以后验不了的上下文）。
   */
  private checkAnchor(request: PinSelectionRequest): string | null {
    const { anchor, capture } = request
    if (!capture.selectedText) return '当前没有可固定的正文选区'
    // **位置锚是硬要求**：没有它就只能靠全文搜索猜位置，而"坐标变化"就验不出来了。
    // 拿不到就明确拒绝固定，而不是固定一份以后验不了的上下文。
    const positionRanges = [
      ...(anchor.ranges ?? []),
      ...(anchor.textRange ? [anchor.textRange] : [])
    ].filter((range) => range.endOffset > range.startOffset)
    if (positionRanges.length === 0) {
      // 有未保存的（写不回去的）改动时，可视化文档与源码文本的结构已经对不上：
      // 这时候拒绝是**正确**的，但要把原因说清楚，别让用户以为是选区本身有问题。
      return request.editor.hasUnsavedChanges
        ? '当前文档有未保存的改动（还没能写回源码，排版结构与源码暂时对不上），位置锚不可信，无法固定为 Agent 上下文'
        : '这个选区拿不到可校验的位置信息，无法固定为 Agent 上下文（首版不猜坐标、也不做全文搜索）'
    }
    if (anchor.kind === 'source-range') {
      const range = anchor.sourceRange
      if (!range || range.endOffset <= range.startOffset) {
        return '源码视图选区缺少可校验的范围，无法固定为 Agent 上下文'
      }
      return null
    }
    const blocks = anchor.blocks ?? []
    if (blocks.length === 0) {
      return '这种选区拿不到可靠的块位置，无法固定为 Agent 上下文（首版不猜坐标）'
    }
    return null
  }
}

/** 主进程单例（MCP 工具与 IPC 共用） */
export const pinnedContext = new PinnedContextService()
