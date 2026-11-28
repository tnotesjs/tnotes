import { commandHistory, type CommandHistory } from './commandHistory'
import { canRunHeadingFold, runHeadingFold } from './headingFoldBridge'
import {
  canRunHeadingNumbers,
  runAddHeadingNumbers,
  runRemoveHeadingNumbers
} from './headingNumberBridge'
import { canRunViewToggle, runViewToggle } from './viewToggleBridge'

import type { ThemeMode } from '../../../shared/contracts'

export interface PaletteCommand {
  id: string
  title: string
  category: string
  hint: string
  keywords: string[]
  shortcut?: string
  enabled: () => boolean
  run: () => void | Promise<void>
}

export interface PaletteCommandContext {
  saveDocument: () => Promise<void>
  openSettings: () => void
  openKbSettings: () => void
  openKbAssets: () => void
  hasSelectedKnowledgeBase: () => boolean
  toggleTerminal: () => void
  toggleDevTools: () => void | Promise<void>
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void
}

export function createPaletteCommands(context: PaletteCommandContext): PaletteCommand[] {
  const foldEnabled = (): boolean => canRunHeadingFold()
  return [
    {
      id: 'fold-all',
      title: '全部折叠标题',
      category: '编辑器',
      hint: 'Fold All',
      keywords: ['fold all'],
      enabled: foldEnabled,
      run: () => void runHeadingFold('fold-all')
    },
    {
      id: 'unfold-all',
      title: '全部展开标题',
      category: '编辑器',
      hint: 'Unfold All',
      keywords: ['unfold all'],
      enabled: foldEnabled,
      run: () => void runHeadingFold('unfold-all')
    },
    ...([1, 2, 3, 4, 5, 6] as const).flatMap((level) => [
      {
        id: `fold-level-${level}`,
        title: `折叠 ${level} 级标题`,
        category: '编辑器',
        hint: `Fold Level ${level}`,
        keywords: [`fold level ${level}`],
        enabled: foldEnabled,
        run: () => void runHeadingFold(`fold-level-${level}`)
      },
      {
        id: `unfold-level-${level}`,
        title: `展开 ${level} 级标题`,
        category: '编辑器',
        hint: `Unfold Level ${level}`,
        keywords: [`unfold level ${level}`],
        enabled: foldEnabled,
        run: () => void runHeadingFold(`unfold-level-${level}`)
      }
    ]),
    {
      id: 'add-heading-numbers',
      title: '重排标题编号',
      category: '编辑器',
      hint: 'Renumber Headings',
      keywords: ['heading number', 'renumber', '标题编号'],
      enabled: canRunHeadingNumbers,
      run: () => runAddHeadingNumbers()
    },
    {
      id: 'remove-heading-numbers',
      title: '移除标题编号',
      category: '编辑器',
      hint: 'Remove Heading Numbers',
      keywords: ['heading number', 'remove', '标题编号'],
      enabled: canRunHeadingNumbers,
      run: () => runRemoveHeadingNumbers()
    },
    {
      id: 'toggle-note-view',
      title: '切换视图（可视化 / 源码）',
      category: '编辑器',
      hint: 'Toggle View',
      keywords: ['toggle view'],
      shortcut: '⌘ K V',
      enabled: canRunViewToggle,
      run: () => {
        runViewToggle()
      }
    },
    {
      id: 'save-note',
      title: '保存当前笔记',
      category: '笔记',
      hint: 'Save',
      keywords: ['save'],
      shortcut: '⌘ S',
      enabled: () => true,
      run: () => context.saveDocument()
    },
    {
      id: 'open-kb-assets',
      title: '资源',
      category: '知识库',
      hint: 'KB Assets',
      keywords: ['assets'],
      enabled: () => context.hasSelectedKnowledgeBase(),
      run: () => context.openKbAssets()
    },
    {
      id: 'open-kb-settings',
      title: '知识库配置',
      category: '知识库',
      hint: 'KB Settings',
      keywords: ['kb settings'],
      enabled: () => context.hasSelectedKnowledgeBase(),
      run: () => context.openKbSettings()
    },
    {
      id: 'toggle-terminal',
      title: '切换终端面板',
      category: '终端',
      hint: 'Toggle Terminal',
      keywords: ['terminal'],
      shortcut: '⌘J',
      enabled: () => true,
      run: () => context.toggleTerminal()
    },
    {
      id: 'open-settings',
      title: '打开设置',
      category: '应用',
      hint: 'Settings',
      keywords: ['settings'],
      enabled: () => true,
      run: () => context.openSettings()
    },
    {
      id: 'toggle-dev-tools',
      title: '切换开发者工具',
      category: '应用',
      hint: 'Toggle Developer Tools',
      keywords: ['developer tools', 'devtools', 'console'],
      enabled: () => true,
      run: () => context.toggleDevTools()
    },
    ...themeCommands(context)
  ]
}

