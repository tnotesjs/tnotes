import { z } from 'zod'

import type { WorkspaceSession } from '../../shared/contracts'

const iconSchema = z
  .object({
    src: z.string().optional(),
    svg: z.string().optional(),
    letter: z.string().optional()
  })
  .nullable()

const noteTabSchema = z.object({
  id: z.string().min(1),
  type: z.literal('note'),
  knowledgeBaseId: z.string().min(1),
  knowledgeBaseName: z.string(),
  noteUuid: z.string().min(1),
  title: z.string(),
  icon: iconSchema,
  viewMode: z.enum(['visual', 'source']),
  pageWidth: z.enum(['standard', 'wide']).default('standard'),
  outlineVisible: z.boolean().optional(),
  noteAssetsVisible: z.boolean().optional(),
  preview: z.boolean().optional(),
  pinned: z.boolean().optional(),
  openedAt: z.number().finite().optional(),
  dirty: z.boolean().optional()
})

const webTabSchema = z.object({
  id: z.string().min(1),
  type: z.literal('web'),
  url: z.string().min(1),
  title: z.string(),
  pinned: z.boolean().optional(),
  openedAt: z.number().finite().optional()
})

const kbSettingsTabSchema = z.object({
  id: z.string().min(1),
  type: z.literal('kb-settings'),
  knowledgeBaseId: z.string().min(1),
  knowledgeBaseName: z.string(),
  title: z.string(),
  icon: iconSchema,
  pinned: z.boolean().optional(),
  openedAt: z.number().finite().optional(),
  dirty: z.boolean().optional()
})

const kbAssetsTabSchema = z.object({
  id: z.string().min(1),
  type: z.literal('kb-assets'),
  knowledgeBaseId: z.string().min(1),
  knowledgeBaseName: z.string(),
  title: z.string(),
  icon: iconSchema,
  pinned: z.boolean().optional(),
  openedAt: z.number().finite().optional(),
  dirty: z.boolean().optional()
})

/** 画布源文件：relPath 只允许 assets/ 下的 .excalidraw；内容有上限。 */
const excalidrawRelPathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => value.startsWith('assets/'), '画布必须位于 assets/ 下')
  .refine((value) => value.toLowerCase().endsWith('.excalidraw'), '只允许 .excalidraw 源文件')

const textFileTabSchema = z.object({
  id: z.string().min(1),
  type: z.literal('text-file'),
  knowledgeBaseId: z.string().min(1),
  knowledgeBaseName: z.string(),
  relPath: z.string().min(1).max(1024),
  title: z.string(),
  icon: iconSchema,
  pinned: z.boolean().optional(),
  openedAt: z.number().finite().optional()
})

const excalidrawTabSchema = z.object({
  id: z.string().min(1),
  type: z.literal('excalidraw'),
  knowledgeBaseId: z.string().min(1),
  knowledgeBaseName: z.string(),
  relPath: excalidrawRelPathSchema,
  ownerNoteIndex: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  title: z.string(),
  icon: iconSchema,
  pinned: z.boolean().optional(),
  openedAt: z.number().finite().optional(),
  dirty: z.boolean().optional(),
  invalid: z.boolean().optional()
})

const mindmapTabSchema = z.object({
  id: z.string().min(1),
  type: z.literal('mindmap'),
  knowledgeBaseId: z.string().min(1),
  knowledgeBaseName: z.string(),
  noteUuid: z.string().min(1),
  fenceOrdinal: z.number().int().min(0).default(0),
  fenceSource: z.string().min(1).max(2_000_000),
  title: z.string(),
  icon: iconSchema,
  pinned: z.boolean().optional(),
  openedAt: z.number().finite().optional(),
  dirty: z.boolean().optional(),
  invalid: z.boolean().optional()
})

const noteHistoryTabSchema = z.object({
  id: z.string().min(1),
  type: z.literal('note-history'),
  knowledgeBaseId: z.string().min(1),
  knowledgeBaseName: z.string(),
  noteIndex: z.string().regex(/^\d{4}$/),
  noteUuid: z.string().min(1).optional(),
  /** 只接受完整 40 位 OID 或空串（恢复时会重新定位最新提交） */
  commit: z.union([z.literal(''), z.string().regex(/^[0-9a-f]{40}$/)]),
  title: z.string(),
  icon: iconSchema,
  pinned: z.boolean().optional(),
  openedAt: z.number().finite().optional()
})

const editorTabSchema = z.discriminatedUnion('type', [
  noteTabSchema,
  webTabSchema,
  kbSettingsTabSchema,
  kbAssetsTabSchema,
  excalidrawTabSchema,
  mindmapTabSchema,
  textFileTabSchema,
  noteHistoryTabSchema
])

const editorLayoutSchema: z.ZodType<WorkspaceSession['layout']> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('group'),
      id: z.string().min(1),
      tabs: z.array(editorTabSchema),
      activeTabId: z.string().nullable()
    }),
    z.object({
      type: z.literal('split'),
      id: z.string().min(1),
      direction: z.enum(['horizontal', 'vertical']),
      ratio: z.number().min(0.15).max(0.85),
      first: editorLayoutSchema,
      second: editorLayoutSchema
    })
  ])
)

