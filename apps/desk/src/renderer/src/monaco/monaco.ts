/**
 * Monaco 懒加载入口（全仓库唯一 import monaco-editor 的地方）。
 *
 * 两个环境事实决定这里的配置：
 *
 * 1. **生产环境渲染端是 `file://` 加载**（`window.loadFile`），Chromium 不允许
 *    从 file:// 起 Worker；CSP 又是 `script-src 'self'`，blob: 也被挡。
 *    所以这里不注册 worker（`getWorker` 直接抛明确错误），并把需要 worker 的能力
 *    全部关掉：JSON/YAML/TS 的诊断、diff 计算、基于词的建议、链接识别。
 *    只读查看与 Markdown 编辑都不依赖这些；真需要语言服务时，得先把渲染端改成
 *    自定义协议加载 —— 那是单独一件事，不在这里偷偷加 `unsafe-eval` 或放宽 CSP。
 * 2. **主题跟随 Desk 自己的色板**：从 `documentElement` 读 CSS 变量现算一套
 *    → 明暗切换不需要两套硬编码配色，也不会和编辑器区域脱节。
 */
import type * as MonacoApi from 'monaco-editor'

export type Monaco = typeof MonacoApi

const LIGHT_THEME = 'tnotes-light'
const DARK_THEME = 'tnotes-dark'

let loading: Promise<Monaco> | null = null
let configured = false

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * 把 CSS 颜色变成 Monaco 能解析的十六进制。
 *
 * Monaco 的颜色解析器只认 `#rgb/#rrggbb/#rrggbbaa`（不认 `color-mix()`、
 * 也不认 CSS Color 4 的 `rgb(r g b / a)`）。喂不进去时它会**回退成纯红**
 * （实测选中背景变成 `rgb(255,0,0)`）。所以这里统一用浏览器把颜色解析成
 * 计算值，再转成 `#rrggbb[aa]`：拿不到就退回给定的安全值。
 */
function toMonacoColor(value: string, fallback: string): string {
  if (HEX_COLOR.test(value.trim())) return value.trim()
  if (typeof document === 'undefined') return fallback
  const probe = document.createElement('span')
  probe.style.backgroundColor = value
  probe.style.display = 'none'
  document.body.append(probe)
  const computed = getComputedStyle(probe).backgroundColor
  probe.remove()
  const match = /^rgba?\(([^)]+)\)$/.exec(computed)
  if (!match) return fallback
  const parts = match[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number)
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return fallback
  const [r, g, b] = parts
  const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
  const hex = `#${[r, g, b].map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}`
  if (alpha >= 1) return hex
  return `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`
}

/**
 * 用 Desk 的 CSS 变量现算一套 Monaco 主题。
 *
 * Monaco 的主题是命令式 API（`defineTheme`），同一个名字重复定义就是覆盖，
 * 所以明暗切换直接重定义再 `setTheme`。
 */
function defineTheme(monaco: Monaco): void {
  const dark = document?.documentElement.dataset.theme === 'dark'
  const background = toMonacoColor(cssVar('--editor-bg', dark ? '#1b1b1f' : '#ffffff'), '#ffffff')
  const foreground = toMonacoColor(cssVar('--text', dark ? '#dfdfd6' : '#1f2328'), '#1f2328')
  const muted = toMonacoColor(cssVar('--muted', '#8a8a8a'), '#8a8a8a')
  const border = toMonacoColor(cssVar('--border', dark ? '#2e2e32' : '#e5e7eb'), '#e5e7eb')
  const accent = toMonacoColor(cssVar('--accent-strong', '#3b82f6'), '#3b82f6')
  // 选中背景直接取 VS Code 自己的默认值（用户要求与 VS Code 一致）：
  // 深色 #264F78 / 浅色 #ADD6FF，失焦时用 #3A3D41 / #E5EBF1
  const selection = dark ? '#264f78' : '#add6ff'
  const selectionInactive = dark ? '#3a3d41' : '#e5ebf1'

  const base: MonacoApi.editor.IStandaloneThemeData['base'] = dark ? 'vs-dark' : 'vs'
  monaco.editor.defineTheme(base === 'vs-dark' ? DARK_THEME : LIGHT_THEME, {
    base,
    inherit: true,
    rules: [
      { token: 'comment', foreground: muted.replace('#', '') },
      { token: 'keyword', foreground: accent.replace('#', '') }
    ],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
      'editorLineNumber.foreground': muted,
      'editorLineNumber.activeForeground': foreground,
      'editor.lineHighlightBackground': border,
      'editor.selectionBackground': selection,
      'editor.inactiveSelectionBackground': selectionInactive,
      'editor.selectionHighlightBackground': selectionInactive,
      'editor.findMatchBackground': dark ? '#9e6a03' : '#a8ac94',
      'editor.findMatchHighlightBackground': dark ? '#ea5c0055' : '#ea5c0055',
      'editorCursor.foreground': accent,
      'editorWidget.background': background,
      'editorWidget.border': border,
      'editorIndentGuide.background1': border,
      'scrollbarSlider.background': border
    }
  })
}

