import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { deskLog } from './log'
import { clampAppZoom, APP_ZOOM_DEFAULT } from '../shared/appZoom'
import {
  BOTTOM_PANEL_TABS_DEFAULT_MAX,
  BOTTOM_PANEL_TABS_MAX_LIMIT
} from '../shared/bottomPanelTabs'
import {
  clampHeadingNumberMaxDepth,
  HEADING_NUMBER_DEFAULT_MAX_DEPTH
} from '../shared/headingNumbering'
import { strengthFromLegacyOxipngLevel, strengthFromLegacyQuality } from './optimizeStrength'

import type { AppSettings, KnowledgeBaseSettings } from '../shared/contracts'

const knowledgeBaseSettingsSchema = z.object({
  hidden: z.boolean().optional()
})

const settingsSchema = z.object({
  version: z.literal(1).default(1),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  density: z.enum(['compact', 'comfortable']).default('comfortable'),
  defaultNoteView: z.enum(['visual', 'readonly', 'source']).default('visual'),
  defaultNotePageWidth: z.enum(['standard', 'wide']).default('standard'),
  noteTocDisplay: z.enum(['hidden', 'collapsed', 'expanded']).default('expanded'),
  headingNumberMaxDepth: z
    .number()
    .transform(clampHeadingNumberMaxDepth)
    .default(HEADING_NUMBER_DEFAULT_MAX_DEPTH),
  appZoomPercent: z.number().transform(clampAppZoom).default(APP_ZOOM_DEFAULT),
  autosave: z
    .object({
      enabled: z.boolean().default(true),
      delayMs: z.number().int().min(250).max(30_000).default(1000)
    })
    .default({ enabled: true, delayMs: 1000 }),
  createNotePosition: z.enum(['top', 'end']).default('top'),
  workspaceLayout: z.enum(['kb-dir-content', 'content-dir-kb']).default('kb-dir-content'),
  // 保存时用 Prettier 整篇重排。默认关闭：保存不应隐式改写用户没编辑过的内容。
  // 开启后用的是 Prettier 内置默认风格（不读取仓库里的 .prettierrc）；只在源码视图保存时生效。
  prettier: z.boolean().default(false),
  ide: z.enum(['vscode', 'cursor']).default('vscode'),
  gitPath: z.string().trim().min(1).nullable().default(null),
  nodePath: z.string().trim().min(1).nullable().default(null),
  confirmBeforeCommit: z.boolean().default(false),
  tabs: z
    .object({
      maxOpenCount: z.number().int().min(1).max(30).default(10),
      wrap: z.boolean().default(true),
      autoRevealInToc: z.boolean().default(true)
    })
    .default({ maxOpenCount: 10, wrap: true, autoRevealInToc: true }),
  toc: z
    .object({
      showNoteIndex: z.boolean().default(true),
      showNoteStatus: z.boolean().default(true),
      changesCollapsedByDefault: z.boolean().default(true)
    })
    .default({
  // 底部面板（终端会话 + 命令任务标签）的上限：两类**合计**计数，上限单独存在这里。
  // 默认 10，合法区间 1-30（上界与 shared/bottomPanelTabs 的常量一致）；
  // 老配置文件没有这个分组，靠分组级 `.default({ maxTabs: 10 })` 补默认值。
  bottomPanel: z
    .object({
      maxTabs: z
        .number()
        .int()
        .min(1)
        .max(BOTTOM_PANEL_TABS_MAX_LIMIT)
        .default(BOTTOM_PANEL_TABS_DEFAULT_MAX)
    })
    .default({ maxTabs: BOTTOM_PANEL_TABS_DEFAULT_MAX }),
      showNoteIndex: true,
      showNoteStatus: true,
      changesCollapsedByDefault: true
    }),
  // 选区浮动工具条（选中文字后弹出的格式条）。默认关闭：不打扰写作；老配置文件
  // 没有这个分组，靠这里的分组级 `.default({...})` 补 false（见 loadSettings）。
  editor: z
    .object({
      selectionToolbar: z.boolean().default(false)
    })
    .default({ selectionToolbar: false }),
  imageUpload: z
    .object({
      defaultTarget: z.enum(['local', 'github']).default('local'),
      github: z
        .object({
          repository: z.string().trim().default(''),
          branch: z.string().trim().min(1).default('main'),
          path: z.string().trim().default('/'),
          cdnTemplate: z
            .string()
            .trim()
            .min(1)
            .default('https://cdn.jsdelivr.net/gh/${username}/${repository}@${branch}/${filepath}'),
          fileNameFormat: z.string().trim().min(1).default('${YY}-${MM}-${DD}-${HH}-${mm}-${ss}')
        })
        .default({
          repository: '',
          branch: 'main',
          path: '/',
          cdnTemplate:
            'https://cdn.jsdelivr.net/gh/${username}/${repository}@${branch}/${filepath}',
          fileNameFormat: '${YY}-${MM}-${DD}-${HH}-${mm}-${ss}'
        }),
      optimize: z.preprocess(
        (raw) => {
          if (!raw || typeof raw !== 'object') return raw
          const input = raw as Record<string, unknown>
          const next: Record<string, unknown> = { ...input }
          if (next.strength !== 'low' && next.strength !== 'medium' && next.strength !== 'high') {
            if (typeof next.quality === 'number') {
              next.strength = strengthFromLegacyQuality(next.quality)
            } else if (typeof next.oxipngLevel === 'number') {
              next.strength = strengthFromLegacyOxipngLevel(next.oxipngLevel)
            } else {
              next.strength = 'medium'
            }
          }
          delete next.quality
          delete next.oxipngLevel
          return next
        },
        z
          .object({
            encoder: z.enum(['sharp', 'oxipng']).default('sharp'),
            strength: z.enum(['low', 'medium', 'high']).default('medium'),
            // 保留字段以兼容旧配置文件；读写时一律当作不缩放（UI 已移除）。
            maxDimension: z
              .number()
              .int()
              .min(64)
              .max(10_000)
              .nullable()
              .default(null)
              .transform(() => null),
            outputFormat: z.enum(['keep', 'webp', 'jpeg']).default('keep')
          })
          .default({
            encoder: 'sharp',
            strength: 'medium',
            maxDimension: null,
            outputFormat: 'keep'
          })
      )
    })
    .default({
      defaultTarget: 'local',
      github: {
        repository: '',
        branch: 'main',
        path: '/',
        cdnTemplate: 'https://cdn.jsdelivr.net/gh/${username}/${repository}@${branch}/${filepath}',
        fileNameFormat: '${YY}-${MM}-${DD}-${HH}-${mm}-${ss}'
      },
      optimize: {
        encoder: 'sharp',
        strength: 'medium',
        maxDimension: null,
        outputFormat: 'keep'
      }
    }),
  hiddenKnowledgeBases: z.array(z.string().min(1)).default([]),
  updates: z
    .object({
      autoCheck: z.boolean().default(true)
    })
    .default({ autoCheck: true }),
  knowledgeBases: z.record(z.string(), knowledgeBaseSettingsSchema).default({})
})

