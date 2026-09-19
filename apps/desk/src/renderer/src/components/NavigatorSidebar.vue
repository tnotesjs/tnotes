<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

import TocNodeList from './TocNodeList.vue'
import UiTooltip from './UiTooltip.vue'
import { classifyChangePath } from './changeCategory'
import { mergeRenameChanges } from './mergeRenameChanges'
import { noteFileName } from '../commands/noteFileName'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'

import type { DeskTocNode, NavigatorSidebarMenuAction } from '../../../shared/contracts'

const emit = defineEmits<{
  createNote: [node?: DeskTocNode, placement?: 'before' | 'after' | 'inside']
  createGroup: []
  requestRename: [node: DeskTocNode]
  requestDelete: [node: DeskTocNode]
}>()

const store = useWorkspaceStore()
const editor = useEditorStore()
const query = ref('')
const changesExpanded = ref(!(store.settings?.toc?.changesCollapsedByDefault ?? true))
const tocExpanded = ref(true)
const noteFileExpanded = ref(true)
const configFileExpanded = ref(true)
const otherFileExpanded = ref(true)
const tocListRef = ref<InstanceType<typeof TocNodeList> | null>(null)
const previewBusy = ref(false)
const menuBusy = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

function filterNodes(nodes: DeskTocNode[], needle: string): DeskTocNode[] {
  if (!needle) return nodes
  return nodes.flatMap((node): DeskTocNode[] => {
    const children = filterNodes(node.children, needle)
    const matches =
      node.title.toLocaleLowerCase().includes(needle) ||
      (node.type === 'note' && node.noteIndex.includes(needle))
    return matches || children.length ? [{ ...node, children }] : []
  })
}

const visibleToc = computed(() =>
  filterNodes(store.knowledgeBase?.toc ?? [], query.value.trim().toLocaleLowerCase())
)

watch([() => query.value, () => store.selectedKnowledgeBaseId], () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    void store.searchNotes(query.value)
  }, 180)
})

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

const previewState = computed(() =>
  store.selectedKnowledgeBaseId
    ? (editor.previewStates[store.selectedKnowledgeBaseId] ?? null)
    : null
)

const gitState = computed(() =>
  store.selectedKnowledgeBaseId ? (store.gitStates[store.selectedKnowledgeBaseId] ?? null) : null
)
const tocShowIndex = computed(() => store.settings?.toc?.showNoteIndex !== false)

const noteFileChanges = computed(() =>
  (gitState.value?.changes ?? []).filter((change) => classifyChangePath(change.path) === 'noteFile')
)
const configFileChanges = computed(() =>
  (gitState.value?.changes ?? []).filter(
    (change) => classifyChangePath(change.path) === 'configFile'
  )
)
const otherFileChanges = computed(() =>
  (gitState.value?.changes ?? []).filter(
    (change) => classifyChangePath(change.path) === 'otherFile'
  )
)
// Display-level rename merge: counts stay the true raw git counts above.
const displayNoteFileChanges = computed(() => mergeRenameChanges(noteFileChanges.value))
const displayConfigFileChanges = computed(() => mergeRenameChanges(configFileChanges.value))
const displayOtherFileChanges = computed(() => mergeRenameChanges(otherFileChanges.value))
const selectedTocNoteUuid = computed(() => {
  const tab = editor.activeTab
  return tab?.type === 'note' && tab.knowledgeBaseId === store.selectedKnowledgeBaseId
    ? tab.noteUuid
    : null
})
const tocFocusRequestId = computed(() => {
  const request = store.tocFocusRequest
  return request?.knowledgeBaseId === store.selectedKnowledgeBaseId &&
    request.noteUuid === selectedTocNoteUuid.value
    ? request.sequence
    : undefined
})

watch(
  tocFocusRequestId,
  (requestId) => {
    if (requestId && query.value) query.value = ''
  },
  { flush: 'sync' }
)

const statusSymbol: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: '!'
}

function showNoteMenu(noteUuid: string): void {
  if (!store.selectedKnowledgeBaseId) return
  void window.desk.ide.showNoteMenu(store.selectedKnowledgeBaseId, noteUuid)
}

