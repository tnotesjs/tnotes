<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import type {
  AssetJournalDto,
  AssetKbSummaryDto,
  AssetOperationPlanDto,
  AssetOptimizeEncoder,
  AssetOptimizePreviewDto,
  AssetOptimizeSettings,
  AssetOptimizeStrength,
  AssetReferenceDto,
  AssetScanProgressDto,
  AssetScanReportDto,
  DeskError,
  KbAssetsEditorTab
} from '../../../shared/contracts'
import { focusDialogInput } from '../dialogInputFocus'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import KbAssetsBrowse from './KbAssetsBrowse.vue'
import KbAssetsDetail from './KbAssetsDetail.vue'
import { formatBytes } from './kbAssetsDisplay'
import {
  classifyAssetWriteBlocks,
  renameBlockCode,
  renameBlockReason,
  type ClassifiedAssetWriteBlock
} from './kbAssetsReasons'
import {
  initialAssetsPaneViewState,
  isBrowseVisible,
  isDetailVisible,
  reduceAssetsPaneView,
  type AssetsPaneViewEvent
} from './kbAssetsViewState'

const props = defineProps<{ tab: KbAssetsEditorTab; active: boolean }>()

const editor = useEditorStore()
const workspace = useWorkspaceStore()

const loading = ref(false)
const error = ref<string | null>(null)
const report = ref<AssetScanReportDto | null>(null)
const summaries = ref<AssetKbSummaryDto[]>([])
const progress = ref<AssetScanProgressDto | null>(null)
const query = ref('')
const kindFilter = ref('all')
const statusFilter = ref('all')
const sortKey = ref<'path' | 'size' | 'refs'>('path')
const selectedPath = ref<string | null>(null)
const view = ref<'files' | 'broken' | 'diagnostics' | 'history'>('files')
// 列表 / 网格只改浏览密度，共用同一份筛选、排序与选择状态。
const browseMode = ref<'list' | 'grid'>('list')
const paneElement = ref<HTMLElement | null>(null)
// 断点按面板自身宽度判定（Desk 支持分栏，窗口宽度不可靠）。
const paneView = reactive(initialAssetsPaneViewState())
let resizeObserver: ResizeObserver | null = null
const history = ref<AssetJournalDto[]>([])
const writeBusy = ref(false)
// 写入期间文件会移动：旧报告里的缩略图请求会打到已不存在的路径。
const suppressThumbs = ref(false)
const writeError = ref<ClassifiedAssetWriteBlock[]>([])
const renameOpen = ref(false)
const renameDest = ref('')
const recycleOpen = ref(false)
const restoreOpen = ref(false)
const mergeOpen = ref(false)
const optimizeOpen = ref(false)
const optimizePreview = ref<AssetOptimizePreviewDto | null>(null)
const optimizeEncoder = ref<AssetOptimizeEncoder>('sharp')
const optimizeStrength = ref<AssetOptimizeStrength>('medium')
const optimizeFormat = ref<'keep' | 'webp' | 'jpeg'>('keep')
const optimizeMax = ref('')
const previewPlan = ref<AssetOperationPlanDto | null>(null)
const restoreTarget = ref<AssetJournalDto | null>(null)
let generation = 0
let unsubscribeProgress: (() => void) | null = null

const knowledgeBase = computed(
  () =>
    workspace.overview.allKnowledgeBases.find((item) => item.id === props.tab.knowledgeBaseId) ??
    null
)

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN')
}

function planKindLabel(kind: string): string {
  if (kind === 'rename') return '重命名'
  if (kind === 'recycle') return '回收'
  if (kind === 'restore') return '恢复'
  if (kind === 'merge') return '合并重复'
  if (kind === 'optimize') return optimizeEncoder.value === 'oxipng' ? '无损优化' : '有损压缩'
  return kind
}

function stageLabel(stage: string): string {
  if (stage === 'applied') return '已完成'
  if (stage === 'restored') return '已恢复'
  if (stage === 'pending') return '待执行'
  if (stage === 'backed-up') return '已备份'
  if (stage === 'applying') return '应用中'
  if (stage === 'restoring') return '恢复中'
  if (stage === 'failed') return '失败'
  return stage
}

function moveLabel(move: { fromRelPath: string; toRelPath?: string }): string {
  return move.toRelPath ? `${move.fromRelPath} → ${move.toRelPath}` : move.fromRelPath
}

const filteredAssets = computed(() => {
  const items = report.value?.assets ?? []
  const needle = query.value.trim().toLocaleLowerCase()
  return items
    .filter((asset) => {
      if (kindFilter.value !== 'all' && asset.kind !== kindFilter.value) return false
      if (statusFilter.value === 'duplicates') return Boolean(asset.duplicateGroupId)
      if (statusFilter.value !== 'all' && asset.status !== statusFilter.value) return false
      if (!needle) return true
      return asset.relPath.toLocaleLowerCase().includes(needle)
    })
    .sort((a, b) => {
      if (sortKey.value === 'size') return b.size - a.size
      if (sortKey.value === 'refs') return b.references.length - a.references.length
      return a.relPath.localeCompare(b.relPath)
    })
})

const selected = computed(
  () => report.value?.assets.find((asset) => asset.relPath === selectedPath.value) ?? null
)

const idleCandidates = computed(
  () => report.value?.assets.filter((asset) => asset.status === 'idle-candidate') ?? []
)

const mergeableGroups = computed(
  () => report.value?.duplicateGroups.filter((group) => group.mergeable) ?? []
)

const selectedMergeGroup = computed(() =>
  mergeableGroups.value.find((group) => group.relPaths.includes(selected.value?.relPath ?? ''))
)

