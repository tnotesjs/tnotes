<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'

import { pushToast } from '../stores/toast'
import { useTerminalStore } from '../stores/terminal'

import type { TerminalSessionDto } from '../../../shared/contracts'

const props = defineProps<{ session: TerminalSessionDto; active: boolean }>()

const store = useTerminalStore()
const host = ref<HTMLDivElement | null>(null)

let terminal: Terminal | null = null
let fit: FitAddon | null = null
let search: SearchAddon | null = null
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
/** 窗口尺寸变化也要重新 fit：面板高度不变时 ResizeObserver 不触发，但终端宽度会变。 */
function onWindowResize(): void {
  scheduleFit()
}
let flushTimer: number | null = null
let fitTimer: number | null = null
let unregister: (() => void) | null = null
let disposed = false

/**
 * 回执批量上报。xterm 的 `write` 回调按块触发，逐块回执会把 IPC 打爆；
 * 攒到 ~50ms 或 256KB 再报一次，主进程据此在高低水位之间 pause/resume PTY。
 */
const ACK_INTERVAL_MS = 50
/**
 * 待回执字节，**按代次分组**。
 *
 * 不能只攒一个总数、到点再用"当前代次"发出去：xterm 的 write 回调是异步的，
 * 重启之后旧代次的回调仍会触发，那时按当前代次回执就会把旧账记到新进程头上
 * （主进程按代次过滤会忽略，等于这笔账没结算）。每笔回执必须带着**产出时的代次**。
 */
let pendingAckByGeneration = new Map<number, number>()

/**
 * 单次 IPC 写入的字符上限（与主进程 `WRITE_CHUNK_LIMIT` 对应，留一半余量）。
 * 大段粘贴必须分片，否则超过上限的整段输入会被主进程的 zod 直接拒掉。
 *
 * 分片按**码点**切，不能按 UTF-16 下标切：否则会在代理对（emoji）或组合字符
 * 中间断开。括号粘贴模式（`\x1b[200~…\x1b[201~`）的定界符与内容同属一次
 * onData，按序分片后依然保持顺序，shell 侧仍是一个完整的粘贴。
 */
const WRITE_CHUNK_CHARS = 32 * 1024
/** 写入失败时只提示一次，避免粘贴期间刷屏 */
let writeErrorShown = false

/**
 * 串行写队列：分片必须**按序**到达 PTY，且要等前一片的 IPC 回来再发下一片，
 * 否则大量并发 invoke 会打乱顺序。失败明确提示，不再静默丢弃。
 *
 * 队列绑定 `sessionId + generation`：重启后旧队列即使还有没发完的分片，也会因为
 * 代次不符被主进程拒绝，不会打进新 shell。
 */
function createWriteQueue(sessionId: string, generation: number) {
  let tail: Promise<void> = Promise.resolve()
  return (data: string): void => {
    const points = Array.from(data)
    for (let index = 0; index < points.length; index += WRITE_CHUNK_CHARS) {
      const chunk = points.slice(index, index + WRITE_CHUNK_CHARS).join('')
      tail = tail.then(async () => {
        const result = await window.desk.terminal.write(sessionId, chunk, generation)
        if (!result.ok) {
          if (!writeErrorShown) {
            writeErrorShown = true
            pushToast(`终端输入未能送达：${result.error.message}`, 'error')
          }
        }
      })
    }
  }
}

/** 当前写队列；挂载与重启时重建，避免旧运行的分片继续排队 */
let writeQueue: (data: string) => void = () => {}
let currentGeneration = 0

function scheduleAck(bytes: number, generation: number): void {
  pendingAckByGeneration.set(generation, (pendingAckByGeneration.get(generation) ?? 0) + bytes)
  if (flushTimer !== null) return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    flushPendingAcks()
  }, ACK_INTERVAL_MS)
}

/** 把按代次攒下的回执逐笔发出去，每笔用各自的代次。 */
function flushPendingAcks(): void {
  if (disposed) return
  const pending = pendingAckByGeneration
  pendingAckByGeneration = new Map()
  for (const [generation, bytes] of pending) {
    // 走 store 的显式入口：每笔回执携带**产出时的**代次，不查当前代次
    store.ackWithGeneration(props.session.id, bytes, generation)
  }
}

/** 主题跟随应用：颜色都取应用已有的 CSS 变量，避免终端里出现第二套配色。 */
function readTheme(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback
  const bg = read('--tn-c-bg', '#1b1b1f')
  return {
    background: bg,
    foreground: read('--tn-c-text', '#e6e6e6'),
    cursor: read('--tn-c-brand', '#a8b1ff'),
    cursorAccent: bg,
    selectionBackground: read('--tn-c-brand-soft', 'rgba(168,177,255,0.28)'),
    black: '#3b3b42',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#dcdfe4',
    brightBlack: '#5c6370',
    brightRed: '#ff7b86',
    brightGreen: '#b3e08c',
    brightYellow: '#ffd68a',
    brightBlue: '#7cc4ff',
    brightMagenta: '#e094f0',
    brightCyan: '#6fd6e2',
    brightWhite: '#ffffff'
  }
}