function showFilePathMenu(path: string): void {
  if (!store.selectedKnowledgeBaseId) return
  void window.desk.ide.showFileMenu(store.selectedKnowledgeBaseId, path)
}

function toggleTocBatch(): void {
  tocListRef.value?.toggleAllCollapsed()
}

async function revealKnowledgeBase(): Promise<void> {
  if (!store.knowledgeBase) return
  const result = await window.desk.workspace.revealKnowledgeBase(store.knowledgeBase.id)
  if (!result.ok) store.error = result.error.message
}

function showKnowledgeBaseMenu(): void {
  if (store.knowledgeBase) void window.desk.ide.showKnowledgeBaseMenu(store.knowledgeBase.id)
}

async function togglePreview(): Promise<void> {
  if (!store.selectedKnowledgeBaseId || previewBusy.value) return
  previewBusy.value = true
  try {
    if (previewState.value?.status === 'ready' || previewState.value?.status === 'starting') {
      await editor.stopPreview(store.selectedKnowledgeBaseId)
    } else {
      const currentNote =
        store.document?.knowledgeBaseId === store.selectedKnowledgeBaseId
          ? store.document.dirName
          : undefined
      await editor.startPreview(store.selectedKnowledgeBaseId, currentNote)
    }
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    previewBusy.value = false
  }
}

const buildBusy = ref(false)

async function buildSite(): Promise<void> {
  if (!store.selectedKnowledgeBaseId || buildBusy.value) return
  buildBusy.value = true
  try {
    const result = await window.desk.build(store.selectedKnowledgeBaseId)
    if (!result.ok) {
      store.error = result.error.message
      return
    }
    store.status = `构建完成：${result.value.pageCount} 页 → ${result.value.outDir}`
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    buildBusy.value = false
  }
}

const previewLabel = computed(() => {
  if (previewBusy.value || previewState.value?.status === 'starting') return '正在启动站点预览'
  if (previewState.value?.status === 'ready') return '停止站点预览'
  if (previewState.value?.status === 'error') return '重新启动站点预览'
  return '启动站点预览'
})

const kbReady = computed(
  () => Boolean(store.knowledgeBase) && store.knowledgeBase?.health === 'ready'
)

function applyMenuAction(action: NavigatorSidebarMenuAction): void {
  if (action === 'create-note') emit('createNote')
  else if (action === 'create-group') emit('createGroup')
  else if (action === 'preview') void togglePreview()
  else if (action === 'build') void buildSite()
  else if (action === 'reveal') void revealKnowledgeBase()
  else if (action === 'settings') {
    if (store.knowledgeBase) editor.openKbSettings(store.knowledgeBase)
  } else if (action === 'assets') {
    if (store.knowledgeBase) editor.openKbAssets(store.knowledgeBase)
  } else showKnowledgeBaseMenu()
}

async function openHeaderMenu(): Promise<void> {
  if (menuBusy.value || !kbReady.value) return
  menuBusy.value = true
  try {
    const result = await window.desk.app.showNavigatorSidebarMenu({
      ready: kbReady.value,
      previewLabel: previewLabel.value,
      buildBusy: buildBusy.value
    })
    if (!result.ok) {
      store.error = result.error.message
      return
    }
    if (result.value) applyMenuAction(result.value)
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    menuBusy.value = false
  }
}
</script>

