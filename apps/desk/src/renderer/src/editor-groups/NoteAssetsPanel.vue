<script setup lang="ts">
/**
 * 笔记级资源面板（右侧边栏内容）。
 *
 * 只做「这一篇笔记」的资源：先解析正文里的引用，再列一层 `assets/` 目录，
 * 交给 `noteAssets.ts` 的纯逻辑分组。面板自己负责取列表、复制路径、插入、
 * 定位引用、修复编号与删除无效资源；插入 / 定位的落地由父容器接 `insert` /
 * `locate` 事件完成。
 *
 * 两点刻意的取舍：
 * - 删除走 assets 写事务的「回收区」，不是物理删除（本机可恢复）。
 * - 修复编号只提交 rename 计划：笔记里的引用改写由主进程的计划自动 patch，
 *   面板绝不自己改笔记源码（避免与编辑器状态打架）。
 */
import { computed, onUnmounted, ref, watch } from 'vue'

import { resolveMarkdownImageUrl } from '../markdown/markdownAssetUrl'
import { noteRelativeAssetPath } from '../markdown/noteAssetPath'
import { useWorkspaceStore } from '../stores/workspace'
import { documentKey } from '../stores/workspace/helpers'
import {
  buildNoteAssetsView,
  formatBytes,
  indexPrefixedName,
  insertableImageMarkdown,
  type NoteAssetEntry,
  type NoteAssetsListingEntry
} from './noteAssets'

const props = defineProps<{
  knowledgeBaseId: string
  noteUuid: string
  /** 笔记的知识库相对路径（`notes/…/0007. x.md`）。 */
  noteRelPath: string
  /** 笔记编号（四位前缀）。 */
  noteIndex: string
  /** 笔记 markdown：只读它解析引用，面板不回写。 */
  source: string
  /** 文档只读 → 禁用插入 / 修复 / 删除，只留查看与复制。 */
  readOnly: boolean
  /** 嵌在文档属性侧栏时隐藏自身关闭按钮。 */
  showClose?: boolean
}>()

const emit = defineEmits<{
  (event: 'insert', relPath: string): void
  (event: 'locate', rawPath: string): void
  (event: 'close'): void
}>()

const workspace = useWorkspaceStore()

const listing = ref<NoteAssetsListingEntry[]>([])
const loading = ref(false)
const listError = ref<string | null>(null)
const actionError = ref<string | null>(null)
/** 资源写事务进行中：所有操作按钮禁用，避免并发重复提交。 */
const busy = ref(false)
const copiedRelPath = ref<string | null>(null)
const zoomedRelPath = ref<string | null>(null)
/** 删除是两步行内确认：这里存等待确认的那一行。 */
const confirmingRelPath = ref<string | null>(null)

let loadGeneration = 0
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

/** 视图是 computed：`source` / `noteIndex` / `noteRelPath` 一变就自动重建，无需额外 watch。 */
const view = computed(() =>
  buildNoteAssetsView({
    source: props.source,
    noteRelPath: props.noteRelPath,
    noteIndex: props.noteIndex,
    listing: listing.value
  })
)

/**
 * `view.missing` 是 `view.referenced` 里磁盘上没有的那部分（`entry.exists === false`）。
 * 两块都渲染会得到重复行，所以「引用的资源」只列磁盘上真实存在的，缺失的集中到下方警告分区。
 */
const referencedPresent = computed(() => view.value.referenced.filter((entry) => entry.exists))
const hasAnyAsset = computed(() => view.value.referenced.length > 0 || view.value.own.length > 0)

/**
 * `view.invalid` 是 `view.own` 的一个子集（同一批对象）。
 * 但 `buildNoteAssetsView` 目前只在 `view.invalid` 这个数组上表达「无效」，`entry.invalid`
 * 标志位始终是 false —— 所以这里按路径集合判断，不依赖那个字段。
 */
const invalidPaths = computed(() => new Set(view.value.invalid.map((entry) => entry.relPath)))

function isInvalid(entry: NoteAssetEntry): boolean {
  return entry.invalid || invalidPaths.value.has(entry.relPath)
}

const IMAGE_EXT = /\.(?:png|jpe?g|jfif|gif|webp|avif|bmp|svg)$/i

function isImage(relPath: string): boolean {
  return IMAGE_EXT.test(relPath)
}

/** 非图片行用扩展名当图标（纯文本，不做任何 HTML 注入）。 */
function fileBadge(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return '文件'
  return name
    .slice(dot + 1)
    .toUpperCase()
    .slice(0, 3)
}

