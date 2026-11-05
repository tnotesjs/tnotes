/**
 * TNotes 斜杠菜单项清单（0005 规格）。
 *
 * - 菜单本体在 `crepePort/blockEdit`（我们自己的实现），支持 `keywords` / `shortcut`
 *   一等过滤，所以这里**只提供数据**：展示名、图标、插入串、搜索别名与快捷词。
 *   （迁移前为了凑 Crepe 的 `label.includes()`，别名被拼进 label 再用 DOM 观察器抠掉；
 *   菜单源码归我们之后那两处 hack 已删除。）
 * - tip/info/warning/danger 插成 deskCallout；其余容器 / 导图 / 组件插成 deskRawBlock 并
 *   打开「编辑源码」；普通代码块交给调用方决定走代码块组件。
 *
 * 该清单同时被 0006（块级快捷输入）与设置面板的快捷键页复用。
 */

import { formatIconSvg } from '../components/formatIcons'

export type SlashItemKind =
  'container' | 'code' | 'code-group' | 'swiper' | 'component' | 'mermaid' | 'mindmap'

export interface SlashMenuItem {
  /** Stable menu/test key. Never reuse `kind`: several items share one kind. */
  id: string
  /** 菜单展示名 */
  label: string
  /** 插入类型（决定如何生成 deskRawBlock） */
  kind: SlashItemKind
  /** 搜索词（多对一） */
  keywords: string[]
  /** 首选 slash 快捷词，显示在菜单行尾并同步到设置面板。 */
  shortcut: string
  /** 选中后插入的字符串（0006 复用同一份） */
  insert: string
}

/** TNotes 斜杠菜单项清单（0005 规格） */
export const TN_NOTES_SLASH_ITEMS: SlashMenuItem[] = [
  {
    id: 'tip',
    label: '提示块',
    kind: 'container',
    shortcut: '/tip',
    keywords: ['tip', ':::tip', '提示'],
    insert: '::: tip\n\n:::\n'
  },
  {
    id: 'info',
    label: '信息块',
    kind: 'container',
    shortcut: '/info',
    keywords: ['info', ':::info', '信息'],
    insert: '::: info\n\n:::\n'
  },
  {
    id: 'warning',
    label: '警告块',
    kind: 'container',
    shortcut: '/warning',
    keywords: ['warning', ':::warning', '警告'],
    insert: '::: warning\n\n:::\n'
  },
  {
    id: 'danger',
    label: '错误块',
    kind: 'container',
    shortcut: '/error',
    keywords: ['error', ':::error', 'danger', ':::danger', '错误'],
    insert: '::: danger\n\n:::\n'
  },
  {
    id: 'details',
    label: '细节块',
    kind: 'container',
    shortcut: '/details',
    keywords: ['details', ':::details', '细节'],
    insert: '::: details\n\n:::\n'
  },
  {
    id: 'code',
    label: '代码块',
    kind: 'code',
    shortcut: '/code',
    keywords: ['code', ':::code', '代码'],
    insert: '```js\n\n```\n'
  },
  {
    id: 'code-group',
    label: '代码组',
    kind: 'code-group',
    shortcut: '/code-group',
    keywords: ['code-group', ':::code-group', '代码组'],
    insert: '::: code-group\n\n```js [1]\n\n```\n\n```js [2]\n\n```\n\n:::\n'
  },
  {
    id: 'swiper',
    label: '图片轮播',
    kind: 'swiper',
    shortcut: '/swiper',
    keywords: ['swiper', ':::swiper', '轮播'],
    insert: '::: swiper\n\n![](./assets/1.png)\n\n![](./assets/2.png)\n\n:::\n'
  },
  {
    id: 'notes-table',
    label: '笔记表格',
    kind: 'component',
    shortcut: '/N',
    keywords: ['N', 'NotesTable', '笔记表格'],
    insert: '<NotesTable :ids="[\n  \'\',\n]" />\n'
  },
  {
    id: 'bilibili',
    label: 'B站视频',
    kind: 'component',
    shortcut: '/B',
    keywords: ['B', 'BilibiliVideo', 'bilibili', '视频'],
    insert: '<BilibiliVideo id="" />\n'
  },
  {
    id: 'word-list',
    label: '单词表',
    kind: 'component',
    shortcut: '/E',
    keywords: ['E', 'WordList', '单词'],
    insert: '<WordList :words="[\n  \'\',\n]" />\n'
  },
  {
    id: 'footprints',
    label: '足迹',
    kind: 'component',
    shortcut: '/F',
    keywords: ['F', 'Footprints', '足迹'],
    insert:
      '::: footprints 2025-01-01 12:00\n\n第一段文字\n\n第二段文字\n\n![](./assets/demo.png)\n\n:::\n'
  },
  {
    id: 'mermaid',
    label: 'Mermaid',
    kind: 'mermaid',
    shortcut: '/mmd',
    keywords: ['mermaid', 'mmd', '流程图'],
    insert: '```mermaid\n\n```\n'
  },
  {
    id: 'mindmap',
    label: '思维导图',
    kind: 'mindmap',
    shortcut: '/mmp',
    keywords: ['mindmap', 'mm', 'mmp', '思维导图'],
    insert: '```mindmap\n\n```\n'
  },
  {
    id: 'excalidraw',
    label: 'Excalidraw 画布',
    kind: 'component',
    shortcut: '/ex',
    keywords: ['excalidraw', 'canvas', 'draw', '画布', '绘图'],
    // 真实插入路径必须由主进程先建 `.excalidraw` + 同名占位 `.svg`，再按实际文件名
    // 插入图片引用（见 MilkdownMarkdownEditor.insertExcalidrawComponent）；
    // 这个占位串只服务「先插入原子」的通用路径与单测。
    insert: '![画布](./assets/0000-excalidraw.svg)\n'
  }
]