const knowledgeBaseEditorSchema = z.object({
  layout: editorLayoutSchema,
  activeGroupId: z.string().min(1),
  lastNoteByGroup: z
    .record(z.string(), z.object({ noteUuid: z.string().min(1), noteTitle: z.string() }))
    .optional()
})

export const workspaceSessionSchema = z.object({
  version: z.literal(1),
  selectedKnowledgeBaseId: z.string().nullable(),
  layout: editorLayoutSchema,
  activeGroupId: z.string().min(1),
  knowledgeBaseEditors: z.record(z.string(), knowledgeBaseEditorSchema).default({}),
  knowledgeSidebarWidth: z.number().min(48).max(520),
  navigatorSidebarWidth: z.number().min(160).max(700),
  knowledgeSidebarCollapsed: z.boolean(),
  navigatorSidebarCollapsed: z.boolean(),
  expandedTocNodes: z.record(z.string(), z.array(z.string())),
  pinnedKnowledgeBasesCollapsed: z.boolean().default(false),
  pinnedNotesCollapsed: z.record(z.string(), z.boolean()).default({})
})

export const webBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive()
})

export const entryRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('note'), noteUuid: z.string().min(1) }),
  z.object({
    type: z.literal('folder'),
    folderPath: z.array(z.string().min(1)).min(1)
  }),
  z.object({
    type: z.literal('line'),
    tocLineIndex: z.number().int().nonnegative()
  })
])

export const placementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('root'),
    placement: z.enum(['start', 'end']).optional()
  }),
  z.object({
    type: z.literal('note'),
    targetNoteUuid: z.string().min(1),
    placement: z.enum(['before', 'after', 'inside'])
  }),
  z.object({
    type: z.literal('folder'),
    folderPath: z.array(z.string().min(1)).min(1),
    placement: z.enum(['before', 'after', 'inside'])
  })
])

export const noteSaveSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteUuid: z.string().min(1),
  content: z.string(),
  expectedRevision: z.string().min(1),
  prettier: z.boolean().optional()
})

export const noteCreateSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  title: z.string().min(1),
  placement: placementSchema.optional(),
  expectedSnapshotRevision: z.string().min(1).optional()
})

export const noteCreateManySchema = noteCreateSchema.extend({
  count: z.number().int().min(1).max(999)
})

export const noteRenameSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteUuid: z.string().min(1),
  title: z.string().min(1),
  expectedRevision: z.string().min(1)
})

export const noteReindexSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteUuid: z.string().min(1),
  index: z.string().regex(/^\d{1,4}$/),
  expectedRevision: z.string().min(1)
})

export const noteUpdateConfigSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteUuid: z.string().min(1),
  expectedRevision: z.string().min(1),
  updates: z
    .object({
      done: z.boolean().optional(),
      description: z.string().optional()
    })
    .refine((value) => Object.keys(value).length > 0, '没有可更新字段')
})

export const recoveryWriteSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteUuid: z.string().min(1),
  path: z.string().min(1).max(1024).optional(),
  title: z.string(),
  content: z.string(),
  revision: z.string().min(1)
})

export const recoveryDeleteSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteUuid: z.string().min(1),
  path: z.string().min(1).max(1024).optional()
})

export const knowledgeBaseCreateSchema = z.object({
  folderName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, '须匹配 ^[A-Za-z0-9._-]{1,100}$'),
  title: z.string().trim().max(200).optional(),
  packageJson: z.boolean().optional(),
  githubPages: z.boolean().optional(),
  readme: z.boolean().optional(),
  gitInit: z.boolean().optional()
})

export const knowledgeBaseSettingsWriteSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  name: z.string().min(1).max(100),
  title: z.string().max(200),
  repositoryUrl: z.string().max(2048).optional(),
  rootUrl: z.string().max(2048).optional(),
  port: z.number().int().min(1).max(65535),
  pageUrl: z.string().max(2048).optional(),
  statsEnabled: z.boolean()
})

export const knowledgeBaseIconWriteSchema = z.discriminatedUnion('kind', [
  z.object({
    knowledgeBaseId: z.string().min(1),
    kind: z.literal('file'),
    fileName: z.string().min(1).max(240),
    data: z.instanceof(Uint8Array).refine((data) => data.byteLength <= 5 * 1024 * 1024, {
      message: '图标不能超过 5 MB'
    })
  }),
  z.object({
    knowledgeBaseId: z.string().min(1),
    kind: z.literal('letter'),
    letter: z.string().min(1).max(4)
  }),
  z.object({
    knowledgeBaseId: z.string().min(1),
    kind: z.literal('clear')
  })
])

export const attachmentWriteLocalSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteUuid: z.string().min(1),
  fileName: z.string().min(1).max(240),
  data: z.instanceof(Uint8Array).refine((data) => data.byteLength <= 25 * 1024 * 1024, {
    message: '图片不能超过 25 MB'
  })
})

