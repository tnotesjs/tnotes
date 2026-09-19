import { CHECK_ICON, COPY_ICON } from '../../markdown/copyIcons'
import { createCodeExpandButton } from '../../markdown/codeBlockFullscreen'
import { UNLABELED_CODE_LANGUAGE } from '../../markdown/codeLanguage'
import {
  createContainerSourceEditor,
  type ContainerSourceEditorHandle
} from './containerSourceEditor'

export type CodeTabSaveResult = { ok: true } | { ok: false; message: string }

export interface CodeTabEditorHandle {
  getValue(): string
  setValue(value: string): void
  setSavedValue(value: string): void
  setLanguage(language: string): void
  destroy(): void
  isDirty(): boolean
  /** Persist if dirty (blur / tab switch / Mod-Enter). */
  flushSave(): Promise<void>
}

export interface MountCodeTabEditorOptions {
  initialContent: string
  /** Persist current editor value. Called on blur / Mod-Enter / flushSave. */
  onSave: (content: string) => Promise<CodeTabSaveResult>
  /** CodeMirror language id (js, json, bash, …). */
  language?: string
  /**
   * When true (default), show language input + copy in the top-right tools
   * cluster (same chrome as standalone milkdown code blocks).
   */
  showTools?: boolean
  /** Shared file resources follow workspace autosave settings instead of saving on blur. */
  saveOnBlur?: boolean
  /** Called after the user commits a typed language id. */
  onLanguageChange?: (language: string) => void | Promise<void>
  /** Optional clipboard writer; falls back to navigator.clipboard / execCommand. */
  onCopy?: (text: string) => void | Promise<void>
  /** Toggle dirty class on an ancestor (e.g. tab button / card). */
  onDirtyChange?: (dirty: boolean) => void
  /** Mirrors every user or programmatic document update to a shared resource store. */
  onChange?: (content: string) => void
  /** Clickable line highlights for this tab's CodeMirror. */
  lineHighlight?: {
    initial?: string
    onChange?: (encoded: string) => void
    readOnly?: () => boolean
  }
}

function normalizeLanguageInput(value: string): string {
  return value.trim() || UNLABELED_CODE_LANGUAGE
}

