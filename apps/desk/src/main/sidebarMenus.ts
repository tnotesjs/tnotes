/**
 * Native Electron menus for the knowledge / navigator sidebar ⋯ buttons.
 */

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

import { maxBatchNoteCount } from '../shared/noteBatch'
import type {
  KnowledgeBaseSort,
  KnowledgeSidebarMenuAction,
  KnowledgeSidebarMenuChoice,
  KnowledgeSidebarMenuRequest,
  NavigatorSidebarMenuAction,
  NavigatorSidebarMenuRequest
} from '../shared/contracts'
import { popupForChoice } from './menuPopup'

const KNOWLEDGE_BASE_SORTS: { id: KnowledgeBaseSort; label: string }[] = [
  { id: 'name-asc', label: '按照名称升序' },
  { id: 'name-desc', label: '按照名称降序' },
  { id: 'count-asc', label: '按照笔记数量升序' },
  { id: 'count-desc', label: '按照笔记数量降序' },
  { id: 'done-asc', label: '按照笔记完成数量升序' },
  { id: 'done-desc', label: '按照笔记完成数量降序' },
  { id: 'updated-asc', label: '按照最近更新时间升序' },
  { id: 'updated-desc', label: '按照最近更新时间降序' }
]

function revealWorkspaceLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '在访达中打开'
  if (platform === 'win32') return '在资源管理器中打开'
  return '打开工作区目录'
}

export function knowledgeSidebarMenuTemplate(
  request: KnowledgeSidebarMenuRequest,
  select: (choice: KnowledgeSidebarMenuChoice) => void,
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
    click: () => select({ kind: 'action', action: id })
  })
  return [
    item('create', '新建知识库', !request.loading),
    item('refresh', '重新扫描知识库', !request.loading),
    { type: 'separator' },
    {
      id: 'sort',
      label: '排序',
      submenu: KNOWLEDGE_BASE_SORTS.map((option) => ({
        id: option.id,
        label: option.label,
        type: 'radio' as const,
        checked: request.sort === option.id,
        click: () => select({ kind: 'sort', sort: option.id })
      }))
    },
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
): Promise<KnowledgeSidebarMenuChoice | null> {
  let chosen: KnowledgeSidebarMenuChoice | null = null
  const menu = Menu.buildFromTemplate(
    knowledgeSidebarMenuTemplate(request, (action) => {
      chosen = action
    })
  )
  return popupForChoice(menu, window, () => chosen)
}

export function showNavigatorSidebarMenu(
  window: BrowserWindow,
  request: NavigatorSidebarMenuRequest
): Promise<NavigatorSidebarMenuAction | null> {
  let chosen: NavigatorSidebarMenuAction | null = null
  const menu = Menu.buildFromTemplate(
    navigatorSidebarMenuTemplate(request, (action) => {
      chosen = action
    })
  )
  return popupForChoice(menu, window, () => chosen)
}