const showBrowse = computed(() => isBrowseVisible(paneView))
const showDetail = computed(() => isDetailVisible(paneView))
/** 筛选可能把当前选中项藏起来：详情随之给明确提示，而不是假装它还在列表里。 */
const selectedInFiltered = computed(() =>
  selected.value
    ? filteredAssets.value.some((asset) => asset.relPath === selected.value?.relPath)
    : true
)

function dispatchPaneView(event: AssetsPaneViewEvent): void {
  Object.assign(paneView, reduceAssetsPaneView(paneView, event))
}

function selectAsset(relPath: string): void {
  selectedPath.value = relPath
  dispatchPaneView({ type: 'select' })
}

function returnToBrowse(): void {
  dispatchPaneView({ type: 'back' })
}

function clearFilters(): void {
  query.value = ''
  kindFilter.value = 'all'
  statusFilter.value = 'all'
}

function recycleSelected(): void {
  if (selected.value) void openRecycle([selected.value.relPath])
}

function openDetailReference(reference: AssetReferenceDto): void {
  openReference(reference.sourceRelPath, reference.noteUuid, reference.noteTitle)
}

function defaultOptimizeSettings(): AssetOptimizeSettings {
  const fromSettings = workspace.settings?.imageUpload.optimize
  return {
    encoder: fromSettings?.encoder ?? 'sharp',
    strength: fromSettings?.strength ?? 'medium',
    // 全局设置不再带最大边；资源面板单次整理仍可选手动缩放。
    maxDimension: null,
    outputFormat: fromSettings?.outputFormat ?? 'keep'
  }
}

const incompleteHistory = computed(() =>
  history.value.filter((item) => item.stage !== 'applied' && item.stage !== 'restored')
)

const coverageMessage = computed(() => {
  if (!report.value) return ''
  if (report.value.coverageComplete) {
    return '当前扫描范围内来源已覆盖。确定性范围内可重命名、回收与恢复；每次只改当前知识库。'
  }
  return '存在未适配或未知范围的引用来源。只读盘点可用；不显示「无闲置 / 无断链」，批量清理与相关重命名保持关闭。'
})

const previewBlocks = computed(() => {
  const fromPlan = classifyAssetWriteBlocks({
    planReasons: previewPlan.value?.blockedReasons ?? []
  })
  return fromPlan.length > 0 ? fromPlan : writeError.value
})

const canApplyPreview = computed(
  () =>
    Boolean(previewPlan.value) &&
    (previewPlan.value?.blockedReasons.length ?? 0) === 0 &&
    !writeBusy.value
)

async function loadSummaries(): Promise<void> {
  const result = await window.desk.assets.summaries()
  if (result.ok) summaries.value = result.value
}

async function loadHistory(): Promise<void> {
  const result = await window.desk.assets.history(props.tab.knowledgeBaseId)
  if (result.ok) history.value = result.value
}

async function scan(force = false): Promise<void> {
  if (!force && loading.value) return
  error.value = null
  loading.value = true
  generation += 1
  const current = generation
  progress.value = {
    knowledgeBaseId: props.tab.knowledgeBaseId,
    generation: current,
    done: 0,
    total: 1
  }
  try {
    const result = await window.desk.assets.scan(props.tab.knowledgeBaseId, current)
    if (current !== generation) return
    if (!result.ok) {
      if (result.error.message.includes('ASSET_SCAN_ABORTED')) return
      error.value = result.error.message
      return
    }
    report.value = result.value
    if (
      selectedPath.value &&
      !result.value.assets.some((asset) => asset.relPath === selectedPath.value)
    ) {
      selectedPath.value = null
    }
  } catch (cause) {
    if (current !== generation) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === generation) {
      loading.value = false
      progress.value = null
    }
  }
}

async function cancel(): Promise<void> {
  generation += 1
  await window.desk.assets.cancel(props.tab.knowledgeBaseId)
  loading.value = false
  progress.value = null
}

/**
 * 写入成功后旧报告里的路径可能已被移走 / 改名 / 换了扩展名：继续渲染会让 <img>
 * 向 tnotes-asset 请求已不存在的缩略图并发 404。先卸载列表，再由 scan(true) 重建。
 */
function dropStaleReport(): void {
  report.value = null
}

function openReference(sourceRelPath: string, noteUuid?: string, noteTitle?: string): void {
  const kb = knowledgeBase.value
  if (!kb || !noteUuid) return
  editor.openNote(kb, noteUuid, noteTitle || sourceRelPath, 'source', undefined, 'permanent')
}

/**
 * 重命名/回收完成后同步已打开的画布标签：改名跟随新路径，回收只置失效。
 * 会话不重建——文件内容没变，重建会丢撤销历史。
 */
function syncExcalidrawTabs(plan: AssetOperationPlanDto): void {
  for (const move of plan.moves) {
    if (!move.fromRelPath.endsWith('.excalidraw')) continue
    editor.repathExcalidrawTab(props.tab.knowledgeBaseId, move.fromRelPath, move.toRelPath ?? null)
  }
}

function openOtherKb(knowledgeBaseId: string): void {
  const descriptor = workspace.overview.allKnowledgeBases.find(
    (item) => item.id === knowledgeBaseId
  )
  if (descriptor) editor.openKbAssets(descriptor)
}

function closeDialogs(): void {
  renameOpen.value = false
  recycleOpen.value = false
  restoreOpen.value = false
  mergeOpen.value = false
  optimizeOpen.value = false
  optimizePreview.value = null
  previewPlan.value = null
  restoreTarget.value = null
  writeError.value = []
}

function setWriteError(deskError: DeskError): void {
  writeError.value = classifyAssetWriteBlocks({ error: deskError })
}