<template>
  <aside class="navigator-sidebar">
    <div class="navigator-top">
      <div class="search-wrap">
        <span>⌕</span>
        <input v-model="query" type="search" placeholder="搜索标题和正文" />
      </div>
      <div class="header-actions">
        <UiTooltip label="更多笔记操作">
          <button
            type="button"
            class="menu-button"
            aria-label="更多笔记操作"
            :disabled="!kbReady || menuBusy"
            @click="openHeaderMenu"
          >
            ⋯
          </button>
        </UiTooltip>
      </div>
    </div>

    <div
      v-if="previewBusy || previewState?.status === 'starting' || previewState?.status === 'error'"
      class="preview-feedback"
      :class="previewState?.status"
    >
      <span v-if="previewBusy || previewState?.status === 'starting'">
        正在启动 {{ store.selectedKnowledgeBase?.displayName }} 站点预览…
      </span>
      <template v-else>
        <span>预览启动失败：{{ previewState?.error ?? '未知错误' }}</span>
        <button type="button" @click="togglePreview">重试</button>
      </template>
    </div>

    <div
      v-if="store.knowledgeBase"
      class="navigator-body"
      :class="{ 'is-searching': Boolean(query.trim()) }"
    >
      <section class="changes-section">
        <div class="section-heading git-heading">
          <button
            type="button"
            class="section-toggle"
            :aria-expanded="changesExpanded"
            :aria-label="changesExpanded ? '折叠变更列表' : '展开变更列表'"
            @click="changesExpanded = !changesExpanded"
          >
            <svg
              class="chevron"
              :class="{ collapsed: !changesExpanded }"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <strong>变更</strong>
            <span v-if="gitState?.behind" class="behind-state">↓{{ gitState.behind }}</span>
          </button>
          <em>{{ gitState?.changes.length ?? 0 }}</em>
          <div class="git-actions">
            <UiTooltip label="刷新 Git 状态" align="end">
              <button
                type="button"
                aria-label="刷新本地 Git 状态"
                :disabled="Boolean(gitState?.busy)"
                @click="store.refreshGit(store.selectedKnowledgeBaseId ?? undefined)"
              >
                ↻
              </button>
            </UiTooltip>
            <UiTooltip label="拉取远端更新" align="end">
              <button
                type="button"
                aria-label="获取并拉取远端更新"
                :disabled="!gitState?.initialized || Boolean(gitState.busy)"
                @click="store.pullGit(store.selectedKnowledgeBaseId!)"
              >
                ⇣
              </button>
            </UiTooltip>
            <UiTooltip label="提交并推送" align="end">
              <button
                type="button"
                aria-label="提交并推送当前变更"
                :disabled="!gitState?.initialized || Boolean(gitState.busy)"
                @click="store.requestGitPublish(store.selectedKnowledgeBaseId!)"
              >
                ⇡
              </button>
            </UiTooltip>
          </div>
        </div>
        <template v-if="changesExpanded">
          <template v-if="noteFileChanges.length">
            <button
              type="button"
              class="change-group-toggle"
              :aria-expanded="noteFileExpanded"
              :aria-label="noteFileExpanded ? '折叠笔记文件' : '展开笔记文件'"
              @click="noteFileExpanded = !noteFileExpanded"
            >
              <svg
                class="chevron"
                :class="{ collapsed: !noteFileExpanded }"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M4 6l4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <strong>笔记文件</strong>
              <em>{{ noteFileChanges.length }}</em>
            </button>
            <div v-show="noteFileExpanded">
              <button
                v-for="change in displayNoteFileChanges"
                :key="`note-file:${change.status}:${change.path}`"
                type="button"
                class="change-item"
                :class="change.status"
                :disabled="!change.noteUuid"
                @click="store.openNoteByUuid(store.selectedKnowledgeBaseId!, change.noteUuid!)"
                @contextmenu.prevent="showNoteMenu(change.noteUuid!)"
              >
                <span class="change-item__label">
                  <strong v-if="change.noteUuid"
                    ><template v-if="tocShowIndex">{{ change.noteIndex }} </template
                    >{{ change.noteTitle }}</strong
                  >
                  <strong v-else>{{ change.path }}</strong>
                  <small v-if="change.noteUuid">{{
                    change.status === 'renamed' && change.previousPath
                      ? `${change.previousPath} → ${change.path}`
                      : change.path
                  }}</small>
                </span>
                <span class="change-item__status">{{ statusSymbol[change.status] }}</span>
              </button>
            </div>
          </template>

          <template v-if="configFileChanges.length">
            <button
              type="button"
              class="change-group-toggle"
              :aria-expanded="configFileExpanded"
              :aria-label="configFileExpanded ? '折叠笔记配置' : '展开笔记配置'"
              @click="configFileExpanded = !configFileExpanded"
            >
              <svg
                class="chevron"
                :class="{ collapsed: !configFileExpanded }"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M4 6l4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <strong>笔记配置</strong>
              <em>{{ configFileChanges.length }}</em>
            </button>
            <div v-show="configFileExpanded">
              <button
                v-for="change in displayConfigFileChanges"
                :key="`config:${change.status}:${change.path}`"
                type="button"
                class="change-item"
                :class="change.status"
                @contextmenu.prevent="showFilePathMenu(change.path)"
              >
                <span class="change-item__label">
                  <strong>{{ change.path }}</strong>
                </span>
                <span class="change-item__status">{{ statusSymbol[change.status] }}</span>
              </button>
            </div>
          </template>

          <template v-if="otherFileChanges.length">
            <button
              type="button"
              class="change-group-toggle"
              :aria-expanded="otherFileExpanded"
              :aria-label="otherFileExpanded ? '折叠其它文件' : '展开其它文件'"
              @click="otherFileExpanded = !otherFileExpanded"
            >
              <svg
                class="chevron"
                :class="{ collapsed: !otherFileExpanded }"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M4 6l4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <strong>其它文件</strong>
              <em>{{ otherFileChanges.length }}</em>
            </button>
            <div v-show="otherFileExpanded">
              <button
                v-for="change in displayOtherFileChanges"
                :key="`other:${change.status}:${change.path}`"
                type="button"
                class="change-item"
                :class="change.status"
                @contextmenu.prevent="showFilePathMenu(change.path)"
              >
                <span class="change-item__label">
                  <strong>{{ change.path }}</strong>
                </span>
                <span class="change-item__status">{{ statusSymbol[change.status] }}</span>
              </button>
            </div>
          </template>

          <div v-if="gitState?.busy" class="changes-empty">
            {{
              gitState.busy === 'publish'
                ? '正在提交并推送…'
                : gitState.busy === 'pull'
                  ? '正在拉取…'
                  : '正在获取远端状态…'
            }}
          </div>
          <div v-else-if="gitState?.error" class="changes-empty git-error">
            {{ gitState.error }}
          </div>
          <div v-else-if="!gitState?.initialized" class="changes-empty">当前目录不是 Git 仓库</div>
          <div v-else-if="!gitState.changes.length" class="changes-empty">工作区干净</div>
        </template>
      </section>

      <section v-if="store.knowledgeBase.health !== 'ready'" class="diagnostics">
        <strong>配置异常，当前知识库只读</strong>
        <ul>
          <li
            v-for="diagnostic in store.knowledgeBase.diagnostics"
            :key="`${diagnostic.code}:${diagnostic.path ?? ''}`"
          >
            {{ diagnostic.message }}
          </li>
        </ul>
        <div class="diagnostic-actions">
          <button type="button" @click="store.refreshWorkspace">重新检查</button>
          <button type="button" @click="revealKnowledgeBase">打开目录</button>
          <button type="button" @click="showKnowledgeBaseMenu">用 IDE 查看</button>
        </div>
      </section>

      <section v-if="query.trim()" class="search-results-section">
        <div class="section-heading static">
          <span>⌕</span>
          <strong>搜索结果</strong>
          <em>{{ store.searchResults.length }}</em>
        </div>
        <div v-if="store.searchLoading" class="changes-empty">正在查询后台索引…</div>
        <button
          v-for="result in store.searchResults"
          v-else
          :key="`${result.knowledgeBaseId}:${result.noteUuid}`"
          type="button"
          class="search-result"
          @click="store.openNoteByUuid(result.knowledgeBaseId, result.noteUuid)"
        >
          <span
            ><strong>{{ noteFileName(result) }}</strong></span
          >
          <small>{{ result.snippet }}</small>
        </button>
        <div v-if="!store.searchLoading && !store.searchResults.length" class="toc-empty">
          没有匹配标题或正文的笔记
        </div>
      </section>

      <section v-else class="toc-section">
        <div class="section-heading toc-heading">
          <button
            type="button"
            class="section-toggle"
            :aria-expanded="tocExpanded"
            :aria-label="tocExpanded ? '折叠目录' : '展开目录'"
            @click="tocExpanded = !tocExpanded"
          >
            <svg
              class="chevron"
              :class="{ collapsed: !tocExpanded }"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <strong>目录</strong>
          </button>
          <UiTooltip label="折叠/展开全部">
            <button
              type="button"
              class="toc-batch-toggle"
              aria-label="折叠/展开全部"
              @click="toggleTocBatch"
            >
              <svg class="toc-batch-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M2 4h20v2H2zm0 5.57L5.887 12L2 14.43zM7 11h15v2H7zm-5 7h20v2H2z"
                />
              </svg>
            </button>
          </UiTooltip>
          <UiTooltip label="手动刷新目录">
            <button
              type="button"
              class="toc-batch-toggle"
              :disabled="store.loading"
              aria-label="手动刷新目录"
              data-tooltip="手动刷新目录"
              @click="store.reloadKnowledgeBase"
            >
              <svg class="toc-batch-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M12 4a8 8 0 108 8h-2a6 6 0 11-6-6v3l5-4-5-4z" />
              </svg>
            </button>
          </UiTooltip>
          <em>{{ store.knowledgeBase.noteCount }}</em>
        </div>
        <div v-show="tocExpanded">
          <TocNodeList
            v-if="visibleToc.length"
            ref="tocListRef"
            :nodes="visibleToc"
            :selected-note-uuid="selectedTocNoteUuid"
            :focus-request-id="tocFocusRequestId"
            @select="store.selectNote"
            @select-permanent="store.selectNote($event, undefined, true)"
            @select-split="store.selectNote($event, 'right')"
            @toggle-done="store.toggleDone"
            @request-create="(node, placement) => emit('createNote', node, placement)"
            @request-rename="emit('requestRename', $event)"
            @request-delete="emit('requestDelete', $event)"
            @move="store.moveTocNode"
          />
          <div v-else class="toc-empty">{{ query ? '没有匹配项' : 'TOC.md 中没有条目' }}</div>
        </div>
      </section>
    </div>

    <div v-else class="column-empty">从左侧选择一个知识库</div>
  </aside>
