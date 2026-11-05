/**
 * 可插入块的清单：斜杠菜单（`/`）和工具栏「插入」菜单共用一份。
 *
 * - `aliases`：斜杠后可直接输入的简写（英文名 + 拼音首字母），第一个显示在菜单行尾。
 * - `action`：
 *   - `prefix`：把当前行改成标题 / 列表 / 引用；
 *   - `block`：插入一整块，模板里的 {@link CARET} 是插入后光标的位置，没有就落在块后面；
 *   - `image` / `canvas`：交给宿主（选图弹层、新建画布）。
 */
import { ALERT_LABELS, alertIcon } from '@tnotesjs/ui/alerts'

import { formatIconSvg } from '../components/formatIcons'
import { menuIconFor } from './slashMenu'

import type { AlertType } from '@tnotesjs/ui/alerts'

/** 模板里的光标占位 */
export const CARET = '\u2038'

export type InsertGroup = 'basic' | 'callout' | 'code' | 'embed'

export const INSERT_GROUP_LABELS: Record<InsertGroup, string> = {
  basic: '基础',
  callout: '提示块',
  code: '代码与图表',
  embed: '媒体与组件'
}

export type InsertAction =
  | { kind: 'prefix'; prefix: string }
  | { kind: 'block'; template: string | (() => string) }
  | { kind: 'image' }
  | { kind: 'canvas' }

export interface InsertItem {
  id: string
  label: string
  group: InsertGroup
  aliases: readonly string[]
  icon: string
  action: InsertAction
  /** 提示块的配色 */
  tone?: AlertType
  /** 只出现在斜杠菜单里（工具栏另有按钮） */
  slashOnly?: boolean
}