export const githubImageSettingsSchema = z.object({
  repository: z.string().trim().min(1).max(300),
  branch: z.string().trim().min(1).max(240),
  path: z.string().trim().max(1024),
  cdnTemplate: z.string().trim().min(1).max(2048),
  fileNameFormat: z.string().trim().min(1).max(240)
})

/**
 * 设置页「压缩效果测试」：临时图片只在内存里编码，不上盘、不碰知识库。
 * 与附件写入同口径限制 25 MB，避免渲染进程塞进超大图。
 */
export const imageOptimizePreviewSchema = z.object({
  fileName: z.string().min(1).max(260),
  data: z
    .instanceof(Uint8Array)
    .refine((data) => data.byteLength > 0, { message: '图片内容为空' })
    .refine((data) => data.byteLength <= 25 * 1024 * 1024, {
      message: '测试图片不能超过 25 MB'
    }),
  options: z.object({
    encoder: z.enum(['sharp', 'oxipng']).default('sharp'),
    strength: z.enum(['low', 'medium', 'high']).default('medium'),
    maxDimension: z.number().int().min(64).max(10_000).nullable(),
    outputFormat: z.enum(['keep', 'webp', 'jpeg'])
  })
})

export const tocMoveSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  source: entryRefSchema,
  target: entryRefSchema,
  placement: z.enum(['before', 'after', 'inside']),
  expectedSnapshotRevision: z.string().min(1)
})

export const tocCreateGroupSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  title: z.string().min(1),
  placement: placementSchema.optional(),
  expectedSnapshotRevision: z.string().min(1)
})

export const tocRenameGroupSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  folderPath: z.array(z.string().min(1)).min(1),
  title: z.string().min(1),
  expectedSnapshotRevision: z.string().min(1)
})

export const deleteTargetSchema = z.union([
  entryRefSchema,
  z.object({
    type: z.literal('notes'),
    noteUuids: z.array(z.string().min(1)).min(1).max(9999)
  })
])

export const tocDeleteSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  entry: deleteTargetSchema,
  expectedSnapshotRevision: z.string().min(1)
})

export const excalidrawCreateSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteUuid: z.string().min(1),
  content: z
    .string()
    .max(32 * 1024 * 1024)
    .optional()
})

const fullOidSchema = z.string().regex(/^[0-9a-f]{40}$/, '只接受完整 commit OID')

export const historyListSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteIndex: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  head: fullOidSchema.optional(),
  skip: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(200).optional()
})

export const historySnapshotSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  commit: fullOidSchema,
  noteIndex: z.string().regex(/^\d{4}$/),
  noteUuid: z.string().min(1).max(128).optional()
})

export const historyAssetSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  commit: fullOidSchema,
  relPath: z.string().min(1).max(4096)
})

export const historyPlanSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  noteIndex: z.string().regex(/^\d{4}$/),
  commit: fullOidSchema,
  expectedHead: fullOidSchema.optional(),
  writers: z
    .object({
      dirtyDocuments: z.array(
        z.object({ noteUuid: z.string().min(1), title: z.string(), saving: z.boolean() })
      ),
      dirtyTabs: z.array(z.object({ type: z.string().min(1), title: z.string() })),
      pendingRecoveries: z.array(z.object({ noteUuid: z.string().min(1), title: z.string() })),
      pendingEdits: z.array(z.object({ noteUuid: z.string().min(1) })),
      kbSettingsDirty: z.boolean()
    })
    .optional()
})

export const historyApplySchema = z.object({
  /** 只接受主进程发出去的计划 ID：渲染端无法构造任意恢复 */
  planId: z.string().min(1).max(200),
  revision: z.number().int().min(1)
})

export const excalidrawReadSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  relPath: excalidrawRelPathSchema
})

export const excalidrawWriteSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  relPath: excalidrawRelPathSchema,
  content: z.string().max(32 * 1024 * 1024),
  expectedRevision: z.string().min(1)
})

export const excalidrawCopySchema = z.object({
  knowledgeBaseId: z.string().min(1),
  fromRelPath: excalidrawRelPathSchema,
  toNoteUuid: z.string().min(1)
})

/** 知识库文件浏览：只收库根相对路径，拒绝名单与文本判定都在主进程 */
const kbRelPathSchema = z.string().max(1024)

export const kbFilesListSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  relPath: kbRelPathSchema
})

export const kbFilesReadSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  relPath: kbRelPathSchema.min(1, '必须指定文件路径')
})

/** 派生 SVG：只收源画布路径 + 内容，目标路径由主进程推导 */
export const excalidrawDerivedWriteSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  sourceRelPath: excalidrawRelPathSchema,
  content: z
    .string()
    .min(1)
    .max(32 * 1024 * 1024)
})

/** 派生识别探测：只收 assets/ 下的路径，主进程自己推同名源画布 */
export const excalidrawSourceProbeSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  relPath: z
    .string()
    .min(1)
    .max(300)
    .refine((value) => value.startsWith('assets/'), '只探测 assets/ 下的资源')
})
