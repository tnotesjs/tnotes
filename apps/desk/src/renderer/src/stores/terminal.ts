import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { pushToast } from './toast'

import type { TerminalDataEvent, TerminalSessionDto } from '../../../shared/contracts'

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

/** 消费者就绪前暂存的输出分片。 */
interface BufferedChunk {
  data: string
  bytes: number
  /** 这段输出**产生时**的代次：回执必须原样带回，不能查"当前代次"顶替 */
  generation: number
}

interface BufferedOutput {
  chunks: BufferedChunk[]
  bytes: number
}

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
    generationById.set(state.id, state.generation)
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
    // 代次记录保留到缓冲也清干净之后（先清缓冲再删记录，见 closeSession）
  }

  async function load(): Promise<void> {
    const result = await window.desk.terminal.list()
    if (!result.ok) {
      lastError.value = result.error.message
      return
    }
    // 走 applyState 而不是直接赋值：它会登记每个会话的代次，而代次是回执结算的前提。
    // 直接覆盖 sessions.value 会让首次加载进来的会话没有代次记录，
    // 于是它们的丢弃字节永远平不了账。
    for (const session of result.value) applyState(session)
    if (!activeSessionId.value && result.value.length > 0) {
      activeSessionId.value = result.value[0].id
    }
  }

  function subscribe(): () => void {
    const offChanged = window.desk.terminal.onChanged((state) => applyState(state))
    const offData = window.desk.terminal.onData((event) => enqueue(event))
    // 主进程移除了会话（用户关闭，或达到上限时被容量回收）：清掉本地标签与缓冲。
    // 少了这条，被回收的会话会留下一个点不动的空标签。
    const offClosed = window.desk.terminal.onClosed((sessionId) => {
      clearBuffered(sessionId)
      removeState(sessionId)
    })
    return () => {
      offChanged()
      offData()
      offClosed()
    }
  }

  /**
   * 输出分片的消费者登记表：xterm 实例挂载/卸载时登记。
   *
   * 数据不放进 pinia 状态——高速输出每秒几十 MB，进响应式系统会把 UI 拖死；
   * 这里只做「按会话转发」。
   */
  type TerminalConsumer = (data: string, bytes: number, generation: number) => void
  const terminalHandlers = new Map<string, TerminalConsumer>()

  /**
   * 消费者就绪前（或卸载后短暂窗口内）到达的数据。
   *
   * 不能丢：这些字节主进程已经算进「已发送未回执」，直接忽略会让未确认量只增不减，
   * 会话最终被背压永久暂停。所以按会话缓冲，等 xterm 挂上来再按序回放。
   * 缓冲有界——渲染端如果真的卡死，宁可丢最旧的并计数，也不能无限吃内存。
   */
  const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
  const buffered = new Map<string, BufferedOutput>()
  /**
   * 每个会话当前的运行代次。**不能只从 `sessions.value` 里查**：会话被关闭移出列表后
   * 仍可能有已缓冲/已丢弃的字节要结算，查不到代次就等于这笔账永远平不了。
   */
  const generationById = new Map<string, number>()
  /** 因缓冲溢出被丢弃的字节数（观测用；溢出意味着渲染端跟不上） */
  const droppedBytes = ref(0)

  function enqueue(event: TerminalDataEvent): void {
    const handler = terminalHandlers.get(event.sessionId)
    if (!handler) {
      bufferFor(event)
      return
    }
    // 顺序与回执都由 handler（xterm 写队列）自己保证；代次随数据一起交给它
    handler(event.data, event.bytes, event.generation)
  }

  function bufferFor(event: TerminalDataEvent): void {
    const entry: BufferedOutput = buffered.get(event.sessionId) ?? { chunks: [], bytes: 0 }
    entry.chunks.push({ data: event.data, bytes: event.bytes, generation: event.generation })
    entry.bytes += event.bytes
    // 上限对**总字节数**有效：单块自己就超过上限时也要丢掉，否则上限形同虚设
    // 被丢掉的块可能来自不同代次：按 (代次 → 字节) 分别记账，回执时不丢代次
    const droppedByGeneration = new Map<number, number>()
    while (entry.bytes > MAX_BUFFERED_BYTES && entry.chunks.length > 0) {
      const dropped = entry.chunks.shift()
      if (dropped) {
        entry.bytes -= dropped.bytes
        droppedBytes.value += dropped.bytes
        droppedByGeneration.set(
          dropped.generation,
          (droppedByGeneration.get(dropped.generation) ?? 0) + dropped.bytes
        )
      }
    }
    buffered.set(event.sessionId, entry)
    // 这一瞬间还没有消费者，被丢弃的字节不会有回执——当场按**它们自己的代次**补上。
    // 不能用"当前代次"：跨代次时会变成给新进程发旧账（主进程会忽略，等于没结算）。
    for (const [generation, bytes] of droppedByGeneration) {
      ackWithoutConsumer(event.sessionId, bytes, generation)
    }
  }

  /**
   * 回执「到不了 xterm 的字节」。
   *
   * 这些字节主进程已经算进「已发送未回执」，而它们不会有 xterm 的 write 回调，
   * 不同步回执就永远扣不掉，会话会被背压永久暂停。丢弃是有界缓冲的代价，但账必须平。
   *
   * `generation` 缺省取当前代次；重启场景由调用方显式传入旧代次（主进程会按代次忽略）。
   */
  function ackWithoutConsumer(sessionId: string, bytes: number, generation?: number): void {
    if (bytes <= 0) return
    const target = generation ?? generationById.get(sessionId)
    if (target === undefined) return
    ackWithGeneration(sessionId, bytes, target)
  }

  /**
   * 回执的唯一出口：**必须显式给出字节产出时的代次**。
   *
   * 单独抽出来是为了让"延迟回执仍带旧代次"可以被确定性测试 —— 回执路径上不允许
   * 再去查"当前代次"。
   */
  function ackWithGeneration(sessionId: string, bytes: number, generation: number): void {
    if (bytes <= 0) return
    void window.desk.terminal.ack(sessionId, bytes, generation)
  }

  function registerHandler(sessionId: string, handler: TerminalConsumer): () => void {
    terminalHandlers.set(sessionId, handler)
    // 先把缓冲取出来（并从表里移除，避免回放期间又被写回），再按序回放。
    // 回放的字节由消费端（xterm 的 write 回调）回执，且必须带上**各自的**代次；
    // 被丢弃的字节在丢弃那一刻就已经结算过了，这里不重复回执。
    const entry = buffered.get(sessionId)
    if (entry) {
      buffered.delete(sessionId)
      const current = generationById.get(sessionId)
      for (const chunk of entry.chunks) {
        // 换代后旧代次的缓冲不回放：那些输出属于已经结束的进程，
        // 打进新终端只会让人误读。同时把它们的字节按旧代次结算掉（主进程忽略，
        // 但账目自洽；新代次的未确认量也不会被误扣）。
        if (current !== undefined && chunk.generation !== current) {
          ackWithoutConsumer(sessionId, chunk.bytes, chunk.generation)
          continue
        }
        handler(chunk.data, chunk.bytes, chunk.generation)
      }
    }
    return () => {
      if (terminalHandlers.get(sessionId) === handler) terminalHandlers.delete(sessionId)
    }
  }

  function clearBuffered(sessionId: string): void {
    buffered.delete(sessionId)
    generationById.delete(sessionId)
  }

  /**
   * 运行代次变化：丢掉**旧代次**还留在缓冲里的输出，并按旧代次结算它们的字节。
   *
   * 不能留在缓冲里等消费者注册——那时回放会把上一个进程的输出打进新终端。
   */
  function dropBufferedBefore(sessionId: string, currentGeneration: number): void {
    const entry = buffered.get(sessionId)
    if (!entry) return
    const keep: BufferedChunk[] = []
    let keptBytes = 0
    // 按**被丢弃块自己的**代次分组结算，不能用当前代次顶替：
    // 否则等于给新进程发旧账（主进程会按代次忽略，实际就没结算）。
    const droppedByGeneration = new Map<number, number>()
    for (const chunk of entry.chunks) {
      if (chunk.generation === currentGeneration) {
        keep.push(chunk)
        keptBytes += chunk.bytes
      } else {
        droppedByGeneration.set(
          chunk.generation,
          (droppedByGeneration.get(chunk.generation) ?? 0) + chunk.bytes
        )
      }
    }
    if (droppedByGeneration.size === 0) return
    if (keep.length === 0) buffered.delete(sessionId)
    else buffered.set(sessionId, { chunks: keep, bytes: keptBytes })
    for (const [generation, bytes] of droppedByGeneration) {
      ackWithoutConsumer(sessionId, bytes, generation)
    }
  }

  async function createSession(knowledgeBaseId: string, cwd?: string): Promise<void> {
    creating.value = true
    lastError.value = null
    try {
      const result = await window.desk.terminal.create({ knowledgeBaseId, cwd })
      if (!result.ok) {
        // 容量被占满时主进程会拒绝并给出中文原因（见 shared/bottomPanelTabs）：
        // 这里必须直接提示用户，否则「点了没反应」看起来像卡死
        lastError.value = result.error.message
        pushToast(result.error.message, 'error')
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
    ackWithGeneration,
    clearBuffered,
    dropBufferedBefore,
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