const renameBlock = computed(() => {
  const asset = selected.value
  if (!asset) return ''
  return renameBlockReason(renameBlockCode(asset))
})

function openRename(): void {
  if (!selected.value || writeBusy.value) return
  // 真相源/图标等受保护资源不给改名入口（下面按钮同样禁用，这里是第二道）
  if (renameBlockCode(selected.value) !== 'none') return
  renameDest.value = selected.value.relPath
  previewPlan.value = null
  writeError.value = []
  renameOpen.value = true
  void focusDialogInput(() => {
    const input = document.querySelector('.kb-assets-dialog .rename-dest')
    return input instanceof HTMLInputElement ? input : null
  })
}

async function previewRename(): Promise<void> {
  const fromRelPath = selected.value?.relPath
  const toRelPath = renameDest.value.trim()
  if (!fromRelPath || !toRelPath || writeBusy.value) return
  writeBusy.value = true
  writeError.value = []
  try {
    const result = await window.desk.assets.planRename(
      props.tab.knowledgeBaseId,
      fromRelPath,
      toRelPath,
      report.value?.generation
    )
    if (!result.ok) {
      previewPlan.value = null
      setWriteError(result.error)
      return
    }
    previewPlan.value = result.value
    writeError.value = classifyAssetWriteBlocks({ planReasons: result.value.blockedReasons })
  } finally {
    writeBusy.value = false
  }
}

async function openRecycle(relPaths: string[]): Promise<void> {
  if (relPaths.length === 0 || writeBusy.value) return
  writeBusy.value = true
  writeError.value = []
  previewPlan.value = null
  try {
    const result = await window.desk.assets.planRecycle(
      props.tab.knowledgeBaseId,
      relPaths,
      report.value?.generation
    )
    recycleOpen.value = true
    if (!result.ok) {
      setWriteError(result.error)
      return
    }
    previewPlan.value = result.value
    writeError.value = classifyAssetWriteBlocks({ planReasons: result.value.blockedReasons })
  } finally {
    writeBusy.value = false
  }
}

async function openMerge(): Promise<void> {
  const group = selectedMergeGroup.value
  if (!group || writeBusy.value) return
  const keepRelPath = selected.value?.relPath ?? group.relPaths[0]
  if (!keepRelPath) return
  writeBusy.value = true
  writeError.value = []
  previewPlan.value = null
  try {
    const result = await window.desk.assets.planMerge(
      props.tab.knowledgeBaseId,
      keepRelPath,
      group.relPaths.filter((relPath) => relPath !== keepRelPath),
      report.value?.generation
    )
    mergeOpen.value = true
    if (!result.ok) {
      setWriteError(result.error)
      return
    }
    previewPlan.value = result.value
    writeError.value = classifyAssetWriteBlocks({ planReasons: result.value.blockedReasons })
  } finally {
    writeBusy.value = false
  }
}

function currentOptimizeOptions(): AssetOptimizeSettings {
  const max = Number.parseInt(optimizeMax.value, 10)
  return {
    encoder: optimizeEncoder.value,
    strength: optimizeStrength.value,
    maxDimension:
      optimizeEncoder.value === 'oxipng' ? null : Number.isFinite(max) && max >= 64 ? max : null,
    outputFormat: optimizeEncoder.value === 'oxipng' ? 'keep' : optimizeFormat.value
  }
}

function openOptimize(): void {
  if (!selected.value || selected.value.kind !== 'image' || writeBusy.value) return
  const defaults = defaultOptimizeSettings()
  optimizeEncoder.value = defaults.encoder
  optimizeStrength.value = defaults.strength
  optimizeFormat.value = defaults.outputFormat
  optimizeMax.value = defaults.maxDimension ? String(defaults.maxDimension) : ''
  optimizePreview.value = null
  previewPlan.value = null
  writeError.value = []
  optimizeOpen.value = true
}

async function previewOptimize(): Promise<void> {
  const relPath = selected.value?.relPath
  if (!relPath || writeBusy.value) return
  writeBusy.value = true
  writeError.value = []
  previewPlan.value = null
  try {
    const result = await window.desk.assets.previewOptimize(
      props.tab.knowledgeBaseId,
      [relPath],
      currentOptimizeOptions(),
      report.value?.generation
    )
    if (!result.ok) {
      optimizePreview.value = null
      setWriteError(result.error)
      return
    }
    optimizePreview.value = result.value
  } finally {
    writeBusy.value = false
  }
}

async function confirmOptimize(): Promise<void> {
  const relPath = selected.value?.relPath
  if (!relPath || writeBusy.value) return
  writeBusy.value = true
  writeError.value = []
  try {
    const planned = await window.desk.assets.planOptimize(
      props.tab.knowledgeBaseId,
      [relPath],
      currentOptimizeOptions(),
      report.value?.generation
    )
    if (!planned.ok) {
      setWriteError(planned.error)
      return
    }
    previewPlan.value = planned.value
    writeError.value = classifyAssetWriteBlocks({ planReasons: planned.value.blockedReasons })
    if (planned.value.blockedReasons.length > 0) return
    suppressThumbs.value = true
    const result = await window.desk.assets.apply(props.tab.knowledgeBaseId, planned.value.id)
    if (!result.ok) {
      setWriteError(result.error)
      return
    }
    if (result.value.status !== 'applied') {
      writeError.value = classifyAssetWriteBlocks({
        error: {
          message: result.value.error || '资源操作未完成',
          code: result.value.status
        }
      })
      return
    }
    const dest = planned.value.moves[0]?.toRelPath
    if (dest) selectedPath.value = dest
    syncExcalidrawTabs(planned.value)
    closeDialogs()
    dropStaleReport()
    await scan(true)
    await loadHistory()
  } finally {
    writeBusy.value = false
    suppressThumbs.value = false
  }
}

