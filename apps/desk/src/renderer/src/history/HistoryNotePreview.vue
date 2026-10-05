<script setup lang="ts">
/**
 * 历史版本只读预览（计划 H2）。
 *
 * - 数据全部来自 `window.desk.history`（受限 IPC）+ `tnotes-asset://history` 协议
 * - 渲染走 `historyMarkdown`（DOMPurify 白名单，不执行历史文件里的脚本）
 * - 画布/Mermaid 挂载共享只读组件，按可见性懒加载；组件本身没有任何写回能力
 * - 切版本时取消在途请求、丢弃过时结果；卸载时释放缓存与已挂载组件
 */
import { createApp, h, nextTick, onBeforeUnmount, ref, watch, type App } from 'vue'
import { ExcalidrawSvg } from '@tnotesjs/ui/excalidraw-view'
import Mermaid from '@tnotesjs/ui/mermaid'

import { DESK_MERMAID_SECURITY_LEVEL } from '../editor/markdown/mermaidSecurity'
import { renderHistoryMarkdown, type HistoryDiagnostic, type HistoryMount } from './historyMarkdown'
import { createHistoryPreviewSession } from './historyPreviewSession'

const props = defineProps<{
  knowledgeBaseId: string
  noteIndex: string
  commit: string
  noteUuid?: string
}>()

const emit = defineEmits<{ 'body-kind': [kind: 'unknown' | 'text' | 'binary'] }>()

const loading = ref(false)
const error = ref('')
const noteRelPath = ref('')
const noteOid = ref('')
const html = ref('')
const diagnostics = ref<HistoryDiagnostic[]>([])
const mounts = ref<HistoryMount[]>([])

const body = ref<HTMLElement | null>(null)
const session = createHistoryPreviewSession()
let mountedApps: App[] = []
let observers: IntersectionObserver[] = []
let renderGeneration = 0

function clearMounts(): void {
  for (const observer of observers) observer.disconnect()
  observers = []
  for (const app of mountedApps) app.unmount()
  mountedApps = []
}

function mountInto(element: HTMLElement, setup: () => App): void {
  const app = setup()
  app.mount(element)
  mountedApps.push(app)
}

function mountExcalidraw(element: HTMLElement, mount: HistoryMount): void {
  if (mount.missingReason || !mount.url) return
  element.setAttribute('data-state', 'loading')
  element.textContent = '正在读取该版本画布…'
  void session
    .readAssetText(
      { knowledgeBaseId: props.knowledgeBaseId, commit: props.commit, noteIndex: props.noteIndex },
      mount.relPath,
      mount.oid
    )
    .then((content) => {
      element.textContent = ''
      element.setAttribute('data-state', 'ready')
      mountInto(element, () =>
        createApp({
          render: () => h(ExcalidrawSvg, { content, height: mount.height, label: '历史画布' })
        })
      )
    })
    .catch((cause: unknown) => {
      element.setAttribute('data-state', 'error')
      element.textContent = `历史画布读取失败：${
        cause instanceof Error ? cause.message : String(cause)
      }`
    })
}

function mountMermaidBlock(element: HTMLElement, mount: HistoryMount): void {
  if (!mount.text) return
  mountInto(element, () =>
    createApp({
      render: () =>
        h(Mermaid, {
          source: mount.text,
          securityLevel: DESK_MERMAID_SECURITY_LEVEL,
          enableCopy: false,
          enableFullscreen: false
        })
    })
  )
}

function mountPlaceholders(): void {
  const host = body.value
  if (!host) return
  const byId = new Map(mounts.value.map((mount) => [mount.id, mount]))
  host.querySelectorAll<HTMLElement>('[data-tn-history-mount]').forEach((element) => {
    const id = Number(element.getAttribute('data-tn-history-mount'))
    const mount = byId.get(id)
    if (!mount) return
    const isCanvas = element.hasAttribute('data-tn-history-canvas')
    const defer = (): void => {
      if (isCanvas) mountExcalidraw(element, mount)
      else mountMermaidBlock(element, mount)
    }
    // 大资源按需加载：进入视口附近才读取/渲染
    if (typeof IntersectionObserver !== 'function') {
      defer()
      return
    }
    let done = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (done || !entries.some((entry) => entry.isIntersecting)) return
        done = true
        observer.disconnect()
        defer()
      },
      { root: null, rootMargin: '240px 0px', threshold: 0 }
    )
    observer.observe(element)
    observers.push(observer)
  })
}