/** 当前应当使用的 Monaco 主题名（已定义；未加载时会先加载） */
export function monacoThemeName(): string {
  return document?.documentElement.dataset.theme === 'dark' ? DARK_THEME : LIGHT_THEME
}

/**
 * 懒加载 Monaco（只加载一次），并把环境与主题配置好。
 *
 * 加载失败（依赖预构建 hash 过期 / 断网 / chunk 404）时**不要**把 rejected promise
 * 缓存下来：否则调用方重试永远拿到同一个失败结果。清掉缓存后重试会重新发起 import。
 */
export function loadMonaco(): Promise<Monaco> {
  loading ??= loadMonacoOnce().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

async function loadMonacoOnce(): Promise<Monaco> {
  return (async () => {
    const monaco = await import('monaco-editor')
    if (!configured) {
      configured = true
      // 见文件头：不注册 worker，明确抛错而不是静默挂起
      ;(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
        getWorker: () => {
          throw new Error(
            'Desk 不注册 Monaco worker（file:// + CSP 限制）；需要语言服务请先改造渲染端加载方式'
          )
        }
      }
      // 语言特性（json/css/html/typescript）已被 alias 成空模块（见 electron.vite.config.ts）：
      // 做成空模块的目的就是不起 worker，所以这里没有需要"关掉"的默认值了。
    }
    defineTheme(monaco)
    // find widget 的图标是 codicon 字形：字体没到位时会先画成空白小方块
    // （首次按下 Cmd+F 的一两百毫秒）。这里提前把字体拉起来，避免"图标丢失"的观感。
    void document.fonts?.load('16px codicon').catch(() => undefined)
    return monaco
  })()
}

/** 明暗主题变化时重算主题并广播（已挂载的编辑器各自 setTheme） */
export function refreshMonacoTheme(monaco: Monaco): void {
  defineTheme(monaco)
  monaco.editor.setTheme(monacoThemeName())
}

/** 只读文本查看器的默认配置（复用给其它只读场景） */
export function readOnlyEditorOptions(): MonacoApi.editor.IStandaloneEditorConstructionOptions {
  return {
    ...baseEditorOptions(),
    readOnly: true,
    domReadOnly: true,
    renderValidationDecorations: 'off',
    quickSuggestions: false,
    occurrencesHighlight: 'off',
    selectionHighlight: false
  }
}

/** 编辑器通用外观：跟随应用字体与行高，关掉不需要的重型功能 */
export function baseEditorOptions(): MonacoApi.editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'none',
    fixedOverflowWidgets: true,
    smoothScrolling: true,
    fontFamily: cssVar('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
    fontSize: 13,
    lineHeight: 20,
    padding: { top: 8, bottom: 8 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    wordWrap: 'off',
    /**
     * Unicode 易混淆字符高亮：显式允许简体 / 繁体中文。
     *
     * Monaco 默认只给 `{ _os: true, _vscode: true }`，这两个解析后若都落不到内置语言表上
     * （`_os` 解析出来是带地区的 `zh-Hans-CN` 这类名字，`_vscode` 在无 nls 的 standalone
     * 装配下可能为空），就回退到兜底表 `_default` —— 那里把 `（）` `，` `；` `？` 等
     * **全角标点**判为“与半角字符易混淆”，于是中文笔记的源码视图里满是黄框。
     * 语言表按 `allowedLocales` 求**交集**，且表里只有 `zh-hans` / `zh-hant`（写 `zh` 命中不了），
     * 所以两个都要给。不可见字符（`_common`）与西里尔/拉丁这类真混淆字符仍会提示 ——
     * 行为由 `scripts/e2e-source-unicode-highlight.mjs` 按行断言。
     */
    unicodeHighlight: {
      allowedLocales: { 'zh-hans': true, 'zh-hant': true }
    },
    // 只读查看不需要这些
    folding: true,
    glyphMargin: false,
    lineNumbersMinChars: 3,
    tabSize: 2
  } as MonacoApi.editor.IStandaloneEditorConstructionOptions
}