/** 缩略图走受控的 tnotes-asset 协议；路径算不出来（越界）时返回空串，不硬编码 file://。 */
function assetThumbSrc(entry: NoteAssetEntry): string {
  const relative = noteRelativeAssetPath(props.noteRelPath, entry.relPath)
  if (!relative) return ''
  return resolveMarkdownImageUrl(relative, props.knowledgeBaseId, props.noteUuid)
}

function canPreview(entry: NoteAssetEntry): boolean {
  return entry.exists && isImage(entry.relPath)
}

/** 初版只做图片：非图片没有可插入的 markdown。只读与否交给按钮的 disabled。 */
function isInsertable(entry: NoteAssetEntry): boolean {
  return insertableImageMarkdown(props.noteRelPath, entry.relPath) !== null
}

/** 修复后的目标路径：同目录，文件名换成 `{笔记编号}-{去掉旧前缀的名字}`。 */
function fixedTargetRelPath(entry: NoteAssetEntry): string | null {
  if (!props.noteIndex) return null
  const name = indexPrefixedName(props.noteIndex, entry.name)
  if (!name || name === entry.name) return null
  return entry.relPath.replace(/[^/]+$/, name)
}

function resetTransientState(): void {
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = null
  copiedRelPath.value = null
  zoomedRelPath.value = null
  confirmingRelPath.value = null
  actionError.value = null
}

async function load(): Promise<void> {
  const generation = (loadGeneration += 1)
  loading.value = true
  listError.value = null
  try {
    const result = await window.desk.kbFiles.list({
      knowledgeBaseId: props.knowledgeBaseId,
      relPath: 'assets'
    })
    if (generation !== loadGeneration) return
    if (!result.ok) {
      listing.value = []
      listError.value = result.error.message
      return
    }
    listing.value = result.value.entries
  } catch (cause) {
    if (generation !== loadGeneration) return
    listing.value = []
    listError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

/**
 * 资源写入门禁会拦住「笔记有未保存内容」：动手前先 flush 笔记，
 * 保存失败就取消整次操作，而不是让门禁抛一个看不懂的错。
 */
async function saveNoteFirst(): Promise<boolean> {
  try {
    await workspace.saveDocument(documentKey(props.knowledgeBaseId, props.noteUuid))
    return true
  } catch (cause) {
    actionError.value = `保存笔记失败，已取消资源操作：${
      cause instanceof Error ? cause.message : String(cause)
    }`
    return false
  }
}

/**
 * 写剪贴板：优先异步 API，失败退回同步的用户手势路径。
 *
 * 与 `MilkdownMarkdownEditor.writeClipboard` 同一套做法：Electron 可能暴露了 Clipboard
 * 却没给渲染端异步剪贴板权限，只调 `navigator.clipboard` 会静默失败。
 */
async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 落到下面的同步路径
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

async function copyPath(entry: NoteAssetEntry): Promise<void> {
  // 复制的是**相对笔记文件**的路径（和正文里写的一致），不是库相对路径。
  const relative = noteRelativeAssetPath(props.noteRelPath, entry.relPath)
  if (!relative) {
    actionError.value = `算不出 ${entry.name} 相对这篇笔记的路径，无法复制。`
    return
  }
  actionError.value = null
  try {
    await writeClipboard(relative)
    copiedRelPath.value = entry.relPath
  } catch {
    actionError.value = '复制失败：剪贴板不可用。'
    return
  }
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    copiedRelPath.value = null
    copyResetTimer = null
  }, 1200)
}

function locateReference(entry: NoteAssetEntry): void {
  const reference = entry.references[0]
  if (!reference) return
  emit('locate', reference.rawPath)
}

function insertAsset(entry: NoteAssetEntry): void {
  if (props.readOnly || busy.value) return
  emit('insert', entry.relPath)
}

function toggleZoom(entry: NoteAssetEntry): void {
  zoomedRelPath.value = zoomedRelPath.value === entry.relPath ? null : entry.relPath
}

function closeZoom(): void {
  zoomedRelPath.value = null
}

function askDelete(entry: NoteAssetEntry): void {
  if (props.readOnly || busy.value) return
  confirmingRelPath.value = entry.relPath
}

function cancelDelete(): void {
  confirmingRelPath.value = null
}

