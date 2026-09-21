// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeClipboardText } from './clipboardText'

/** 可切换的异步剪贴板 API（Desk 里它实际会因权限被拒而抛错） */
function installClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  })
}

afterEach(() => {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'clipboard')
  vi.restoreAllMocks()
})

describe('writeClipboardText', () => {
  it('异步 API 成功时不走同步兜底', async () => {
    const writeText = vi.fn(async () => undefined)
    installClipboard(writeText)
    const execCommand = vi.fn(() => true)
    document.execCommand = execCommand

    await expect(writeClipboardText('令牌')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('令牌')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('异步 API 被拒（NotAllowedError）时退回同步手势路径，并把文本真的放进 textarea', async () => {
    installClipboard(async () => {
      throw new DOMException('Write permission denied.', 'NotAllowedError')
    })
    let copied = ''
    let sawTextarea = false
    document.execCommand = vi.fn(() => {
      sawTextarea = document.querySelectorAll('textarea').length === 1
      copied = (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? ''
      return true
    })

    await expect(writeClipboardText('7nrCxsdjo3rT\n示例')).resolves.toBe(true)
    expect(copied).toBe('7nrCxsdjo3rT\n示例')
    expect(sawTextarea).toBe(true)
    // 兜底用的 textarea 用完要清掉，不能留在 DOM 里
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('两条路都失败时返回 false（调用方要据此提示用户）', async () => {
    installClipboard(async () => {
      throw new DOMException('Write permission denied.', 'NotAllowedError')
    })
    document.execCommand = vi.fn(() => false)

    await expect(writeClipboardText('令牌')).resolves.toBe(false)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })
})
