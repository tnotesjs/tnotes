import { clipboard } from 'electron'
import { z } from 'zod'

import { IPC_CHANNELS } from '../../shared/contracts'
import { handle } from './shared'

import type { BrowserWindow } from 'electron'

/**
 * 只替换剪贴板的 `text/plain`，其它 flavor 原样保留。
 *
 * 为什么需要它：浏览器原生复制（Chromium 对 DOM 选区的复制）在某些结构下只写
 * `text/html`、不写 `text/plain` —— 复制图片就是这种（图片节点不贡献纯文本）。
 * 渲染端能算出"纯文本应该是什么"，却**没法只补这一半**：实测 `clipboard.write({ text })`
 * 会把 `text/html` 一起清掉，必须两种 flavor **同时**写。所以由主进程读现状再一并重写。
 */
export function registerClipboard(getWindow: () => BrowserWindow | null): () => void {
  handle(
    IPC_CHANNELS.clipboardSetPlainText,
    getWindow,
    z.object({ text: z.string().max(1_000_000), html: z.string().max(4_000_000).optional() }),
    (input) => {
      // 调用方给了 html 就用它（图片复制需要带上带 alt 的引用），否则沿用现有 html
      const html = input.html ?? clipboard.readHTML()
      // `bookmark` 在 Electron 里是对象（title + url），原样带回以免丢 flavor
      const bookmark = clipboard.readBookmark()
      const payload: Electron.Data = { text: input.text }
      if (html) payload.html = html
      if (bookmark.title || bookmark.url) payload.bookmark = bookmark.title || bookmark.url
      clipboard.write(payload)
      return { text: clipboard.readText(), html: clipboard.readHTML() }
    }
  )
  return () => {}
}