async function applyPreview(): Promise<void> {
  const plan = previewPlan.value
  if (!plan || plan.blockedReasons.length > 0 || writeBusy.value) return
  const dest =
    plan.kind === 'rename' || plan.kind === 'optimize' ? plan.moves[0]?.toRelPath : undefined
  const recycled =
    plan.kind === 'recycle' || plan.kind === 'merge' || plan.kind === 'optimize'
      ? plan.moves.filter((move) => !move.toRelPath).map((move) => move.fromRelPath)
      : []
  writeBusy.value = true
  writeError.value = []
  try {
    suppressThumbs.value = true
    const result = await window.desk.assets.apply(props.tab.knowledgeBaseId, plan.id)
    if (!result.ok) {
      setWriteError(result.error)
      return
    }
    if (result.value.status !== 'applied') {
      writeError.value = classifyAssetWriteBlocks({
        error: {
          message: result.value.error || '资源操作未完成',
          code: result.value.status
        }
      })
      return
    }
    if (dest) selectedPath.value = dest
    else if (selectedPath.value && recycled.includes(selectedPath.value)) selectedPath.value = null
    syncExcalidrawTabs(plan)
    closeDialogs()
    dropStaleReport()
    await scan(true)
    await loadHistory()
  } finally {
    writeBusy.value = false
    suppressThumbs.value = false
  }
}

function openRestore(item: AssetJournalDto): void {
  if (!item.restorable || writeBusy.value) return
  restoreTarget.value = item
  writeError.value = []
  restoreOpen.value = true
}

async function confirmRestore(): Promise<void> {
  const item = restoreTarget.value
  if (!item || writeBusy.value) return
  writeBusy.value = true
  writeError.value = []
  try {
    suppressThumbs.value = true
    const result = await window.desk.assets.restore(props.tab.knowledgeBaseId, item.planId)
    if (!result.ok) {
      setWriteError(result.error)
      return
    }
    if (result.value.status !== 'applied') {
      writeError.value = classifyAssetWriteBlocks({
        error: {
          message: result.value.error || '资源操作未完成',
          code: result.value.status
        }
      })
      return
    }
    closeDialogs()
    dropStaleReport()
    await scan(true)
    await loadHistory()
  } finally {
    writeBusy.value = false
    suppressThumbs.value = false
  }
}

watch([optimizeEncoder, optimizeStrength, optimizeFormat, optimizeMax], () => {
  optimizePreview.value = null
  previewPlan.value = null
})

watch(renameDest, (dest) => {
  const planned = previewPlan.value
  if (planned?.kind === 'rename' && planned.moves[0]?.toRelPath !== dest.trim()) {
    previewPlan.value = null
    writeError.value = []
  }
})

watch(
  () => props.tab.knowledgeBaseId,
  () => {
    report.value = null
    selectedPath.value = null
    history.value = []
    dispatchPaneView({ type: 'clear-selection' })
    closeDialogs()
    void scan(true)
    void loadSummaries()
    void loadHistory()
  }
)

watch(
  () => props.active,
  (active) => {
    if (active && !report.value && !loading.value) void scan(true)
    if (active && history.value.length === 0) void loadHistory()
  }
)

watch(selectedPath, (value) => {
  // 扫描后选中的文件可能已经不在报告里：回到浏览，别停在空详情。
  if (!value) dispatchPaneView({ type: 'clear-selection' })
})

onMounted(() => {
  unsubscribeProgress = window.desk.assets.onScanProgress((event) => {
    if (event.knowledgeBaseId !== props.tab.knowledgeBaseId) return
    if (event.generation !== generation) return
    progress.value = event
  })
  // 容器查询负责样式，但「窄屏一次只显示一栏」需要可判定的宽度来决定显隐。
  const element = paneElement.value
  if (element && typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width > 0) dispatchPaneView({ type: 'resize', width })
    })
    try {
      resizeObserver.observe(element)
    } catch {
      resizeObserver = null
    }
  }
  if (props.active) {
    void scan(true)
    void loadSummaries()
    void loadHistory()
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  unsubscribeProgress?.()
  if (loading.value) void window.desk.assets.cancel(props.tab.knowledgeBaseId)
})
</script>