async function defaultCopy(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through — Electron may deny async clipboard without gesture path.
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

function readCmPlainText(host: HTMLElement): string {
  const lines = host.querySelectorAll('.cm-line')
  if (lines.length > 0) {
    return Array.from(lines, (line) => line.textContent ?? '').join('\n')
  }
  return host.querySelector('.cm-content')?.textContent ?? ''
}

/**
 * Mounts a code-block-like CodeMirror editor without Save/Revert chrome.
 * Writes back on blur and Mod-Enter; caller decides file vs note persistence.
 */
export function mountCodeTabEditor(
  host: HTMLElement,
  options: MountCodeTabEditorOptions
): CodeTabEditorHandle {
  let savedContent = options.initialContent
  let currentLanguage =
    (options.language || UNLABELED_CODE_LANGUAGE).trim() || UNLABELED_CODE_LANGUAGE
  let dirty = false
  let saving = false
  let cancelled = false
  let editor: ContainerSourceEditorHandle | null = null

  const shell = document.createElement('div')
  shell.className = 'desk-code-tab milkdown-code-block'

  const tools = document.createElement('div')
  tools.className = 'tools desk-code-tab__tools'

  const languageInput = document.createElement('input')
  languageInput.type = 'text'
  languageInput.className = 'desk-code-language'
  languageInput.spellcheck = false
  languageInput.autocomplete = 'off'
  languageInput.placeholder = UNLABELED_CODE_LANGUAGE
  languageInput.title = '语言'
  languageInput.setAttribute('aria-label', '语言')
  languageInput.value = currentLanguage

  const buttonGroup = document.createElement('div')
  buttonGroup.className = 'tools-button-group'

  const copyButton = document.createElement('button')
  copyButton.type = 'button'
  copyButton.className = 'copy-button'
  copyButton.title = '复制代码'
  copyButton.setAttribute('aria-label', '复制代码')
  copyButton.innerHTML = COPY_ICON
  buttonGroup.append(copyButton, createCodeExpandButton())
  tools.append(languageInput, buttonGroup)

  const cmHost = document.createElement('div')
  cmHost.className = 'desk-raw-block__include-cm desk-code-tab__cm'

  const statusEl = document.createElement('div')
  statusEl.className = 'desk-raw-block__include-status'
  statusEl.hidden = true

  if (options.showTools === false) {
    shell.append(cmHost)
  } else {
    shell.append(tools, cmHost)
  }
  host.replaceChildren(shell, statusEl)

  const setStatus = (message: string, kind: 'idle' | 'error' | 'ok' = 'idle'): void => {
    if (!message) {
      statusEl.hidden = true
      statusEl.textContent = ''
      statusEl.dataset.kind = 'idle'
      return
    }
    statusEl.hidden = false
    statusEl.textContent = message
    statusEl.dataset.kind = kind
  }

  const syncDirtyUi = (): void => {
    shell.classList.toggle('is-dirty', dirty)
    options.onDirtyChange?.(dirty)
  }

  const applyLanguage = (language: string): void => {
    currentLanguage = normalizeLanguageInput(language)
    languageInput.value = currentLanguage
    languageInput.size = Math.max(2, currentLanguage.length)
  }

  const commitLanguage = async (): Promise<void> => {
    const next = normalizeLanguageInput(languageInput.value)
    if (next === currentLanguage) {
      languageInput.value = next
      languageInput.size = Math.max(2, next.length)
      return
    }
    applyLanguage(next)
    editor?.setLanguage(next)
    await options.onLanguageChange?.(next)
  }

  applyLanguage(currentLanguage)
  languageInput.addEventListener('mousedown', (event) => event.stopPropagation())
  languageInput.addEventListener('pointerdown', (event) => event.stopPropagation())
  languageInput.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      languageInput.blur()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      languageInput.value = currentLanguage
      languageInput.size = Math.max(2, currentLanguage.length)
      languageInput.blur()
    }
  })
  languageInput.addEventListener('input', () => {
    languageInput.size = Math.max(2, languageInput.value.length || 1)
  })
  languageInput.addEventListener('change', () => {
    void commitLanguage()
  })
  languageInput.addEventListener('blur', () => {
    void commitLanguage()
  })

  copyButton.addEventListener('click', (event) => {
    // Capture handler on the editor also targets `.copy-button`; stop here so
    // we own the payload (CM line join) and avoid a double write.
    event.preventDefault()
    event.stopPropagation()
    const text = editor?.getValue() ?? readCmPlainText(cmHost)
    void (async () => {
      try {
        if (options.onCopy) await options.onCopy(text)
        else await defaultCopy(text)
        copyButton.dataset.copied = 'true'
        copyButton.innerHTML = CHECK_ICON
        copyButton.title = '已复制'
        copyButton.setAttribute('aria-label', '已复制')
        window.setTimeout(() => {
          delete copyButton.dataset.copied
          copyButton.innerHTML = COPY_ICON
          copyButton.title = '复制代码'
          copyButton.setAttribute('aria-label', '复制代码')
        }, 1200)
      } catch {
        /* ignore */
      }
    })()
  })

  let saveChain: Promise<void> | null = null

  /** 串行化保存：拆除前要等正在进行的保存结束，若期间又变脏就再存一次。 */
  const saveAllPending = (): Promise<void> => {
    if (saveChain) return saveChain.then(() => (dirty ? saveAllPending() : undefined))
    saveChain = save()
      .catch(() => undefined)
      .finally(() => {
        saveChain = null
      })
    return saveChain
  }

  const save = async (): Promise<void> => {
    if (!editor || !dirty || saving || cancelled) return
    saving = true
    syncDirtyUi()
    try {
      const content = editor.getValue()
      const result = await options.onSave(content)
      if (cancelled) return
      if (!result.ok) {
        setStatus(`保存失败：${result.message}`, 'error')
        return
      }
      savedContent = content
      dirty = false
      setStatus('')
    } catch (error) {
      if (cancelled) return
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      saving = false
      syncDirtyUi()
    }
  }

  editor = createContainerSourceEditor(
    cmHost,
    options.initialContent,
    (value) => {
      dirty = value !== savedContent
      if (dirty) setStatus('')
      syncDirtyUi()
      options.onChange?.(value)
    },
    () => {
      void save()
    },
    {
      language: options.language,
      lineHighlight: options.lineHighlight,
      // 代码组面板与普通代码块口径一致：长行不折、块内横向滚动
      lineWrapping: false
    }
  )
  syncDirtyUi()

  // Inline blocks commit on blur; shared files use the workspace's autosave policy.
  shell.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null
    if (next && shell.contains(next)) return
    if (next && tools.contains(next)) return
    if (options.saveOnBlur !== false) void save()
  })

  return {
    getValue: () => editor?.getValue() ?? savedContent,
    setValue: (value: string) => editor?.setValue(value),
    setSavedValue: (value: string) => {
      savedContent = value
      dirty = (editor?.getValue() ?? value) !== savedContent
      syncDirtyUi()
    },
    setLanguage: (language: string) => {
      applyLanguage(language)
      editor?.setLanguage(language)
    },
    destroy: () => {
      if (cancelled) return
      const finish = (): void => {
        cancelled = true
        editor?.destroy()
        editor = null
      }
      if (!editor) {
        finish()
        return
      }
      // 程序化拆除 NodeView 不会触发 focusout：dirty 内容必须先落盘再销毁
      void saveAllPending().then(finish, finish)
    },
    isDirty: () => dirty,
    flushSave: () => saveAllPending()
  }
}