/** 尺寸变化要节流：拖动面板时每帧 resize 会让 SIGWINCH 风暴 + shell 重排。 */
function scheduleFit(): void {
  if (fitTimer !== null) return
  fitTimer = window.setTimeout(() => {
    fitTimer = null
    if (disposed || !fit || !terminal) return
    // 会话被 v-show 隐藏时容器是 0 尺寸：此时 fit 会算出一个无效列数并推给主进程，
    // 等它重新可见时再 fit（ResizeObserver 会再触发一次）。
    const box = host.value?.getBoundingClientRect()
    if (!box || box.width < 40 || box.height < 20) return
    try {
      fit.fit()
    } catch {
      /* 面板尺寸为 0（收起状态）时 fit 会抛，忽略 */
    }
    const { cols, rows } = terminal
    if (cols > 1 && rows > 0) void window.desk.terminal.resize(props.session.id, cols, rows)
  }, 80)
}

function mount(): void {
  if (!host.value || terminal) return
  const el = host.value
  terminal = new Terminal({
    fontFamily:
      getComputedStyle(document.documentElement).getPropertyValue('--tn-font-mono').trim() ||
      'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    // 中文按全宽计算：默认的 Unicode 版本表在某些 emoji/CJK 上会算错宽度
    theme: readTheme()
  })
  fit = new FitAddon()
  search = new SearchAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(search)
  terminal.open(el)
  terminal.options.fontSize = store.fontSize

  currentGeneration = props.session.generation
  writeQueue = createWriteQueue(props.session.id, currentGeneration)
  terminal.onData((data) => writeQueue(data))
  // 收到过输出就把提示符位置当作"已就绪"，焦点交给终端
  terminal.onResize(() => scheduleFit())

  unregister = store.registerHandler(props.session.id, (data, bytes, generation) => {
    if (!terminal) return
    // 回执闭包里捕获**这一块**的代次：回调可能在重启之后才触发
    terminal.write(data, () => scheduleAck(bytes, generation))
  })

  scheduleFit()
  resizeObserver = new ResizeObserver(() => scheduleFit())
  resizeObserver.observe(el)
  // 应用主题是 document.documentElement 上的 data-theme，切换时跟着换配色
  themeObserver = new MutationObserver(() => {
    if (terminal) terminal.options.theme = readTheme()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  })
  window.addEventListener('resize', onWindowResize)

  if (props.active) terminal.focus()
}

function unmount(): void {
  disposed = true
  if (flushTimer !== null) window.clearTimeout(flushTimer)
  if (fitTimer !== null) window.clearTimeout(fitTimer)
  flushTimer = null
  fitTimer = null
  resizeObserver?.disconnect()
  resizeObserver = null
  themeObserver?.disconnect()
  themeObserver = null
  window.removeEventListener('resize', onWindowResize)
  unregister?.()
  unregister = null
  terminal?.dispose()
  terminal = null
  fit = null
  search = null
}

onMounted(() => {
  // **所有会话都挂载**，不只是激活的那个：xterm 实例同时充当输出的消费者，
  // 非激活会话如果没消费者，它的输出就会落到 store 的缓冲里迟迟不回执。
  mount()
  if (props.active) {
    scheduleFit()
    terminal?.focus()
  }
})

watch(
  () => props.active,
  (active) => {
    if (active) {
      scheduleFit()
      terminal?.focus()
    }
  }
)

/**
 * 重启（代次变化）时的隔离：丢掉旧运行的待回执字节、清空屏幕与回滚缓冲、
 * 重建写队列。不做这一步，旧粘贴会打进新 shell、旧回执会扣新进程的账。
 */
watch(
  () => props.session.generation,
  (generation, previous) => {
    if (previous === undefined || generation === previous) return
    // 先把旧代次攒下的回执按**旧代次**发掉（主进程会按代次忽略，
    // 但账目不能挂在待发状态里永远留着）
    flushPendingAcks()
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer)
      flushTimer = null
    }
    pendingAckByGeneration = new Map()
    // 隔离旧代次缓冲：重启后不得把上一个进程的输出回放进新终端
    store.dropBufferedBefore(props.session.id, generation)
    currentGeneration = generation
    writeQueue = createWriteQueue(props.session.id, generation)
    writeErrorShown = false
    terminal?.reset()
    scheduleFit()
  }
)

onBeforeUnmount(unmount)

watch(
  () => store.fontSize,
  (size) => {
    if (!terminal) return
    terminal.options.fontSize = size
    scheduleFit()
  }
)

defineExpose({
  focus: () => terminal?.focus(),
  search: (term: string, direction: 'next' | 'prev') =>
    direction === 'next'
      ? (search?.findNext(term) ?? false)
      : (search?.findPrevious(term) ?? false),
  clear: () => terminal?.clear(),
  selectAll: () => terminal?.selectAll(),
  paste: (text: string) => terminal?.paste(text),
  getSelection: () => terminal?.getSelection() ?? ''
})
</script>

<template>
  <div ref="host" class="terminal-host" :data-session-id="session.id" />
</template>

<style scoped>
.terminal-host {
  width: 100%;
  height: 100%;
  padding: 4px 6px;
  overflow: hidden;
}

.terminal-host :deep(.xterm) {
  height: 100%;
}

.terminal-host :deep(.xterm-viewport) {
  background: transparent !important;
}
</style>