<template>
  <div class="kb-assets-pane">
    <!-- 容器查询只作用于这个布局层；对话框留在外面，保持相对视口定位。 -->
    <div ref="paneElement" class="pane-layout">
      <div class="pane-head">
        <header class="pane-header">
          <div class="pane-title">
            <h2>资源 · {{ tab.knowledgeBaseName }}</h2>
            <p class="hint">盘点引用、重命名、回收与本机恢复。操作只作用于当前知识库。</p>
          </div>
          <div class="header-actions">
            <button type="button" class="ghost" :disabled="!loading" @click="cancel">取消</button>
            <button type="button" class="save-button" :disabled="loading" @click="scan(true)">
              {{ loading ? '扫描中…' : '刷新' }}
            </button>
          </div>
        </header>

        <p v-if="progress" class="status" role="status">
          扫描进度 {{ progress.done }} / {{ progress.total }}
          <span v-if="progress.current"> · {{ progress.current }}</span>
        </p>
        <p v-if="error" class="status error" role="alert">{{ error }}</p>
        <p v-if="report" class="coverage" :class="{ warn: !report.coverageComplete }">
          {{ coverageMessage }}
        </p>
        <p v-if="incompleteHistory.length" class="status error">
          事务待恢复：该知识库有未完成的资源事务，请先在「历史」中恢复。未完成前不能开始新的整理。
        </p>

        <section v-if="report" class="stats" aria-label="资源统计">
          <span class="stat-chip">{{ report.stats.assetCount }} 个文件</span>
          <span class="stat-chip">{{ formatBytes(report.stats.assetBytes) }}</span>
          <span class="stat-chip">已解析引用 {{ report.stats.determinedReferenceCount }}</span>
          <span class="stat-chip">不确定引用 {{ report.stats.uncertainReferenceCount }}</span>
          <span class="stat-chip">可合并重复组 {{ report.stats.mergeableDuplicateCount }}</span>
          <span class="stat-chip">跨笔记同内容 {{ report.stats.crossNoteDuplicateCount }}</span>
        </section>

        <div class="view-tabs" role="group" aria-label="资源视图">
          <button
            type="button"
            :class="{ active: view === 'files' }"
            :aria-pressed="view === 'files'"
            @click="view = 'files'"
          >
            文件
          </button>
          <button
            type="button"
            :class="{ active: view === 'broken' }"
            :aria-pressed="view === 'broken'"
            @click="view = 'broken'"
          >
            已确定断链
          </button>
          <button
            type="button"
            :class="{ active: view === 'diagnostics' }"
            :aria-pressed="view === 'diagnostics'"
            @click="view = 'diagnostics'"
          >
            诊断
          </button>
          <button
            type="button"
            :class="{ active: view === 'history' }"
            :aria-pressed="view === 'history'"
            @click="view = 'history'"
          >
            历史
          </button>
        </div>

        <div v-if="view === 'files'" class="filters">
          <input
            v-model="query"
            class="filter-search"
            type="search"
            placeholder="搜索路径"
            aria-label="搜索资源路径"
          />
          <select v-model="kindFilter" class="filter-kind" aria-label="按资源类型筛选">
            <option value="all">全部类型</option>
            <option value="image">图片</option>
            <option value="gif">GIF</option>
            <option value="svg">SVG</option>
            <option value="excalidraw">Excalidraw</option>
            <option value="other">其他</option>
          </select>
          <select v-model="statusFilter" class="filter-status" aria-label="按资源状态筛选">
            <option value="all">全部状态</option>
            <option value="referenced">已引用</option>
            <option value="idle-candidate">疑似闲置</option>
            <option value="uncertain-idle">闲置未确定</option>
            <option value="uncertain-affected">不确定影响</option>
            <option value="protected">受保护</option>
            <option value="duplicates">内容重复</option>
          </select>
          <select v-model="sortKey" class="filter-sort" aria-label="资源排序方式">
            <option value="path">按路径</option>
            <option value="size">按体积</option>
            <option value="refs">按引用数</option>
          </select>
          <div class="view-mode" role="group" aria-label="浏览方式">
            <button
              type="button"
              :class="{ active: browseMode === 'list' }"
              :aria-pressed="browseMode === 'list'"
              @click="browseMode = 'list'"
            >
              列表
            </button>
            <button
              type="button"
              :class="{ active: browseMode === 'grid' }"
              :aria-pressed="browseMode === 'grid'"
              @click="browseMode = 'grid'"
            >
              网格
            </button>
          </div>
          <button
            type="button"
            class="ghost filter-cleanup"
            :disabled="writeBusy || idleCandidates.length === 0"
            @click="openRecycle(idleCandidates.map((asset) => asset.relPath))"
          >
            清理闲置候选
          </button>
        </div>
        <p v-if="view === 'files'" class="hint">
          重复内容筛选随内容哈希上线；此处不按同名或同大小冒充重复。
        </p>
      </div>

      <div v-if="view === 'files'" class="pane-main" :class="{ 'has-detail': Boolean(selected) }">
        <KbAssetsBrowse
          v-show="showBrowse"
          :assets="filteredAssets"
          :total-count="report?.assets.length ?? 0"
          :loading="loading"
          :error="error"
          :selected-path="selectedPath"
          :mode="browseMode"
          :visible="showBrowse"
          :suppress-thumbs="suppressThumbs"
          :knowledge-base-id="tab.knowledgeBaseId"
          :asset-revision="workspace.assetRevisions[tab.knowledgeBaseId] ?? 0"
          @select="selectAsset"
          @clear-filters="clearFilters"
          @retry="scan(true)"
        />
        <KbAssetsDetail
          v-if="selected"
          v-show="showDetail"
          :asset="selected"
          :knowledge-base-id="tab.knowledgeBaseId"
          :asset-revision="workspace.assetRevisions[tab.knowledgeBaseId] ?? 0"
          :merge-group-size="selectedMergeGroup?.relPaths.length ?? null"
          :rename-block="renameBlock"
          :write-busy="writeBusy"
          :show-back="paneView.tier === 'narrow'"
          :in-filtered-results="selectedInFiltered"
          :suppress-thumbs="suppressThumbs"
          @back="returnToBrowse"
          @rename="openRename"
          @merge="openMerge"
          @optimize="openOptimize"
          @recycle="recycleSelected"
          @open-reference="openDetailReference"
        />
      </div>

      <div v-else class="pane-scroll">
        <section v-if="view === 'broken' && report">
          <p v-if="!report.coverageComplete" class="hint warn">
            未覆盖来源的断链状态未知，不能显示「无断链」。下列仅为已解析语法中确定缺失的本地目标。
          </p>
          <ul v-if="report.brokenLinks.length" class="plain-list">
            <li v-for="(item, index) in report.brokenLinks" :key="index">
              <code>{{ item.reference.rawUrl }}</code>
              ← {{ item.reference.sourceRelPath }}:{{ item.reference.line }} ({{ item.reason }})
            </li>
          </ul>
          <p v-else class="hint">已解析范围内没有确定的本地断链。</p>
        </section>

        <section v-else-if="view === 'diagnostics' && report">
          <h3>适配器</h3>
          <ul class="plain-list">
            <li v-for="adapter in report.adapters" :key="adapter.id">
              <strong>{{ adapter.id }}</strong>
              · {{ adapter.status }} · {{ adapter.detail }}
            </li>
          </ul>
          <h3>诊断</h3>
          <ul v-if="report.diagnostics.length" class="plain-list">
            <li v-for="(item, index) in report.diagnostics" :key="index">
              {{ item.code }} · {{ item.message }}
            </li>
          </ul>
          <p v-else class="hint">没有诊断项。</p>
        </section>

        <section v-else-if="view === 'history'" class="history">
          <p class="hint">
            恢复记录保存在本机 userData，不随知识库移动。恢复拒绝覆盖后来编辑的文件。
          </p>
          <ul v-if="history.length" class="plain-list">
            <li v-for="item in history" :key="item.planId" class="history-row">
              <div>
                <strong>{{ planKindLabel(item.kind) }}</strong>
                · {{ stageLabel(item.stage) }} · {{ formatTime(item.createdAt) }}
                <p class="hint">
                  {{ item.moves.map(moveLabel).join('、') || '无路径变更' }}
                  · {{ item.estimated.filesTouched }} 个文件 ·
                  {{ formatBytes(item.estimated.bytesMoved) }}
                </p>
              </div>
              <button
                v-if="item.restorable"
                type="button"
                class="ghost"
                :disabled="writeBusy"
                @click="openRestore(item)"
              >
                {{ item.stage === 'applied' ? '恢复' : '处理未完成事务' }}
              </button>
              <span v-else class="hint">已恢复</span>
            </li>
          </ul>
          <p v-else class="hint">还没有可恢复的整理记录。</p>
        </section>
      </div>

      <details v-if="summaries.length" class="pane-foot others">
        <summary>已管理知识库（{{ summaries.length }}）</summary>
        <p class="hint">只读汇总，点击可打开对应资源面板。不会跨库改文件。</p>
        <ul class="plain-list">
          <li v-for="item in summaries" :key="item.knowledgeBaseId">
            <button
              type="button"
              class="linkish"
              :disabled="item.knowledgeBaseId === tab.knowledgeBaseId"
              @click="openOtherKb(item.knowledgeBaseId)"
            >
              {{ item.displayName }}
            </button>
            · {{ item.fileCount }} 个文件 · {{ formatBytes(item.bytes) }}
          </li>
        </ul>
      </details>
    </div>

    <div
      v-if="renameOpen"
      class="dialog-backdrop"
      @mousedown.self="writeBusy ? undefined : closeDialogs()"
    >
      <form
        class="kb-assets-dialog dialog"
        @submit.prevent="previewPlan ? applyPreview() : previewRename()"
      >
        <header>
          <strong>重命名资源</strong>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            关闭
          </button>
        </header>
        <p class="hint">原路径 {{ selected?.relPath }}</p>
        <label>
          新路径
          <input v-model="renameDest" class="rename-dest" :disabled="writeBusy" />
        </label>
        <div v-if="previewPlan" class="preview">
          <p>
            将改动 {{ previewPlan.estimated.filesTouched }} 个文件，移动
            {{ formatBytes(previewPlan.estimated.bytesMoved) }}。
          </p>
          <ul class="plain-list">
            <li v-for="(move, index) in previewPlan.moves" :key="index">{{ moveLabel(move) }}</li>
          </ul>
          <p v-if="previewPlan.sourceRelPaths.length" class="hint">
            引用补丁：{{ previewPlan.sourceRelPaths.join('、') }}
          </p>
        </div>
        <ul v-if="previewBlocks.length" class="blocked">
          <li v-for="(item, index) in previewBlocks" :key="index">
            <strong>{{ item.label }}</strong>
            · {{ item.message }}
          </li>
        </ul>
        <footer>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            取消
          </button>
          <button
            v-if="!previewPlan"
            type="submit"
            class="save-button"
            :disabled="writeBusy || !renameDest.trim()"
          >
            预览
          </button>
          <button v-else type="submit" class="save-button" :disabled="!canApplyPreview">
            执行
          </button>
        </footer>
      </form>
    </div>

    <div
      v-if="recycleOpen"
      class="dialog-backdrop"
      @mousedown.self="writeBusy ? undefined : closeDialogs()"
    >
      <section class="kb-assets-dialog dialog">
        <header>
          <strong>移入回收区</strong>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            关闭
          </button>
        </header>
        <p class="hint">仅本机可恢复，不永久删除。默认只处理闲置候选。</p>
        <div v-if="previewPlan" class="preview">
          <p>
            将移动 {{ previewPlan.estimated.filesTouched }} 个文件，
            {{ formatBytes(previewPlan.estimated.bytesMoved) }}。
          </p>
          <ul class="plain-list">
            <li v-for="(move, index) in previewPlan.moves" :key="index">{{ moveLabel(move) }}</li>
          </ul>
        </div>
        <ul v-if="previewBlocks.length" class="blocked">
          <li v-for="(item, index) in previewBlocks" :key="index">
            <strong>{{ item.label }}</strong>
            · {{ item.message }}
          </li>
        </ul>
        <footer>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            取消
          </button>
          <button
            type="button"
            class="save-button"
            :disabled="!canApplyPreview"
            @click="applyPreview"
          >
            执行
          </button>
        </footer>
      </section>
    </div>

    <div
      v-if="mergeOpen"
      class="dialog-backdrop"
      @mousedown.self="writeBusy ? undefined : closeDialogs()"
    >
      <section class="kb-assets-dialog dialog">
        <header>
          <strong>合并同笔记重复</strong>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            关闭
          </button>
        </header>
        <p class="hint">只合并同一笔记归属、相同字节的文件。跨笔记同内容只统计，不合并。</p>
        <div v-if="previewPlan" class="preview">
          <p>
            将更新 {{ previewPlan.estimated.filesTouched }} 处，回收
            {{ formatBytes(previewPlan.estimated.bytesMoved) }}。
          </p>
          <ul class="plain-list">
            <li v-for="(move, index) in previewPlan.moves" :key="index">{{ moveLabel(move) }}</li>
          </ul>
        </div>
        <ul v-if="previewBlocks.length" class="blocked">
          <li v-for="(item, index) in previewBlocks" :key="index">
            <strong>{{ item.label }}</strong>
            · {{ item.message }}
          </li>
        </ul>
        <footer>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            取消
          </button>
          <button
            type="button"
            class="save-button"
            :disabled="!canApplyPreview"
            @click="applyPreview"
          >
            执行
          </button>
        </footer>
      </section>
    </div>

    <div
      v-if="optimizeOpen"
      class="dialog-backdrop"
      @mousedown.self="writeBusy ? undefined : closeDialogs()"
    >
      <section class="kb-assets-dialog dialog">
        <header>
          <strong>{{
            optimizeEncoder === 'oxipng' ? '无损优化（oxipng）' : '有损压缩（sharp）'
          }}</strong>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            关闭
          </button>
        </header>
        <p class="hint">
          <template v-if="optimizeEncoder === 'oxipng'">
            无损重压 PNG，更小但较慢（秒级）；仅支持 PNG，不做格式转换与缩放。
          </template>
          <template v-else>
            优先速度和体积，结果是有损的。默认不缩放；转 WebP/JPEG 会改扩展名并改写引用。
          </template>
        </p>
        <fieldset class="field-grid" :disabled="writeBusy" style="border: 0; padding: 0; margin: 0">
          <label class="field">
            <span>编码器</span>
            <select v-model="optimizeEncoder">
              <option value="sharp">sharp（有损，快）</option>
              <option value="oxipng">oxipng（无损，慢）</option>
            </select>
          </label>
          <label class="field">
            <span>压缩强度</span>
            <select v-model="optimizeStrength">
              <option value="low">低 · 少压，偏清晰</option>
              <option value="medium">中 · 均衡（默认）</option>
              <option value="high">高 · 多压，偏体积</option>
            </select>
          </label>
          <template v-if="optimizeEncoder !== 'oxipng'">
            <label class="field">
              <span>输出格式</span>
              <select v-model="optimizeFormat">
                <option value="keep">保持原格式（同路径）</option>
                <option value="webp">转为 WebP（通常更小）</option>
                <option value="jpeg">转为 JPEG</option>
              </select>
            </label>
            <label class="field">
              <span>最大边（可选）</span>
              <input v-model="optimizeMax" type="number" min="64" placeholder="不缩放" />
            </label>
          </template>
        </fieldset>
        <div v-if="optimizePreview" class="preview">
          <p>
            {{ formatBytes(optimizePreview.bytesBefore) }} →
            {{ formatBytes(optimizePreview.bytesAfter) }}
            · 跳过 {{ optimizePreview.skippedCount }}
          </p>
          <ul class="plain-list">
            <li v-for="(item, index) in optimizePreview.items" :key="index">
              <template v-if="item.skipped">{{ item.fromRelPath }} · {{ item.skipped }}</template>
              <template v-else>
                {{ item.fromRelPath }}
                <span v-if="item.toRelPath !== item.fromRelPath"> → {{ item.toRelPath }}</span>
                · {{ formatBytes(item.bytesBefore) }} → {{ formatBytes(item.bytesAfter ?? 0) }} ·
                {{ item.ms }}ms · {{ item.lossy ? '有损' : '无损' }}
              </template>
            </li>
          </ul>
          <img
            v-if="optimizePreview.items[0]?.previewDataUrl"
            class="optimize-preview"
            :src="optimizePreview.items[0].previewDataUrl"
            alt="优化预览"
          />
        </div>
        <ul v-if="previewBlocks.length" class="blocked">
          <li v-for="(item, index) in previewBlocks" :key="index">
            <strong>{{ item.label }}</strong>
            · {{ item.message }}
          </li>
        </ul>
        <footer>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            取消
          </button>
          <button type="button" class="ghost" :disabled="writeBusy" @click="previewOptimize">
            预览
          </button>
          <button
            type="button"
            class="save-button"
            :disabled="
              writeBusy ||
              !optimizePreview ||
              optimizePreview.skippedCount === optimizePreview.items.length
            "
            @click="confirmOptimize"
          >
            执行{{ optimizeEncoder === 'oxipng' ? '无损优化' : '有损压缩' }}
          </button>
        </footer>
      </section>
    </div>

    <div
      v-if="restoreOpen && restoreTarget"
      class="dialog-backdrop"
      @mousedown.self="writeBusy ? undefined : closeDialogs()"
    >
      <section class="kb-assets-dialog dialog">
        <header>
          <strong>恢复资源操作</strong>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            关闭
          </button>
        </header>
        <p>
          {{ planKindLabel(restoreTarget.kind) }} · {{ stageLabel(restoreTarget.stage) }} ·
          {{ formatTime(restoreTarget.createdAt) }}
        </p>
        <ul class="plain-list">
          <li v-for="(move, index) in restoreTarget.moves" :key="index">{{ moveLabel(move) }}</li>
        </ul>
        <p class="hint">若原路径或引用源已被后来编辑，恢复会拒绝覆盖并保留备份。</p>
        <ul v-if="writeError.length" class="blocked">
          <li v-for="(item, index) in writeError" :key="index">
            <strong>{{ item.label }}</strong>
            · {{ item.message }}
          </li>
        </ul>
        <footer>
          <button type="button" class="ghost" :disabled="writeBusy" @click="closeDialogs">
            取消
          </button>
          <button type="button" class="save-button" :disabled="writeBusy" @click="confirmRestore">
            恢复
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>