/** 计划被阻止时的原因直接展示，不吞。 */
function blockedMessage(blockedReasons: readonly string[]): string {
  return `资源操作被阻止：${blockedReasons.join('；')}`
}

async function fixIndex(entry: NoteAssetEntry): Promise<void> {
  if (props.readOnly || busy.value) return
  const target = fixedTargetRelPath(entry)
  if (!target) {
    actionError.value = '拿不到这篇笔记的编号，暂时不能修复前缀。'
    return
  }
  busy.value = true
  actionError.value = null
  try {
    if (!(await saveNoteFirst())) return
    const planned = await window.desk.assets.planRename(
      props.knowledgeBaseId,
      entry.relPath,
      target
    )
    if (!planned.ok) {
      actionError.value = planned.error.message
      return
    }
    if (planned.value.blockedReasons.length > 0) {
      actionError.value = blockedMessage(planned.value.blockedReasons)
      return
    }
    const applied = await window.desk.assets.apply(props.knowledgeBaseId, planned.value.id)
    if (!applied.ok) {
      actionError.value = applied.error.message
      return
    }
    if (applied.value.status !== 'applied') {
      actionError.value = applied.value.error || `资源操作未完成（${applied.value.status}）。`
      return
    }
    // 引用改写由主进程的 rename 计划完成，这里只重新取一次列表。
    confirmingRelPath.value = null
    await load()
  } finally {
    busy.value = false
  }
}

async function recycleInvalid(entry: NoteAssetEntry): Promise<void> {
  if (props.readOnly || busy.value) return
  busy.value = true
  actionError.value = null
  try {
    if (!(await saveNoteFirst())) return
    // 画布是「一份资源两半」：同名配对文件同样无效时一起回收，避免留下孤儿
    const targets = [entry.relPath]
    if (entry.pairRelPath && invalidPaths.value.has(entry.pairRelPath)) {
      targets.push(entry.pairRelPath)
    }
    // targeted：这是用户逐个确认的定向删除（不是整库批量清理），
    // 主进程据此放开"画布源文件受保护"这条；"资源确实没有引用"仍然挡着。
    const planned = await window.desk.assets.planRecycle(
      props.knowledgeBaseId,
      targets,
      undefined,
      { targeted: true }
    )
    if (!planned.ok) {
      actionError.value = planned.error.message
      return
    }
    if (planned.value.blockedReasons.length > 0) {
      actionError.value = blockedMessage(planned.value.blockedReasons)
      return
    }
    const applied = await window.desk.assets.apply(props.knowledgeBaseId, planned.value.id)
    if (!applied.ok) {
      actionError.value = applied.error.message
      return
    }
    if (applied.value.status !== 'applied') {
      actionError.value = applied.value.error || `资源操作未完成（${applied.value.status}）。`
      return
    }
    confirmingRelPath.value = null
    await load()
  } finally {
    busy.value = false
  }
}

// 换库 / 换笔记：清掉临时态再重新取列表（`source` 只影响 computed 视图，不必重取）。
watch(
  () => [props.knowledgeBaseId, props.noteUuid, props.noteRelPath] as const,
  () => {
    resetTransientState()
    void load()
  },
  { immediate: true }
)

onUnmounted(() => {
  if (copyResetTimer) clearTimeout(copyResetTimer)
})
</script>