function lineIcon(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

function headingIcon(level: number): string {
  return lineIcon(
    `<path d="M3.5 6v12M11.5 6v12M3.5 12h8"/><text x="14.5" y="18.5" fill="currentColor" stroke="none" font-size="11.5" font-weight="700" font-family="system-ui, sans-serif">${level}</text>`
  )
}

const ICONS = {
  image: lineIcon(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 2.5-2.5L20 19"/>'
  ),
  math: lineIcon('<path d="M17 5H7l5.5 7L7 19h10"/>'),
  video: lineIcon(
    '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="m8 3 2.5 3M16 3l-2.5 3M10.5 10.5v4.5l4-2.25-4-2.25Z"/>'
  ),
  words: lineIcon('<path d="M4 18 8 6l4 12M5.4 14h5.2M14 9h6M14 13h6M14 17h4"/>'),
  notesTable: lineIcon(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9 9.5v10"/>'
  ),
  footprints: lineIcon(
    '<path d="M6 4.5c1.7 0 2.5 1.8 2.5 4s-.8 4-2.5 4-2.5-1.8-2.5-4 .8-4 2.5-4ZM5 15.5h2.5l-.5 3.5H5.5ZM17 7.5c1.7 0 2.5 1.8 2.5 4s-.8 4-2.5 4-2.5-1.8-2.5-4 .8-4 2.5-4ZM16 18.5h2.5L18 22h-1.5Z"/>'
  )
}

function now(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function callout(type: AlertType, aliases: string[]): InsertItem {
  return {
    id: type,
    label: `${ALERT_LABELS[type]}块`,
    group: 'callout',
    aliases,
    icon: alertIcon(type),
    tone: type,
    action: { kind: 'block', template: `::: ${type}\n${CARET}\n:::` }
  }
}

export const INSERT_ITEMS: readonly InsertItem[] = [
  ...[1, 2, 3].map((level): InsertItem => ({
    id: `h${level}`,
    label: `${['一', '二', '三'][level - 1]}级标题`,
    group: 'basic',
    aliases: [`h${level}`, `bt${level}`, `${['y', 'e', 's'][level - 1]}jbt`, `heading${level}`],
    icon: headingIcon(level),
    action: { kind: 'prefix', prefix: `${'#'.repeat(level)} ` },
    slashOnly: true
  })),
  {
    id: 'unordered-list',
    label: '无序列表',
    group: 'basic',
    aliases: ['ul', 'wxlb', 'list', 'lb'],
    icon: formatIconSvg('unordered-list'),
    action: { kind: 'prefix', prefix: '- ' },
    slashOnly: true
  },
  {
    id: 'ordered-list',
    label: '有序列表',
    group: 'basic',
    aliases: ['ol', 'yxlb'],
    icon: formatIconSvg('ordered-list'),
    action: { kind: 'prefix', prefix: '1. ' },
    slashOnly: true
  },
  {
    id: 'task-list',
    label: '任务列表',
    group: 'basic',
    aliases: ['todo', 'rwlb', 'task', 'dbsx'],
    icon: formatIconSvg('checkbox'),
    action: { kind: 'prefix', prefix: '- [ ] ' },
    slashOnly: true
  },
  {
    id: 'quote',
    label: '引用',
    group: 'basic',
    aliases: ['quote', 'yy'],
    icon: formatIconSvg('quote'),
    action: { kind: 'prefix', prefix: '> ' },
    slashOnly: true
  },
  {
    id: 'divider',
    label: '分割线',
    group: 'basic',
    aliases: ['hr', 'fgx', 'divider'],
    icon: formatIconSvg('divider'),
    action: { kind: 'block', template: '---' },
    slashOnly: true
  },
  {
    id: 'table',
    label: '表格',
    group: 'basic',
    aliases: ['table', 'bg'],
    icon: formatIconSvg('table'),
    action: { kind: 'block', template: `| ${CARET} |  |\n| --- | --- |\n|  |  |` }
  },
  {
    id: 'image',
    label: '图片',
    group: 'basic',
    aliases: ['image', 'tp', 'img', 'pic'],
    icon: ICONS.image,
    action: { kind: 'image' }
  },
  {
    id: 'math',
    label: '公式',
    group: 'basic',
    aliases: ['math', 'gs', 'latex'],
    icon: ICONS.math,
    action: { kind: 'block', template: `$$\n${CARET}\n$$` }
  },
  callout('tip', ['tip', 'tsk', 'ts']),
  callout('info', ['info', 'xxk', 'xx']),
  callout('warning', ['warning', 'jgk', 'jg', 'warn']),
  callout('danger', ['danger', 'cwk', 'cw', 'error']),
  callout('details', ['details', 'xqk', 'zd', 'fold']),
  {
    id: 'code',
    label: '代码块',
    group: 'code',
    aliases: ['code', 'dmk', 'dm'],
    icon: menuIconFor('code'),
    action: { kind: 'block', template: `\`\`\`js\n${CARET}\n\`\`\`` }
  },
  {
    id: 'code-group',
    label: '代码组',
    group: 'code',
    aliases: ['codegroup', 'dmz', 'cg'],
    icon: menuIconFor('code-group'),
    action: {
      kind: 'block',
      template: `::: code-group\n\n\`\`\`js [a.js]\n${CARET}\n\`\`\`\n\n\`\`\`ts [b.ts]\n\n\`\`\`\n\n:::`
    }
  },
  {
    id: 'mermaid',
    label: 'Mermaid 图表',
    group: 'code',
    aliases: ['mermaid', 'mmd', 'lct', 'tb'],
    icon: menuIconFor('mermaid'),
    action: { kind: 'block', template: '```mermaid\ngraph LR\n  A[开始] --> B[结束]\n```' }
  },
  {
    id: 'mindmap',
    label: '思维导图',
    group: 'code',
    aliases: ['swdt', 'mindmap', 'mm', 'dt'],
    icon: menuIconFor('mindmap'),
    action: { kind: 'block', template: '```mindmap\n# 中心主题\n\n- 分支一\n- 分支二\n```' }
  },
  {
    id: 'canvas',
    label: '画布',
    group: 'code',
    aliases: ['canvas', 'hb', 'excalidraw', 'draw'],
    icon: formatIconSvg('canvas'),
    action: { kind: 'canvas' }
  },
  {
    id: 'swiper',
    label: '图片轮播',
    group: 'embed',
    aliases: ['swiper', 'tplb', 'carousel'],
    icon: menuIconFor('swiper'),
    action: { kind: 'block', template: `::: swiper\n\n${CARET}\n\n:::` }
  },
  {
    id: 'bilibili',
    label: 'B 站视频',
    group: 'embed',
    aliases: ['bilibili', 'bzsp', 'video', 'sp'],
    icon: ICONS.video,
    action: { kind: 'block', template: `<BilibiliVideo id="${CARET}" />` }
  },
  {
    id: 'word-list',
    label: '单词表',
    group: 'embed',
    aliases: ['words', 'dcb', 'wordlist'],
    icon: ICONS.words,
    action: { kind: 'block', template: `<WordList :words="[\n  '${CARET}',\n]" />` }
  },
  {
    id: 'notes-table',
    label: '笔记表格',
    group: 'embed',
    aliases: ['notes', 'bjbg', 'notestable'],
    icon: ICONS.notesTable,
    action: { kind: 'block', template: `<NotesTable :ids="[\n  '${CARET}',\n]" />` }
  },
  {
    id: 'footprints',
    label: '足迹',
    group: 'embed',
    aliases: ['footprints', 'zj'],
    icon: ICONS.footprints,
    action: { kind: 'block', template: () => `::: footprints ${now()}\n\n${CARET}\n\n:::` }
  }
]

export function insertItem(id: string): InsertItem | undefined {
  return INSERT_ITEMS.find((item) => item.id === id)
}

export function templateOf(item: InsertItem): string {
  if (item.action.kind !== 'block') return ''
  const { template } = item.action
  return typeof template === 'function' ? template() : template
}

/** 首选简写，显示在菜单行尾（`/swdt`） */
export function primaryAlias(item: InsertItem): string {
  return `/${item.aliases[0]}`
}

/**
 * 按输入过滤并排序：简写全等 > 简写前缀 > 名称前缀 > 名称包含 > 简写包含。
 * 同一档保持清单顺序；空查询返回原清单。
 */
export function filterInsertItems(items: readonly InsertItem[], query: string): InsertItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  const scored: Array<{ item: InsertItem; score: number; index: number }> = []
  items.forEach((item, index) => {
    const aliases = item.aliases.map((alias) => alias.toLowerCase())
    const label = item.label.toLowerCase()
    let score = -1
    if (aliases.includes(q)) score = 0
    else if (aliases.some((alias) => alias.startsWith(q))) score = 1
    else if (label.startsWith(q)) score = 2
    else if (label.includes(q)) score = 3
    else if (aliases.some((alias) => alias.includes(q))) score = 4
    if (score >= 0) scored.push({ item, score, index })
  })
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((entry) => entry.item)
}