async function load(): Promise<void> {
  const generation = (renderGeneration += 1)
  clearMounts()
  loading.value = true
  error.value = ''
  html.value = ''
  diagnostics.value = []
  mounts.value = []
  emit('body-kind', 'unknown')
  try {
    const loaded = await session.loadNote({
      knowledgeBaseId: props.knowledgeBaseId,
      commit: props.commit,
      noteIndex: props.noteIndex,
      noteUuid: props.noteUuid
    })
    if (generation !== renderGeneration) return
    if (loaded.kind === 'stale') return
    if (loaded.kind === 'error') {
      error.value = loaded.message
      emit('body-kind', 'unknown')
      return
    }
    if (!loaded.note.text) {
      error.value = '该版本正文不是文本文件，无法预览'
      emit('body-kind', 'binary')
      return
    }
    emit('body-kind', 'text')
    const rendered = renderHistoryMarkdown(loaded.note.text, loaded.context)
    if (generation !== renderGeneration) return
    noteRelPath.value = loaded.note.relPath
    noteOid.value = loaded.note.oid
    html.value = rendered.html
    diagnostics.value = rendered.diagnostics
    mounts.value = rendered.mounts
    // 等 v-html 落进 DOM 后再挂载组件；html 已过 DOMPurify 白名单
    await nextTick()
    if (generation === renderGeneration) mountPlaceholders()
  } finally {
    if (generation === renderGeneration) loading.value = false
  }
}

watch(
  () => [props.knowledgeBaseId, props.noteIndex, props.commit, props.noteUuid] as const,
  () => void load(),
  { immediate: true }
)

onBeforeUnmount(() => {
  renderGeneration += 1
  clearMounts()
  session.dispose()
})
</script>

<template>
  <section class="history-preview" data-history-preview>
    <header class="history-preview__header">
      <p class="history-preview__title">
        历史版本
        <code data-history-commit>{{ commit.slice(0, 7) }}</code>
      </p>
      <p v-if="noteRelPath" class="history-preview__path" data-history-path>{{ noteRelPath }}</p>
      <p class="history-preview__hint">只读预览：不会写回文件，也不执行历史版本里的脚本。</p>
    </header>

    <p v-if="loading" class="history-preview__status" data-history-loading>正在读取该版本…</p>
    <p v-else-if="error" class="history-preview__status is-error" data-history-error>
      {{ error }}
    </p>

    <ul v-if="diagnostics.length" class="history-preview__diagnostics" data-history-diagnostics>
      <li v-for="(item, index) in diagnostics" :key="index">{{ item.message }}</li>
    </ul>

    <article
      v-show="!error"
      ref="body"
      class="history-preview__body"
      data-history-body
      v-html="html"
    />
  </section>
</template>

<style scoped>
.history-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow: auto;
  padding: 16px 20px 40px;
}

.history-preview__header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--tn-border, #e5e7eb);
}

.history-preview__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.history-preview__path,
.history-preview__hint {
  margin: 0;
  color: var(--tn-text-muted, #6b7280);
  font-size: 12px;
}

.history-preview__status {
  margin: 0;
  color: var(--tn-text-muted, #6b7280);
  font-size: 13px;
}

.history-preview__status.is-error {
  color: var(--tn-danger, #dc2626);
}

.history-preview__diagnostics {
  margin: 0;
  padding: 8px 12px 8px 28px;
  border-radius: 6px;
  background: var(--tn-surface-muted, #f3f4f6);
  color: var(--tn-text-muted, #6b7280);
  font-size: 12px;
}

.history-preview__body {
  max-width: 860px;
}

.history-preview__body :deep(img[data-tn-history-skip]) {
  display: none;
}

.history-preview__body :deep([data-tn-history-unsupported]) {
  border: 1px dashed var(--tn-border, #e5e7eb);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--tn-text-muted, #6b7280);
  font-size: 12px;
}
</style>
