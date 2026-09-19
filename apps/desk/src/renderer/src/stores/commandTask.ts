import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { pushToast } from './toast'

import type {
  CommandTaskDto,
  CommandTaskKind,
  CommandTaskLogEvent,
  CommandTaskStage
} from '../../../shared/contracts'

/** 单个任务的日志缓冲上限：与主进程的上限一致，避免两边表现不一致 */
const MAX_LOG_BYTES = 512 * 1024
/** stderr 片段前缀（与主进程约定） */
const STDERR_PREFIX = '\u0000stderr\u0001'

export interface CommandTaskLogLine {
  stream: 'stdout' | 'stderr'
  text: string
}

/**
 * 命令任务面板状态。
 *
 * 只做展示：命令由既有 Git 管理器执行，这里不做排队、不做门禁、不重放命令。
 */
export const useCommandTaskStore = defineStore('commandTask', () => {
  const tasks = ref<CommandTaskDto[]>([])
  const logs = ref<Record<string, CommandTaskLogLine[]>>({})
  const byteCounts = ref<Record<string, number>>({})
  const droppedBytes = ref<Record<string, number>>({})
  /** 面板当前展示的任务：null 表示展示交互式 Shell */
  const activeTaskId = ref<string | null>(null)
  const retrying = ref<Record<string, boolean>>({})
  /**
   * 最近一次认领失败的原因（例如底部面板标签已达上限被拦）。
   * 调用方据此把主进程给出的中文原因展示给用户，而不是只说「无法创建命令任务」。
   */
  const lastError = ref<string | null>(null)

  const active = computed(() => tasks.value.find((task) => task.id === activeTaskId.value) ?? null)
  const runningCount = computed(
    () => tasks.value.filter((task) => isActiveStatus(task.status)).length
  )

  function isActiveStatus(status: CommandTaskDto['status']): boolean {
    return (
      status === 'queued' ||
      status === 'saving' ||
      status === 'precheck' ||
      status === 'running' ||
      // 取消中：进程还没确认退出，仍算活动（不允许重试）
      status === 'canceling'
    )
  }

  function applyState(state: CommandTaskDto): void {
    const index = tasks.value.findIndex((task) => task.id === state.id)
    if (index === -1) tasks.value = [...tasks.value, state]
    else tasks.value = tasks.value.map((task) => (task.id === state.id ? state : task))
    // 新一轮运行（run 变化）时清掉上一轮的日志：旧运行的迟到输出不能混进新运行
    const previousRun = runById.get(state.id)
    if (previousRun !== undefined && previousRun !== state.run) {
      delete logs.value[state.id]
      delete byteCounts.value[state.id]
      delete droppedBytes.value[state.id]
    }
    runById.set(state.id, state.run)
  }

  const runById = new Map<string, number>()

  /** 追加日志：按代次过滤旧运行的迟到片段，并按上限滚动丢弃最旧的字节。 */
  function appendLog(event: CommandTaskLogEvent): void {
    const currentRun = runById.get(event.taskId)
    if (currentRun !== undefined && currentRun !== event.run) return
    const parsed = parseChunk(event.data)
    if (parsed.length === 0) return
    const existing = logs.value[event.taskId] ?? []
    let next = [...existing, ...parsed]
    let bytes = (byteCounts.value[event.taskId] ?? 0) + event.bytes
    let dropped = droppedBytes.value[event.taskId] ?? 0

    // 上限以外的部分丢最旧的整行：执行期间就生效，不是只在结束时截断
    while (bytes > MAX_LOG_BYTES && next.length > 1) {
      const removed = next.shift()
      if (removed) {
        const size = countBytes(removed.text)
        bytes -= size
        dropped += size
      }
    }
    // 单行就超上限：保留该行的尾部
    if (bytes > MAX_LOG_BYTES && next.length === 1) {
      const only = next[0]
      const trimmed = tailWithin(only.text, MAX_LOG_BYTES)
      next = [{ stream: only.stream, text: trimmed.kept }]
      dropped += bytes - trimmed.bytes
      bytes = trimmed.bytes
    }

    logs.value = { ...logs.value, [event.taskId]: next }
    byteCounts.value = { ...byteCounts.value, [event.taskId]: bytes }
    droppedBytes.value = { ...droppedBytes.value, [event.taskId]: dropped }
  }

  function parseChunk(data: string): CommandTaskLogLine[] {
    const parts = data.split(STDERR_PREFIX)
    const result: CommandTaskLogLine[] = []
    // 第一段是 stdout（可能为空）
    if (parts.length === 1) {
      for (const line of splitLines(parts[0])) result.push({ stream: 'stdout', text: line })
      return result
    }
    for (const line of splitLines(parts[0] ?? '')) result.push({ stream: 'stdout', text: line })
    for (let index = 1; index < parts.length; index += 1) {
      for (const line of splitLines(parts[index])) result.push({ stream: 'stderr', text: line })
    }
    return result
  }

  /** 保留空行信息：把一段文本拆成"行"，末尾换行不产生空行。 */
  function splitLines(text: string): string[] {
    if (!text) return []
    const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
    return normalized.split('\n')
  }

  function countBytes(text: string): number {
    return new TextEncoder().encode(text).length
  }

  function tailWithin(text: string, maxBytes: number): { kept: string; bytes: number } {
    const characters = Array.from(text)
    let kept = ''
    let bytes = 0
    for (let index = characters.length - 1; index >= 0; index -= 1) {
      const character = characters[index]
      const size = countBytes(character)
      if (bytes + size > maxBytes) break
      kept = character + kept
      bytes += size
    }
    return { kept, bytes }
  }

  async function load(): Promise<void> {
    const result = await window.desk.commandTask.list()
    if (!result.ok) return
    for (const task of result.value) applyState(task)
  }

  function subscribe(): () => void {
    const offChanged = window.desk.commandTask.onChanged((state) => applyState(state))
    const offLog = window.desk.commandTask.onLog((event) => appendLog(event))
    // 主进程移除了任务标签（用户关闭，或达到上限时被容量回收）：同步清掉本地标签与日志
    const offClosed = window.desk.commandTask.onClosed((taskId) => {
      tasks.value = tasks.value.filter((task) => task.id !== taskId)
      const nextLogs = { ...logs.value }
      delete nextLogs[taskId]
      logs.value = nextLogs
      if (activeTaskId.value === taskId) activeTaskId.value = null
    })
    return () => {
      offChanged()
      offLog()
      offClosed()
    }
  }

  /** 认领任务：同一 (知识库, 种类) 已有运行中的任务时返回它本身（不重复提交）。 */
  async function claim(input: {
    knowledgeBaseId: string
    kind: CommandTaskKind
    title: string
    cwd: string
    command?: string
  }): Promise<CommandTaskDto | null> {
    const result = await window.desk.commandTask.claim(input)
    if (!result.ok) {
      // 主进程的统一容量检查会在这里给出中文原因（标签达上限 / 上限调低等）
      lastError.value = result.error.message
      return null
    }
    lastError.value = null
    applyState(result.value)
    return result.value
  }

  async function reportStage(
    taskId: string,
    run: number,
    stage: CommandTaskStage,
    label: string
  ): Promise<boolean> {
    const result = await window.desk.commandTask.reportStage(taskId, run, stage, label)
    // 上报失败或这一轮已不是当前运行 → false，调用方不得继续进入 Git
    return result.ok ? result.value : false
  }

  /**
   * 声明「这一轮开始执行」（进入 Git 之前）。
   *
   * 推送的完整流程是「保存 → Git」：只有先声明，保存期间收到的取消才有归属，
   * 取消才不会去按知识库猜一个 Git 队列项、误伤同库其他排队任务。
   * 返回 false 表示这一轮已不是当前运行（已被取消/已被取代）。
   */
  async function begin(taskId: string, run: number): Promise<boolean> {
    const result = await window.desk.commandTask.begin(taskId, run)
    return result.ok ? result.value : false
  }

  async function finish(
    taskId: string,
    run: number,
    status: 'done' | 'failed' | 'timeout' | 'canceled',
    error: string | null
  ): Promise<void> {
    await window.desk.commandTask.finish(taskId, run, status, error)
  }

  async function cancel(taskId: string): Promise<void> {
    await window.desk.commandTask.cancel(taskId)
  }

  /** 关闭输出标签：只关视图，不影响正在运行的任务。 */
  async function closeTask(taskId: string): Promise<void> {
    await window.desk.commandTask.close(taskId)
    tasks.value = tasks.value.filter((task) => task.id !== taskId)
    delete logs.value[taskId]
    const nextLogs = { ...logs.value }
    delete nextLogs[taskId]
    logs.value = nextLogs
    if (activeTaskId.value === taskId) activeTaskId.value = null
  }

  /**
   * 请求重试。真正重跑由 App 接 `onRetryRequested` 调 workspace 的完整业务流程
   * （推送必须先保存），主进程不直接调 Git。
   */
  async function retry(taskId: string): Promise<void> {
    retrying.value = { ...retrying.value, [taskId]: true }
    try {
      const result = await window.desk.commandTask.retry(taskId)
      if (!result.ok) pushToast(result.error.message, 'error')
    } finally {
      const next = { ...retrying.value }
      delete next[taskId]
      retrying.value = next
    }
  }

  function select(taskId: string | null): void {
    activeTaskId.value = taskId
  }

  /** 打开某任务的输出（后台失败通知的「查看输出」入口）。 */
  function reveal(taskId: string): void {
    activeTaskId.value = taskId
  }

  function revealByKind(knowledgeBaseId: string, kind: CommandTaskKind): boolean {
    const task = tasks.value.find(
      (item) => item.knowledgeBaseId === knowledgeBaseId && item.kind === kind
    )
    if (!task) return false
    activeTaskId.value = task.id
    return true
  }

  function logsFor(taskId: string): CommandTaskLogLine[] {
    return logs.value[taskId] ?? []
  }

  function droppedFor(taskId: string): number {
    const local = droppedBytes.value[taskId] ?? 0
    const task = tasks.value.find((item) => item.id === taskId)
    return Math.max(local, task?.truncatedBytes ?? 0)
  }

  return {
    tasks,
    logs,
    activeTaskId,
    active,
    runningCount,
    retrying,
    lastError,
    subscribe,
    load,
    claim,
    reportStage,
    begin,
    finish,
    cancel,
    closeTask,
    retry,
    select,
    reveal,
    revealByKind,
    logsFor,
    droppedFor,
    isActiveStatus
  }
})

export { MAX_LOG_BYTES }