</template>

<style scoped>
.navigator-sidebar {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.preview-feedback {
  min-height: 30px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  padding: 5px 10px;
  color: var(--muted);
  font-size: 9px;
}

.preview-feedback.error {
  background: var(--danger-soft);
  color: var(--danger);
}

.preview-feedback > span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  display: -webkit-box;
  overflow: hidden;
  line-height: 1.35;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.preview-feedback button {
  flex: none;
  border: 1px solid currentColor;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 3px 7px;
  font-size: 9px;
}

.navigator-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border);
}

.navigator-top .search-wrap {
  height: auto;
  flex: 1;
  min-width: 0;
  padding: 0;
  border-bottom: 0;
}

.header-actions {
  flex: none;
  position: relative;
  display: flex;
  gap: 6px;
}

.menu-button {
  height: 28px;
  width: 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--raised);
  color: var(--text);
  cursor: pointer;
  font-size: 18px;
  line-height: 20px;
}

.menu-button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.menu-button:disabled {
  opacity: 0.4;
}

.search-wrap {
  height: 43px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border);
}

.search-wrap > span {
  position: absolute;
  margin-left: 9px;
  color: var(--muted);
  pointer-events: none;
}

.search-wrap input {
  width: 100%;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: none;
  background: var(--input-bg);
  color: var(--text);
  padding: 0 9px 0 28px;
  font-size: 11px;
}