type IconBody = string

function linearIcon(body: IconBody): string {
  return `<svg class="desk-tnotes-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

const TNOTES_ICON_BODIES: Record<Exclude<SlashItemKind, 'code'>, IconBody> = {
  container:
    '<path d="M4 6.5 12 3l8 3.5v11L12 21l-8-3.5v-11Z"/><path d="m4 6.5 8 3.5 8-3.5M12 10v11"/>',
  'code-group':
    '<rect x="4" y="5" width="13" height="14" rx="2"/><path d="M8 3h10a2 2 0 0 1 2 2v12M7.5 9h6M7.5 13h4"/>',
  swiper:
    '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.3"/><path d="m6 17 4-4 3 3 2-2 3 3M3 12H1m22 0h-2"/>',
  component:
    '<path d="M9 4a2 2 0 0 1 4 0v1h3a2 2 0 0 1 2 2v3h1a2 2 0 1 1 0 4h-1v3a2 2 0 0 1-2 2h-3v1a2 2 0 1 1-4 0v-1H6a2 2 0 0 1-2-2v-3H3a2 2 0 1 1 0-4h1V7a2 2 0 0 1 2-2h3V4Z"/>',
  mermaid:
    '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6.5 7.5 10.8 16M17.5 7.5 13.2 16"/>',
  mindmap:
    '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M9.5 10 6.5 7.5M14.5 10l3-2.5M14.5 14l3 2.5"/>'
}

/** Shared local icon source for slash menus, block menus and tests. */
export function menuIconFor(kind: SlashItemKind): string {
  if (kind === 'code') return formatIconSvg('code-block')
  return linearIcon(TNOTES_ICON_BODIES[kind])
}

export interface TNotesSlashGroupOptions {
  /** 菜单组 label */
  groupLabel?: string
  /** 每项的 onRun 执行回调 */
  onRun: (item: SlashMenuItem, ctx: unknown) => void
}

interface AddItemArg {
  label: string
  icon: string
  keywords: string[]
  shortcut: string
  onRun?: (ctx: unknown) => void
}

interface GroupHandle {
  addItem: (key: string, item: AddItemArg) => unknown
}

interface GroupBuilderLike {
  addGroup: (key: string, label: string) => GroupHandle
}

/**
 * 把 TNotes 项追加到斜杠菜单的一个分组里。
 * `keywords` / `shortcut` 直接交给菜单（过滤会一并匹配），不拼进 `label`。
 */
export function buildTNotesSlashGroup(
  builder: GroupBuilderLike,
  options: TNotesSlashGroupOptions
): void {
  const group = builder.addGroup('tnotes', options.groupLabel ?? 'TNotes')
  for (const item of TN_NOTES_SLASH_ITEMS) {
    group.addItem(item.id, {
      label: item.label,
      icon: menuIconFor(item.kind),
      keywords: item.keywords,
      shortcut: item.shortcut,
      onRun: (ctx: unknown) => {
        options.onRun(item, ctx)
      }
    })
  }
}