<template>
  <aside class="note-assets-panel" aria-label="笔记资源">
    <header class="panel-head">
      <div class="panel-title">
        <h3>资源</h3>
        <p class="panel-sub">
          <template v-if="noteIndex">编号 {{ noteIndex }}</template>
          <template v-else>这篇笔记没有编号</template>
          · assets/
        </p>
      </div>
      <div class="head-actions">
        <button
          type="button"
          class="head-button"
          data-note-assets-refresh
          aria-label="刷新资源列表"
          :disabled="loading || busy"
          @click="load"
        >
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
        <button
          v-if="showClose !== false"
          type="button"
          class="head-button"
          data-note-assets-close
          aria-label="关闭资源面板"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>
    </header>

    <p v-if="loading" class="panel-status" role="status">正在读取 assets/ 目录…</p>
    <p v-if="busy" class="panel-status" role="status" data-note-assets-busy>
      正在整理资源，请稍候…
    </p>

    <p v-if="listError" class="panel-message is-error" role="alert" data-note-assets-error>
      读取资源列表失败：{{ listError }}
      <button type="button" class="head-button retry" :disabled="loading || busy" @click="load">
        重试
      </button>
    </p>
    <p v-if="actionError" class="panel-message is-error" role="alert" data-note-assets-action-error>
      {{ actionError }}
    </p>

    <div class="panel-scroll">
      <p v-if="!loading && !listError && !hasAnyAsset" class="empty" data-note-assets-empty>
        这篇笔记还没有资源。可以用编辑器右上角的「插入图片」加入图片，加入后它会出现在这里。
      </p>

      <!-- 引用的资源：正文里出现过的（磁盘上存在的那些） -->
      <section
        v-if="referencedPresent.length > 0"
        class="asset-section"
        data-note-assets-section="referenced"
      >
        <h4>
          引用的资源
          <span class="section-count">{{ referencedPresent.length }}</span>
        </h4>
        <p class="section-hint">笔记正文里引用到的资源。定位可跳到正文中的那一处引用。</p>
        <ul class="asset-list">
          <li
            v-for="entry in referencedPresent"
            :key="entry.relPath"
            class="asset-row"
            :data-note-assets-row="entry.relPath"
          >
            <div class="row-main">
              <button
                v-if="canPreview(entry)"
                type="button"
                class="thumb-button"
                :disabled="busy"
                :aria-label="`放大预览 ${entry.name}`"
                :aria-expanded="zoomedRelPath === entry.relPath"
                @click="toggleZoom(entry)"
              >
                <img
                  class="thumb"
                  :src="assetThumbSrc(entry)"
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              </button>
              <span v-else class="thumb-badge" aria-hidden="true">{{ fileBadge(entry.name) }}</span>
              <div class="row-text">
                <span class="row-name" :title="entry.relPath">{{ entry.name }}</span>
                <span class="row-meta">
                  {{ formatBytes(entry.bytes) }} · 引用 {{ entry.references.length }} 次
                </span>
              </div>
            </div>

            <div class="row-actions">
              <button
                type="button"
                class="row-action row-copy"
                :disabled="busy"
                :aria-label="`复制 ${entry.name} 的相对路径`"
                @click="copyPath(entry)"
              >
                {{ copiedRelPath === entry.relPath ? '已复制' : '复制路径' }}
              </button>
              <button
                v-if="entry.references.length > 0"
                type="button"
                class="row-action row-locate"
                :disabled="busy"
                :aria-label="`定位到正文中 ${entry.name} 的引用`"
                :title="`正文第 ${entry.references[0]!.line} 行`"
                @click="locateReference(entry)"
              >
                定位引用
              </button>
              <button
                v-if="isInsertable(entry)"
                type="button"
                class="row-action row-insert"
                :disabled="readOnly || busy"
                :aria-label="`插入 ${entry.name} 到当前笔记`"
                :title="readOnly ? '文档只读：不能插入资源' : '把资源插入当前笔记'"
                @click="insertAsset(entry)"
              >
                插入
              </button>
              <button
                v-if="entry.needsIndexFix"
                type="button"
                class="row-action row-fix"
                :disabled="readOnly || busy || !fixedTargetRelPath(entry)"
                :aria-label="`修复 ${entry.name} 的编号前缀`"
                :title="
                  readOnly
                    ? '文档只读：不能修复编号'
                    : `重命名为 ${entry.fixedName}，并改写笔记里的引用`
                "
                @click="fixIndex(entry)"
              >
                修复编号
              </button>
            </div>

            <button
              v-if="zoomedRelPath === entry.relPath"
              type="button"
              class="zoom-frame"
              :aria-label="`收起 ${entry.name} 的放大预览`"
              @click="closeZoom"
            >
              <img class="zoom-image" :src="assetThumbSrc(entry)" :alt="entry.name" />
            </button>
          </li>
        </ul>
      </section>

      <!-- 编号匹配的资源：文件名四位前缀就是这篇笔记的编号 -->
      <section v-if="view.own.length > 0" class="asset-section" data-note-assets-section="own">
        <h4>
          编号匹配的资源
          <span class="section-count">{{ view.own.length }}</span>
        </h4>
        <p class="section-hint">
          文件名前缀属于这篇笔记的资源。未被正文引用的是无效资源，可以删除（移入回收区，可恢复）。
        </p>
        <ul class="asset-list">
          <li
            v-for="entry in view.own"
            :key="entry.relPath"
            class="asset-row"
            :class="{ 'is-invalid': isInvalid(entry) }"
            :data-note-assets-row="entry.relPath"
          >
            <div class="row-main">
              <button
                v-if="canPreview(entry)"
                type="button"
                class="thumb-button"
                :disabled="busy"
                :aria-label="`放大预览 ${entry.name}`"
                :aria-expanded="zoomedRelPath === entry.relPath"
                @click="toggleZoom(entry)"
              >
                <img
                  class="thumb"
                  :src="assetThumbSrc(entry)"
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              </button>
              <span v-else class="thumb-badge" aria-hidden="true">{{ fileBadge(entry.name) }}</span>
              <div class="row-text">
                <span class="row-name" :title="entry.relPath">{{ entry.name }}</span>
                <span class="row-meta">
                  {{ formatBytes(entry.bytes) }} ·
                  {{
                    entry.references.length > 0 ? `引用 ${entry.references.length} 次` : '未被引用'
                  }}
                  <span v-if="isInvalid(entry)" class="tag tag-warn">可删除</span>
                </span>
              </div>
            </div>

            <div class="row-actions">
              <button
                type="button"
                class="row-action row-copy"
                :disabled="busy"
                :aria-label="`复制 ${entry.name} 的相对路径`"
                @click="copyPath(entry)"
              >
                {{ copiedRelPath === entry.relPath ? '已复制' : '复制路径' }}
              </button>
              <button
                v-if="entry.references.length > 0"
                type="button"
                class="row-action row-locate"
                :disabled="busy"
                :aria-label="`定位到正文中 ${entry.name} 的引用`"
                :title="`正文第 ${entry.references[0]!.line} 行`"
                @click="locateReference(entry)"
              >
                定位引用
              </button>
              <button
                v-if="isInsertable(entry)"
                type="button"
                class="row-action row-insert"
                :disabled="readOnly || busy"
                :aria-label="`插入 ${entry.name} 到当前笔记`"
                :title="readOnly ? '文档只读：不能插入资源' : '把资源插入当前笔记'"
                @click="insertAsset(entry)"
              >
                插入
              </button>
              <button
                v-if="entry.needsIndexFix"
                type="button"
                class="row-action row-fix"
                :disabled="readOnly || busy || !fixedTargetRelPath(entry)"
                :aria-label="`修复 ${entry.name} 的编号前缀`"
                :title="
                  readOnly
                    ? '文档只读：不能修复编号'
                    : `重命名为 ${entry.fixedName}，并改写笔记里的引用`
                "
                @click="fixIndex(entry)"
              >
                修复编号
              </button>
              <template v-if="isInvalid(entry)">
                <template v-if="confirmingRelPath === entry.relPath">
                  <button
                    type="button"
                    class="row-action row-confirm"
                    :disabled="busy"
                    :aria-label="`确认删除 ${entry.name}`"
                    @click="recycleInvalid(entry)"
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    class="row-action row-cancel"
                    :disabled="busy"
                    :aria-label="`取消删除 ${entry.name}`"
                    @click="cancelDelete"
                  >
                    取消
                  </button>
                </template>
                <button
                  v-else
                  type="button"
                  class="row-action row-delete"
                  :disabled="readOnly || busy"
                  :aria-label="`删除资源 ${entry.name}`"
                  :title="
                    readOnly ? '文档只读：不能删除资源' : '移入回收区（本机可恢复，不是物理删除）'
                  "
                  @click="askDelete(entry)"
                >
                  删除
                </button>
              </template>
            </div>

            <button
              v-if="zoomedRelPath === entry.relPath"
              type="button"
              class="zoom-frame"
              :aria-label="`收起 ${entry.name} 的放大预览`"
              @click="closeZoom"
            >
              <img class="zoom-image" :src="assetThumbSrc(entry)" :alt="entry.name" />
            </button>
          </li>
        </ul>
      </section>

      <!-- 引用缺失：正文引用了，但磁盘上没有 -->
      <section
        v-if="view.missing.length > 0"
        class="asset-section is-warning"
        data-note-assets-section="missing"
      >
        <h4>
          引用缺失
          <span class="section-count">{{ view.missing.length }}</span>
        </h4>
        <p class="section-hint">
          笔记里引用了这些资源，但磁盘上没有：可能被删除、改名，或还没同步过来。可以定位到正文里那一处再处理。
        </p>
        <ul class="asset-list">
          <li
            v-for="entry in view.missing"
            :key="entry.relPath"
            class="asset-row is-missing"
            :data-note-assets-row="entry.relPath"
          >
            <div class="row-main">
              <span class="thumb-badge" aria-hidden="true">缺</span>
              <div class="row-text">
                <span class="row-name" :title="entry.relPath">{{ entry.name }}</span>
                <span class="row-meta">
                  磁盘上没有 · 引用 {{ entry.references.length }} 次
                  <span v-if="entry.references[0]" class="ref-line">
                    · 正文第 {{ entry.references[0].line }} 行
                  </span>
                </span>
              </div>
            </div>

            <div class="row-actions">
              <button
                type="button"
                class="row-action row-copy"
                :disabled="busy"
                :aria-label="`复制 ${entry.name} 的相对路径`"
                @click="copyPath(entry)"
              >
                {{ copiedRelPath === entry.relPath ? '已复制' : '复制路径' }}
              </button>
              <button
                v-if="entry.references.length > 0"
                type="button"
                class="row-action row-locate"
                :disabled="busy"
                :aria-label="`定位到正文中 ${entry.name} 的引用`"
                :title="`正文第 ${entry.references[0]!.line} 行`"
                @click="locateReference(entry)"
              >
                定位引用
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.note-assets-panel {
  /* 父容器给固定宽度，这里只负责自适应：内部纵向滚动、横向绝不溢出。 */
  --checker: color-mix(in srgb, var(--text) 10%, transparent);
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
  background: var(--editor-bg);
  color: var(--text);
}