.search-wrap input:focus {
  border-color: var(--accent);
}

.navigator-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 7px;
}

/*
 * 第二列头部固定：滚动目录树时「变更」与「目录」栏始终可见可操作。
 * 搜索栏（.navigator-top）本就在滚动容器之外，天然固定。
 *
 * `display: contents` 的关键作用：sticky 元素无法超出其父容器，而
 * `.changes-section` / `.toc-section` 在折叠时只有标题那么高，标题会跟着
 * 父容器一起滚走。让 section 不生成盒子，标题就按滚动容器的直接子级参与布局。
 */
.changes-section,
.toc-section {
  display: contents;
}

.git-heading,
.toc-heading {
  position: sticky;
  top: 0;
  z-index: 3;
  /* 吸顶时必须不透明：容器有 7px padding，否则内容会从边缘透出 */
  background: var(--panel);
  box-shadow: 0 1px 0 var(--border);
}

/* 目录栏吸在变更栏下方（正常态两栏同时吸顶） */
.toc-heading {
  top: 27px;
}

/* 搜索态没有「变更」栏，目录栏回到顶部 */
.navigator-body.is-searching .toc-heading {
  top: 0;
}

.section-heading {
  width: 100%;
  height: 27px;
  display: flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 0 5px;
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.section-heading strong {
  flex: 1;
  font-weight: 700;
}

.section-heading em {
  min-width: 18px;
  border-radius: 9px;
  background: var(--raised);
  padding: 1px 5px;
  text-align: center;
  font-style: normal;
  font-size: 9px;
}

.changes-empty,
.toc-empty {
  color: var(--muted);
  padding: 3px 25px 9px;
  font-size: 10px;
}

.git-heading {
  text-transform: none;
  letter-spacing: 0;
}

.git-actions button {
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.section-toggle {
  align-self: stretch;
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}

.chevron {
  flex: none;
  width: 18px;
  height: 12px;
  transition: transform 120ms ease;
}

.chevron.collapsed {
  transform: rotate(-90deg);
}

.toc-batch-toggle {
  flex: none;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}

.toc-batch-toggle:hover {
  background: var(--hover);
  color: var(--text);
}

.toc-batch-toggle:focus-visible {
  outline: 2px solid var(--accent-strong);
  outline-offset: 1px;
}

.toc-batch-icon {
  width: 14px;
  height: 14px;
}

button.section-heading {
  font-family: inherit;
  appearance: none;
  cursor: pointer;
}

.git-actions {
  display: flex;
  gap: 1px;
  margin-left: 3px;
}

.git-actions button {
  width: 21px;
  height: 21px;
  padding: 0;
  font-size: 11px;
}

.git-actions button:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.git-actions button:disabled {
  opacity: 0.35;
}

.behind-state {
  color: var(--warning);
  font-size: 9px;
  font-weight: 700;
}

.change-group-toggle {
  align-self: stretch;
  width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px 3px 22px;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-align: left;
}

.change-group-toggle:hover {
  color: var(--text);
}

.change-group-toggle strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-group-toggle em {
  min-width: 18px;
  border-radius: 9px;
  background: var(--raised);
  padding: 1px 5px;
  text-align: center;
  font-style: normal;
  font-size: 9px;
}

.change-item {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  padding: 5px 7px 5px 45px;
  text-align: left;
}

.change-item:not(:disabled) {
  cursor: pointer;
}

.change-item:not(:disabled):hover {
  background: var(--hover);
}

.change-item__label {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.change-item__status {
  flex: none;
  min-width: 18px;
  padding: 1px 5px;
  color: var(--warning);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 750;
  text-align: center;
}

.change-item.conflicted > .change-item__status {
  color: var(--danger);
}

.change-item__label strong,
.change-item__label small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-item__label strong {
  font-size: 10px;
  font-weight: 560;
}

.change-item__label small {
  color: var(--muted);
  font-size: 8px;
}

.git-error {
  color: var(--danger);
}

.toc-section {
  margin-top: 4px;
}

.search-results-section {
  margin-top: 4px;
}

.search-result {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  padding: 7px 8px;
  text-align: left;
  cursor: pointer;
}

.search-result:hover {
  background: var(--hover);
}

.search-result > span {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.search-result em {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 9px;
  font-style: normal;
}

.search-result strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 630;
}

.search-result small {
  display: -webkit-box;
  overflow: hidden;
  color: var(--muted);
  font-size: 9px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.diagnostics {
  margin: 7px 4px;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  border-radius: 7px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 10px;
}

.diagnostics strong {
  font-size: 11px;
}

.diagnostics ul {
  margin: 6px 0 0;
  padding-left: 15px;
}

.diagnostic-actions {
  display: flex;
  gap: 5px;
  margin-top: 8px;
}

.diagnostic-actions button {
  height: 25px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
  border-radius: 5px;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
  padding: 0 7px;
  font-size: 9px;
}

.column-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 11px;
}
</style>