const themeChoices: { mode: ThemeMode; title: string; hint: string; keywords: string[] }[] = [
  {
    mode: 'system',
    title: '主题：跟随系统',
    hint: 'System',
    keywords: ['theme system']
  },
  {
    mode: 'light',
    title: '主题：浅色',
    hint: 'Light',
    keywords: ['theme light']
  },
  {
    mode: 'dark',
    title: '主题：深色',
    hint: 'Dark',
    keywords: ['theme dark']
  }
]

function themeCommands(context: PaletteCommandContext): PaletteCommand[] {
  return themeChoices.map((choice) => ({
    id: `theme-${choice.mode}`,
    title: choice.title,
    category: '外观',
    hint: context.theme === choice.mode ? '当前' : choice.hint,
    keywords: choice.keywords,
    enabled: () => true,
    run: () => context.setTheme(choice.mode)
  }))
}

export function commandQuery(raw: string): string {
  return raw.startsWith('>') ? raw.slice(1).trim() : raw.trim()
}

export function isCommandMode(raw: string): boolean {
  return raw.startsWith('>')
}

export interface CommandHistoryView {
  peek(commandId: string): number | undefined
}

/**
 * 过滤后的顺序对齐 VS Code 命令面板：
 * 有使用记录的排在前面，计数大的（最近一次）在最前；
 * 都没用过时按标题排序。每条命令只出现一次。
 */
export function filterPaletteCommands(
  commands: readonly PaletteCommand[],
  rawQuery: string,
  history: CommandHistoryView = commandHistory
): PaletteCommand[] {
  const query = commandQuery(rawQuery).toLowerCase()
  const matched = query
    ? commands.filter((command) => {
        const haystack = [
          command.title,
          command.category,
          command.hint,
          command.id,
          ...command.keywords
        ]
          .join(' ')
          .toLowerCase()
        return matchesQuery(haystack, query)
      })
    : [...commands]
  matched.sort((left, right) => compareCommands(left, right, history))
  return matched
}

function compareCommands(
  left: PaletteCommand,
  right: PaletteCommand,
  history: CommandHistoryView
): number {
  const leftCounter = history.peek(left.id) ?? 0
  const rightCounter = history.peek(right.id) ?? 0
  if (leftCounter && rightCounter && leftCounter !== rightCounter) return rightCounter - leftCounter
  if (leftCounter && !rightCounter) return -1
  if (rightCounter && !leftCounter) return 1
  return left.title.localeCompare(right.title, 'zh')
}

export interface PaletteCommandGroup {
  category: string
  items: { command: PaletteCommand; index: number }[]
}

/** 有最近记录时分成「最近使用 / 其他命令」；还没有记录时不造一个空的最近分组。 */
export function groupPaletteCommands(
  commands: readonly PaletteCommand[],
  rawQuery: string,
  history: CommandHistoryView = commandHistory
): PaletteCommandGroup[] {
  const ordered = filterPaletteCommands(commands, rawQuery, history)
  const recent: PaletteCommandGroup = { category: '最近使用', items: [] }
  const rest: PaletteCommandGroup = { category: '', items: [] }
  ordered.forEach((command, index) => {
    const bucket = history.peek(command.id) ? recent : rest
    bucket.items.push({ command, index })
  })
  if (recent.items.length > 0) rest.category = '其他命令'
  return [recent, rest].filter((group) => group.items.length > 0)
}

export function rememberPaletteCommand(
  commandId: string,
  history: CommandHistory = commandHistory
): void {
  history.push(commandId)
}

export function matchesQuery(haystack: string, query: string): boolean {
  if (!query) return true
  if (haystack.includes(query)) return true
  let index = 0
  for (const character of haystack) {
    if (character === query[index]) index += 1
    if (index >= query.length) return true
  }
  return false
}
