/**
 * 固定选区上下文（渲染端镜像 + 操作入口）。
 *
 * 真相在主进程（与 MCP 协议层分离的 `PinnedContextService`）：这里只：
 * - 订阅主进程广播，给状态条与各标签页一份只读状态；
 * - 发起固定 / 校验 / 解除；
 * - 提供「查看」要用的信息（归属分组 + 标签 + 锚点）。
 *
 * 固定状态**不持久化**：主进程进程内状态，退出即清空。
 */
import { ref, type Ref } from 'vue'

import type { DeskApi, PinnedContextDto } from '../../../shared/contracts'

/** 当前固定上下文（`null` = 还没收到过广播；主进程每次变化都会广播） */
export const pinnedContext: Ref<PinnedContextDto | null> = ref(null)

function bridge(): DeskApi['context'] | null {
  const desk = (window as unknown as { desk?: DeskApi }).desk
  return desk?.context ?? null
}

/** 订阅主进程的固定状态广播（App 启动时调一次） */
export function installPinnedContextSync(): () => void {
  const api = bridge()
  if (!api) return () => undefined
  return api.onPinChanged((context) => {
    pinnedContext.value = context
  })
}

/** 校验锚点是否还有效；主进程据此把固定标成失效（丢正文、给原因） */
export async function reportPinValidation(
  pinId: string,
  valid: boolean,
  reason?: string
): Promise<void> {
  const api = bridge()
  if (!api) return
  await api.validatePin({ pinId, valid, ...(reason ? { reason } : {}) }).catch(() => undefined)
}

/** 来源笔记被外部修改：请主进程用**磁盘内容**复核（对不上就失效） */
export async function revalidatePinFromDisk(
  pinId: string,
  knowledgeBaseId: string,
  noteUuid: string
): Promise<void> {
  const api = bridge()
  if (!api) return
  await api.revalidatePinFromDisk({ pinId, knowledgeBaseId, noteUuid }).catch(() => undefined)
}

/** 用户显式解除（显式恢复实时模式，不由自动失效悄悄回退） */
export async function clearPinnedContext(reason: string): Promise<void> {
  const api = bridge()
  if (!api) return
  await api.clearPin({ reason }).catch(() => undefined)
}

/** 固定上下文的一句话摘要（状态条用） */
export function pinnedSummary(context: PinnedContextDto | null): string {
  const text = context?.selection?.selectedText ?? ''
  if (!text) return ''
  const compact = text.replace(/\s+/g, ' ').trim()
  const head = compact.length > 42 ? `${compact.slice(0, 42)}…` : compact
  return `${head}（${text.length} 字）`
}
