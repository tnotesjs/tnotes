import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { TerminalSessionDto } from '../../../shared/contracts'

/**
 * 底部终端面板的状态。视图相关的量（是否展开、面板高度、最大化、当前标签）都在
 * 渲染端；会话本身由主进程的 Manager 持有——**收起面板不会结束任何进程**。
 */
const DEFAULT_PANEL_HEIGHT = 280
const MIN_PANEL_HEIGHT = 120
const DEFAULT_FONT_SIZE = 12
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 24
const FONT_SIZE_KEY = 'desk.terminal.fontSize'

export const useTerminalStore = defineStore('terminal', () => {
  const sessions = ref<TerminalSessionDto[]>([])
  const activeSessionId = ref<string | null>(null)
  const open = ref(false)
  const maximized = ref(false)
  /** 最大化前的高度，还原时用 */
  const height = ref(DEFAULT_PANEL_HEIGHT)
  const heightBeforeMaximize = ref(DEFAULT_PANEL_HEIGHT)
  const creating = ref(false)
  /** 终端字号：视图偏好，存 localStorage（不进 WorkspaceSession，与面板高度同层） */
  const fontSize = ref(Number(localStorage.getItem(FONT_SIZE_KEY)) || DEFAULT_FONT_SIZE)
  const lastError = ref<string | null>(null)

  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeSessionId.value) ?? null
  )
  const runningCount = computed(
    () => sessions.value.filter((session) => session.status === 'running').length
  )

  function applyState(state: TerminalSessionDto): void {
    const index = sessions.value.findIndex((session) => session.id === state.id)
    if (index === -1) sessions.value = [...sessions.value, state]
    else sessions.value = sessions.value.map((item) => (item.id === state.id ? state : item))
    if (!activeSessionId.value) activeSessionId.value = state.id
  }

  function removeState(sessionId: string): void {
    const next = sessions.value.filter((session) => session.id !== sessionId)
    sessions.value = next
    if (activeSessionId.value === sessionId) {
      activeSessionId.value = next.length > 0 ? next[next.length - 1].id : null
    }
  }

  async function load(): Promise<void> {
    const result = await window.desk.terminal.list()
    if (!result.ok) {
      lastError.value = result.error.message
      return
    }
    sessions.value = result.value
    if (!activeSessionId.value && result.value.length > 0) {
      activeSessionId.value = result.value[0].id
    }
  }

  function subscribe(): () => void {
    const offChanged = window.desk.terminal.onChanged((state) => applyState(state))
    const offData = window.desk.terminal.onData((event) => enqueue(event))
    return () => {
      offChanged()
      offData()
    }
  }

  /**
   * 输出分片的消费者登记表：xterm 实例挂载/卸载时登记。
   *
   * 数据不放进 pinia 状态——高速输出每秒几十 MB，进响应式系统会把 UI 拖死；
   * 这里只做「按会话转发」。
   */
  const terminalHandlers = new Map<string, (data: string, bytes: number) => void>()

  /**
   * 消费者就绪前（或卸载后短暂窗口内）到达的数据。
   *
   * 不能丢：这些字节主进程已经算进「已发送未回执」，直接忽略会让未确认量只增不减，
   * 会话最终被背压永久暂停。所以按会话缓冲，等 xterm 挂上来再按序回放。
   * 缓冲有界——渲染端如果真的卡死，宁可丢最旧的并计数，也不能无限吃内存。
   */
  const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
  const buffered = new Map<
    string,
    { chunks: Array<{ data: string; bytes: number }>; bytes: number }
  >()
  /** 因缓冲溢出被丢弃的字节数（观测用；溢出意味着渲染端跟不上） */
  const droppedBytes = ref(0)

  function enqueue(event: { sessionId: string; data: string; bytes: number }): void {
    const handler = terminalHandlers.get(event.sessionId)
    if (!handler) {
      bufferFor(event.sessionId, event.data, event.bytes)
      return
    }
    // 顺序与回执都由 handler（xterm 写队列）自己保证
    handler(event.data, event.bytes)
  }

  function bufferFor(sessionId: string, data: string, bytes: number): void {
    const entry = buffered.get(sessionId) ?? { chunks: [], bytes: 0 }
    entry.chunks.push({ data, bytes })
    entry.bytes += bytes
    while (entry.bytes > MAX_BUFFERED_BYTES && entry.chunks.length > 1) {
      const dropped = entry.chunks.shift()
      if (dropped) {
        entry.bytes -= dropped.bytes
        droppedBytes.value += dropped.bytes
      }
    }
    buffered.set(sessionId, entry)
  }

  function registerHandler(
    sessionId: string,
    handler: (data: string, bytes: number) => void
  ): () => void {
    terminalHandlers.set(sessionId, handler)
    // 回放缓冲：按到达顺序补齐，字节数照常回执
    const entry = buffered.get(sessionId)
    if (entry) {
      buffered.delete(sessionId)
      for (const chunk of entry.chunks) handler(chunk.data, chunk.bytes)
    }
    return () => {
      if (terminalHandlers.get(sessionId) === handler) terminalHandlers.delete(sessionId)
    }
  }

  function clearBuffered(sessionId: string): void {
    buffered.delete(sessionId)
  }

  async function createSession(knowledgeBaseId: string, cwd?: string): Promise<void> {
    creating.value = true
    lastError.value = null
    try {
      const result = await window.desk.terminal.create({ knowledgeBaseId, cwd })
      if (!result.ok) {
        lastError.value = result.error.message
        return
      }
      applyState(result.value)
      activeSessionId.value = result.value.id
      open.value = true
    } finally {
      creating.value = false
    }
  }

  async function restart(sessionId: string): Promise<void> {
    const result = await window.desk.terminal.restart(sessionId)
    if (result.ok) applyState(result.value)
    else lastError.value = result.error.message
  }

  async function renameSession(sessionId: string, title: string): Promise<void> {
    const result = await window.desk.terminal.rename(sessionId, title)
    if (result.ok) applyState(result.value)
  }

  async function closeSession(sessionId: string): Promise<void> {
    await window.desk.terminal.close(sessionId)
    clearBuffered(sessionId)
    removeState(sessionId)
  }

  async function closeAll(): Promise<void> {
    const ids = sessions.value.map((session) => session.id)
    for (const id of ids) {
      await window.desk.terminal.close(id)
      clearBuffered(id)
      removeState(id)
    }
  }

  function toggle(visible = !open.value): void {
    open.value = visible
  }

  function toggleMaximize(): void {
    if (maximized.value) {
      maximized.value = false
      height.value = heightBeforeMaximize.value
      return
    }
    heightBeforeMaximize.value = height.value
    maximized.value = true
  }

  function setFontSize(next: number): void {
    fontSize.value = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(next)))
    localStorage.setItem(FONT_SIZE_KEY, String(fontSize.value))
  }

  function adjustFontSize(delta: number): void {
    setFontSize(fontSize.value + delta)
  }

  function resetFontSize(): void {
    setFontSize(DEFAULT_FONT_SIZE)
  }

  function setHeight(next: number): void {
    height.value = Math.max(MIN_PANEL_HEIGHT, Math.round(next))
    maximized.value = false
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    runningCount,
    open,
    maximized,
    height,
    creating,
    lastError,
    subscribe,
    droppedBytes,
    registerHandler,
    clearBuffered,
    load,
    createSession,
    restart,
    renameSession,
    closeSession,
    closeAll,
    fontSize,
    toggle,
    toggleMaximize,
    setHeight,
    setFontSize,
    adjustFontSize,
    resetFontSize
  }
})

export { DEFAULT_PANEL_HEIGHT, MIN_PANEL_HEIGHT }
