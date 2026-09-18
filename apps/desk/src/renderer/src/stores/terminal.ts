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
    const offData = window.desk.terminal.onData((event) => {
      terminalHandlers.get(event.sessionId)?.(event.data, event.bytes)
    })
    return () => {
      offChanged()
      offData()
    }
  }

  /**
   * 输出分片的消费者登记表：xterm 实例挂载/卸载时登记。
   *
   * 数据不放进 pinia 状态——高速输出每秒几十 MB，进响应式系统会把 UI 拖死；
   * 这里只做「按会话转发」，缓冲与流控都在各自 xterm 实例上。
   */
  const terminalHandlers = new Map<string, (data: string, bytes: number) => void>()

  function registerHandler(
    sessionId: string,
    handler: (data: string, bytes: number) => void
  ): () => void {
    terminalHandlers.set(sessionId, handler)
    return () => {
      if (terminalHandlers.get(sessionId) === handler) terminalHandlers.delete(sessionId)
    }
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
    removeState(sessionId)
  }

  async function closeAll(): Promise<void> {
    const ids = sessions.value.map((session) => session.id)
    for (const id of ids) {
      await window.desk.terminal.close(id)
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
    registerHandler,
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
