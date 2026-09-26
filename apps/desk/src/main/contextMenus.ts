import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

import type { ContextMenuAction, ContextMenuRequest } from '../shared/contracts'
import { loadSettings } from './settings'

export function contextMenuTemplate(
  request: ContextMenuRequest,
  select: (action: ContextMenuAction) => void,
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  const primary = platform === 'darwin' ? '⌘' : 'Ctrl'
  const revealLabel =
    platform === 'darwin'
      ? '在 Finder 中显示'
      : platform === 'win32'
        ? '在文件资源管理器中显示'
        : '打开所在文件夹'
  const item = (
    id: ContextMenuAction,
    label: string,
    accelerator?: string
  ): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    // These shortcuts are handled by TabShortcutResolver; the menu only displays them.
    registerAccelerator: false,
    click: () => select(id)
  })
  const creationAndDeletion: MenuItemConstructorOptions[] = [
    { type: 'separator' },
    item('add-before', '在上方添加'),
    item('add-after', '在下方添加'),
    { type: 'separator' },
    item('request-delete', '永久删除')
  ]
  if (request.kind === 'group') {
    return [item('rename', '重命名'), ...creationAndDeletion]
  }
  if (request.kind === 'code-group-tab') {
    return [item('rename', '重命名'), item('request-delete', '删除代码块')]
  }
  const pinLabel = request.pinned ? '解除固定' : '固定'
  if (request.kind === 'note') {
    return [
      item('add-to-agent', '添加到对话'),
      { type: 'separator' },
      item('copy-path', '复制路径'),
      item('reveal-file', revealLabel),
      item('toggle-pin', pinLabel),
      item('toggle-toc-pin', request.tocPinned ? '取消置顶' : '置顶'),
      { type: 'separator' },
      item('open-split', '在右侧打开'),
      item('show-note-assets', '显示本笔记资源'),
      item('show-history', '历史版本'),
      item('rename', '重命名'),
      item('reindex', '修改索引'),
      item('toggle-done', request.completed ? '标记为未完成' : '标记为完成'),
      item('open-ide', `在 ${loadSettings().ide === 'cursor' ? 'Cursor' : 'VSCode'} 中打开`),
      ...creationAndDeletion
    ]
  }
  // Electron accelerators cannot represent multi-step chords. Keep those hints in
  // the label while using the native accelerator column for single-step shortcuts.
  const template: MenuItemConstructorOptions[] = [
    { ...item('close', '关闭', 'CommandOrControl+W'), enabled: !request.pinned },
    { ...item('close-others', '关闭其它 tab'), enabled: request.othersClosable !== false },
    item('close-saved', `关闭已保存笔记    ${primary} K U`),
    item('close-all', `全部关闭    ${primary} K W`),
    item('close-web', '关闭所有网页 tab')
  ]
  if (request.tabType === 'note') {
    template.push(
      { type: 'separator' },
      item('add-to-agent', '添加到对话'),
      item('copy-path', '复制路径', 'Alt+CommandOrControl+C'),
      item('reveal-file', revealLabel, 'Alt+CommandOrControl+R'),
      item('reveal-toc', '在目录列表中显示'),
      item('show-note-assets', '显示本笔记资源')
    )
  }
  template.push({ type: 'separator' }, item('toggle-pin', `${pinLabel}    ${primary} K ⇧ Enter`))
  return template
}

export function showContextMenu(
  window: BrowserWindow,
  request: ContextMenuRequest
): Promise<ContextMenuAction | null> {
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate(contextMenuTemplate(request, resolve))
    menu.popup({
      window,
      // Some platforms report dismissal before dispatching the selected item's click.
      callback: () => setImmediate(() => resolve(null))
    })
  })
}
