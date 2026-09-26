/**
 * Native Electron menus for the knowledge / navigator sidebar ⋯ buttons.
 */

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

import { maxBatchNoteCount } from '../shared/noteBatch'
import type {
  KnowledgeSidebarMenuAction,
  KnowledgeSidebarMenuRequest,
  NavigatorSidebarMenuAction,
  NavigatorSidebarMenuRequest
} from '../shared/contracts'

function revealWorkspaceLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '在访达中打开'
  if (platform === 'win32') return '在资源管理器中打开'
  return '打开工作区目录'
}

export function knowledgeSidebarMenuTemplate(
  request: KnowledgeSidebarMenuRequest,
  select: (action: KnowledgeSidebarMenuAction) => void,
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  const item = (
    id: KnowledgeSidebarMenuAction,
    label: string,
    enabled = true
  ): MenuItemConstructorOptions => ({
    id,
    label,
    enabled,
    click: () => select(id)
  })
  return [
    item('create', '新建知识库', !request.loading),
    item('refresh', '重新扫描知识库', !request.loading),
    { type: 'separator' },
    item('reveal-workspace', revealWorkspaceLabel(platform), request.hasWorkspace),
    item('choose-workspace', '更换工作区')
  ]
}

export function navigatorSidebarMenuTemplate(
  request: NavigatorSidebarMenuRequest,
  select: (action: NavigatorSidebarMenuAction) => void
): MenuItemConstructorOptions[] {
  const item = (
    id: NavigatorSidebarMenuAction,
    label: string,
    enabled = true
  ): MenuItemConstructorOptions => ({
    id,
    label,
    enabled,
    click: () => select(id)
  })
  const ready = request.ready
  return [
    item('create-note', '新建笔记', ready),
    item('create-notes', '新建多篇笔记', ready && maxBatchNoteCount(request.noteCount) >= 1),
    item('create-group', '新建分组', ready),
    item('batch-delete', '批量删除', ready && request.noteCount > 0),
    item('preview', request.previewLabel, ready),
    item('build', request.buildBusy ? '正在构建站点' : '构建站点', ready && !request.buildBusy),
    { type: 'separator' },
    item('assets', '资源', ready),
    item('settings', '知识库配置', ready),
    item('ide', '使用 IDE 打开', ready),
    item('reveal', '打开知识库目录', ready)
  ]
}

export function showKnowledgeSidebarMenu(
  window: BrowserWindow,
  request: KnowledgeSidebarMenuRequest
): Promise<KnowledgeSidebarMenuAction | null> {
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate(
      knowledgeSidebarMenuTemplate(request, (action) => resolve(action))
    )
    menu.popup({
      window,
      callback: () => setImmediate(() => resolve(null))
    })
  })
}

export function showNavigatorSidebarMenu(
  window: BrowserWindow,
  request: NavigatorSidebarMenuRequest
): Promise<NavigatorSidebarMenuAction | null> {
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate(
      navigatorSidebarMenuTemplate(request, (action) => resolve(action))
    )
    menu.popup({
      window,
      callback: () => setImmediate(() => resolve(null))
    })
  })
}