.panel-head {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.panel-title {
  min-width: 0;
}

.panel-head h3 {
  margin: 0;
  font-size: 14px;
}

.panel-sub {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.head-actions {
  flex: none;
  display: flex;
  gap: 6px;
}

.head-button {
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 12px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.head-button:hover:not(:disabled) {
  background: var(--hover);
}

.head-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.panel-status {
  flex: none;
  margin: 0;
  padding: 6px 12px;
  color: var(--muted);
  font-size: 12px;
}

.panel-message {
  flex: none;
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.panel-message.is-error {
  color: var(--danger);
  background: var(--danger-soft);
}

.panel-message .retry {
  margin-left: 6px;
}

.panel-scroll {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 12px 16px;
}

.empty {
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}

.asset-section {
  margin: 0 0 14px;
  min-width: 0;
}

.asset-section h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 4px;
  font-size: 13px;
}

.section-count {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
}

.section-hint {
  margin: 0 0 6px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}

.asset-section.is-warning h4 {
  color: var(--danger);
}

.asset-section.is-warning .section-hint {
  color: var(--danger);
}

.asset-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.asset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
  box-sizing: border-box;
}

.asset-row.is-invalid {
  border-style: dashed;
}

.asset-row.is-missing {
  border-color: var(--danger);
  background: var(--danger-soft);
}

.row-main {
  flex: 1 1 140px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.thumb-button {
  flex: none;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--editor-bg);
  cursor: zoom-in;
  overflow: hidden;
}

/* 写入进行中：缩略图不可展开，路径可能正在移动。 */
.thumb-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.thumb {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-badge {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.row-name {
  font-size: 13px;
  /* 长文件名允许换行，不把面板撑宽。 */
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.35;
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.tag {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
  font-size: 10px;
}

.tag-warn {
  border-color: var(--danger);
  color: var(--danger);
}

.row-actions {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-left: auto;
}

.row-action {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.row-action:hover:not(:disabled) {
  background: var(--hover);
}

.row-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.row-copy {
  color: var(--accent-strong);
}

.row-fix {
  color: var(--accent-strong);
  border-color: var(--accent-strong);
}

.row-delete,
.row-confirm {
  color: var(--danger);
  border-color: var(--danger);
}

.row-confirm {
  font-weight: 600;
  background: var(--danger-soft);
}

.zoom-frame {
  flex: 1 1 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  max-height: 260px;
  margin-top: 4px;
  padding: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: zoom-out;
  /* 透明区域用棋盘格表示，不能靠底色猜。 */
  background-color: var(--editor-bg);
  background-image:
    linear-gradient(45deg, var(--checker) 25%, transparent 25%),
    linear-gradient(-45deg, var(--checker) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--checker) 75%),
    linear-gradient(-45deg, transparent 75%, var(--checker) 75%);
  background-size: 16px 16px;
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
  box-sizing: border-box;
}

.zoom-image {
  max-width: 100%;
  max-height: 240px;
  /* 完整显示，不裁切截图 / 图表。 */
  object-fit: contain;
}
</style>