const DEFAULT_SETTINGS: AppSettings = settingsSchema.parse({})

function settingsPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, '.tn-desk-config.json')
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  )
}

function normalizeKnowledgeBaseSettings(
  input: Record<string, KnowledgeBaseSettings>
): Record<string, KnowledgeBaseSettings> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key.trim())
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

function finalize(parsed: AppSettings): AppSettings {
  return {
    ...parsed,
    hiddenKnowledgeBases: uniqueSorted(parsed.hiddenKnowledgeBases),
    knowledgeBases: normalizeKnowledgeBaseSettings(parsed.knowledgeBases)
  }
}

const settingsShape = settingsSchema.shape as Record<string, z.ZodTypeAny>

interface ZodLike {
  shape?: Record<string, z.ZodTypeAny>
  def?: { innerType?: unknown }
  _def?: { innerType?: unknown }
}

/** 去掉 .default()/.preprocess() 外层，拿到真正描述数据结构的 schema */
function unwrapSchema(schema: z.ZodTypeAny): ZodLike | null {
  let current: unknown = schema
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const like = current as ZodLike
    if (like.shape) return like
    const inner = like.def?.innerType ?? like._def?.innerType
    if (!inner) return null
    current = inner
  }
  return null
}

/**
 * 逐字段抢救：非法字段回默认值，合法字段原样保留（最多递归到子对象，
 * 这样 `tabs.maxOpenCount: 0` 只会重置这一个字段）。
 */