<style src="./kbAssetsShared.css" scoped></style>

<style src="../components/settings/settingsShared.css" scoped></style>

<style scoped>
.kb-assets-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
}

/* 断点按面板自身宽度判定：Desk 支持分栏，窗口宽度不可靠。 */
.pane-layout {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  container-name: kb-assets-pane;
}

/* 顶部工具区固定在面板内；高度不足时它自己滚动，不挤占浏览 / 详情。 */
.pane-head {
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 24px 8px;
}

.pane-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.pane-title {
  min-width: 0;
}

.pane-header h2 {
  margin: 0 0 4px;
  font-size: 18px;
}

.pane-header p {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.status {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.status.error,
.hint.warn,
.coverage.warn {
  color: #b58900;
}

.status.error {
  color: #c44;
}

.coverage {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 13px;
}

/* 统计只做紧凑小标签，不用大号统计卡片。 */
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 0;
}

.stat-chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 9px;
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}

.view-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 0;
}

.view-tabs button {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  border-radius: 7px;
  padding: 6px 10px;
  cursor: pointer;
}

.view-tabs button.active {
  border-color: var(--accent);
}

/*
 * 用 Grid 约束控件尺寸：共享设置样式给 input / select 设了 width: 100%，
 * 在 flex-wrap 里会把每个控件拉成整行。Grid 里 width: 100% 只填满所在列，
 * 不需要 !important，也不去改共享样式。
 */
.filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 10px;
  align-items: center;
  margin: 12px 0 0;
}

.filters .filter-search {
  grid-column: 1 / -1;
}

.filters input,
.filters select {
  min-width: 0;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--input-bg);
  color: var(--text);
  padding: 0 8px;
  box-sizing: border-box;
}

.view-mode {
  display: inline-flex;
  justify-self: start;
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
}

.view-mode button {
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 7px 12px;
  font-size: 12px;
  cursor: pointer;
}

.view-mode button + button {
  border-left: 1px solid var(--border);
}

.view-mode button.active {
  background: var(--accent);
  color: #fff;
}

.filter-cleanup {
  justify-self: start;
  padding: 6px 12px;
}

.history {
  margin: 12px 0;
}

.others {
  margin: 0;
}

.others summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
}

.others .hint {
  margin: 6px 0;
}

/* 浏览 / 详情：顶部工具区固定，两个区域各自滚动。
   flex-basis 取 0 让高度由剩余空间决定；min-height 兜底，顶部再高也挤不没它。 */
.pane-main {
  flex: 1 1 0;
  min-height: 200px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 16px;
  padding: 0 24px 16px;
}

.pane-scroll {
  flex: 1 1 0;
  min-height: 200px;
  overflow: auto;
  padding: 0 24px 16px;
}

