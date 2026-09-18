<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'

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
let pendingAckBytes = 0

function scheduleAck(bytes: number): void {
  pendingAckBytes += bytes
  if (flushTimer !== null) return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    const bytes = pendingAckBytes
    pendingAckBytes = 0
    if (bytes > 0 && !disposed) void window.desk.terminal.ack(props.session.id, bytes)
  }, ACK_INTERVAL_MS)
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

  terminal.onData((data) => {
    void window.desk.terminal.write(props.session.id, data)
  })
  // 收到过输出就把提示符位置当作"已就绪"，焦点交给终端
  terminal.onResize(() => scheduleFit())

  unregister = store.registerHandler(props.session.id, (data, bytes) => {
    if (!terminal) return
    terminal.write(data, () => scheduleAck(bytes))
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
  // 只渲染当前激活的会话：非激活会话由隐藏容器保留 DOM（见父组件的 v-show）
  if (props.active) mount()
})

watch(
  () => props.active,
  (active) => {
    if (active) {
      mount()
      scheduleFit()
      terminal?.focus()
    }
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