function salvageValue(
  schema: z.ZodTypeAny,
  value: unknown,
  path: string,
  dropped: string[],
  depth = 0
): { ok: true; value: unknown } | { ok: false } {
  const direct = schema.safeParse(value)
  if (direct.success) return { ok: true, value: direct.data }
  const shape = depth < 3 ? unwrapSchema(schema)?.shape : undefined
  if (shape && value && typeof value === 'object' && !Array.isArray(value)) {
    const source = value as Record<string, unknown>
    const salvaged: Record<string, unknown> = {}
    for (const [key, subSchema] of Object.entries(shape)) {
      if (!(key in source)) continue
      const result = salvageValue(subSchema, source[key], `${path}.${key}`, dropped, depth + 1)
      if (result.ok) salvaged[key] = result.value
    }
    const group = schema.safeParse(salvaged)
    if (group.success) return { ok: true, value: group.data }
  }
  dropped.push(path)
  return { ok: false }
}

function normalizeWithSalvage(input: unknown): { settings: AppSettings; dropped: string[] } {
  const whole = settingsSchema.safeParse(input)
  if (whole.success) return { settings: finalize(whole.data), dropped: [] }

  const source =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : ({} as const)
  const salvaged: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, fieldSchema] of Object.entries(settingsShape)) {
    if (!(key in source)) continue
    const result = salvageValue(fieldSchema, source[key], key, dropped)
    if (result.ok) salvaged[key] = result.value
  }
  const repaired = settingsSchema.safeParse(salvaged)
  return {
    settings: repaired.success ? finalize(repaired.data) : { ...DEFAULT_SETTINGS },
    dropped
  }
}

/**
 * 严格入口：应用自己写入 / 导入的配置必须整体合法，非法就抛错并保持原文件不变。
 * 只有读取可能被用户手改过的文件时才做逐字段容错。
 */
function normalizeStrict(input: unknown): AppSettings {
  return finalize(settingsSchema.parse(input))
}

/** 出问题的配置先留一份副本，方便用户或后续排查还原被丢弃的字段。 */
function backupUnreadableSettings(): void {
  const target = settingsPath()
  if (!existsSync(target)) return
  try {
    copyFileSync(target, `${target}.invalid.bak`)
  } catch (error) {
    deskLog(
      'settings',
      'settings backup failed',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function loadSettings(): AppSettings {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  const { settings, dropped } = normalizeWithSalvage(raw)
  if (dropped.length > 0) {
    deskLog('settings', 'settings fields reset to default', { dropped })
    backupUnreadableSettings()
  }
  return settings
}

function writeSettingsFile(settings: AppSettings): AppSettings {
  const target = settingsPath()
  const temporary = `${target}.tmp`
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
  return settings
}

export function saveSettings(next: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const merged = normalizeStrict({
    ...current,
    ...next,
    autosave: { ...current.autosave, ...next.autosave },
    tabs: { ...current.tabs, ...next.tabs },
    editor: { ...current.editor, ...next.editor },
    imageUpload: {
      ...current.imageUpload,
      ...next.imageUpload,
      github: { ...current.imageUpload.github, ...next.imageUpload?.github },
      optimize: { ...current.imageUpload.optimize, ...next.imageUpload?.optimize }
    },
    knowledgeBases: { ...current.knowledgeBases, ...next.knowledgeBases }
    bottomPanel: { ...current.bottomPanel, ...next.bottomPanel },
  })
  return writeSettingsFile(merged)
}

export function resetSettings(): AppSettings {
  return writeSettingsFile(DEFAULT_SETTINGS)
}

export function readSettingsFile(): string {
  return `${JSON.stringify(loadSettings(), null, 2)}\n`
}

export function importSettings(content: string): AppSettings {
  const parsed = JSON.parse(content) as unknown
  return writeSettingsFile(normalizeStrict(parsed))
}

export function writeSettingsRaw(json: string): AppSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (cause) {
    throw new Error(
      `配置文件不是合法的 JSON：${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  return writeSettingsFile(normalizeStrict(parsed))
}

export function settingsForKnowledgeBase(
  settings: AppSettings,
  knowledgeBaseId: string
): KnowledgeBaseSettings {
  return settings.knowledgeBases[knowledgeBaseId] ?? {}
}
