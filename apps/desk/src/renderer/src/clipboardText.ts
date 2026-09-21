/**
 * 把纯文本写进系统剪贴板（渲染端通用）。
 *
 * 为什么不能只调 `navigator.clipboard.writeText`：Desk 主进程把 Electron 的权限请求一律拒绝
 * （`setPermissionRequestHandler(... callback(false))`），渲染端拿不到剪贴板写权限。
 * 实测这里 `navigator.permissions.query({name:'clipboard-write'})` 还报 `granted`，
 * 但真正的 `writeText` 会抛 `NotAllowedError: Write permission denied.` —— 只 catch 掉
 * 就是"点了复制没反应"。与编辑器里的复制（`MilkdownMarkdownEditor.writeClipboard`）一致，
 * 这里退回**同步用户手势**路径：隐藏 textarea + `execCommand('copy')`（实测在 Desk 里可用）。
 *
 * 返回是否真的写成功：调用方据此给用户反馈（不要静默）。
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限被拒 / 文档没焦点：落到下面的同步路径
    }
  }
  return copyViaSelection(text)
}

/** 同步路径：必须是**用户手势**触发（点击处理器里调用才有 transient activation） */
function copyViaSelection(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  try {
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