/* 「已管理知识库」收成折叠脚注：默认不占浏览空间，需要时仍可达。 */
.pane-foot {
  flex: none;
  min-height: 0;
  max-height: 35%;
  overflow: auto;
  border-top: 1px solid var(--border);
  padding: 8px 24px;
}

/* 详情列只在选中后出现；没选中时浏览区占满宽度，不留空列。 */
@container kb-assets-pane (min-width: 800px) {
  .pane-main.has-detail {
    grid-template-columns: minmax(0, 1fr) minmax(300px, 340px);
  }

  /* 中屏工具栏允许两行。 */
  .filters {
    grid-template-columns: minmax(0, 1fr) minmax(112px, 150px) minmax(112px, 160px);
  }

  .filters .filter-search {
    grid-column: auto;
  }
}

@container kb-assets-pane (min-width: 1200px) {
  .pane-main.has-detail {
    grid-template-columns: minmax(0, 1fr) minmax(360px, 440px);
  }

  /* 宽屏工具栏回到一行。 */
  .filters {
    grid-template-columns:
      minmax(0, 1fr) minmax(120px, 150px) minmax(120px, 160px) minmax(110px, 140px) max-content
      max-content;
  }
}

@container kb-assets-pane (max-width: 799.98px) {
  .pane-head {
    padding: 12px 14px 6px;
  }

  .pane-main,
  .pane-scroll,
  .pane-foot {
    padding-left: 14px;
    padding-right: 14px;
  }
}

.history-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, #000 35%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}

.kb-assets-dialog {
  width: min(520px, calc(100vw - 32px));
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  color: var(--text);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.kb-assets-dialog header,
.kb-assets-dialog footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.kb-assets-dialog label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.kb-assets-dialog input {
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--input-bg);
  color: var(--text);
  padding: 0 8px;
}

.blocked {
  list-style: none;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, #c44 10%, transparent);
  color: #c44;
  font-size: 13px;
}

.preview {
  font-size: 13px;
}

.optimize-preview {
  display: block;
  max-width: 100%;
  max-height: 240px;
  margin-top: 8px;
  border-radius: 8px;
  background: var(--input-bg);
}

.field-grid {
  display: grid;
  gap: 10px;
  margin: 12px 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
</style>
