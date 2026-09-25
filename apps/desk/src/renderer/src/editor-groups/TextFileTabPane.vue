<script setup lang="ts">
/**
 * 知识库文本文件（只读）。
 *
 * 用 CodeMirror 查看，不走笔记的实时预览。读失败时显示主进程给出的原因。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'

import KbPathBreadcrumb from './KbPathBreadcrumb.vue'

import type { KbTextFileDto, TextFileEditorTab as TextFileTab } from '../../../shared/contracts'

const props = defineProps<{ tab: TextFileTab; active: boolean; groupId: string }>()

const hostRef = ref<HTMLDivElement | null>(null)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
const file = ref<KbTextFileDto | null>(null)
const editor = shallowRef<EditorView | null>(null)
const languageCompartment = new Compartment()

const kindLabel = (relPath: string): string => {
  if (relPath.endsWith('.md') || relPath.endsWith('.markdown')) return 'Markdown'
  const name = relPath.split('/').pop() ?? relPath
  const ext = name.includes('.') ? name.split('.').pop() : ''
  return ext ? ext.toUpperCase() : '文本'
}

function destroyEditor(): void {
  editor.value?.destroy()
  editor.value = null
}

function mountEditor(content: string, language: string): void {
  const host = hostRef.value
  if (!host) return
  destroyEditor()
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: content,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        lineNumbers(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        languageCompartment.of([]),
        EditorView.theme({
          '&': {
            height: '100%',
            backgroundColor: 'var(--editor-bg)',
            color: 'var(--text)'
          },
          '.cm-scroller': {
            overflow: 'auto',
            fontFamily: 'var(--tn-font-mono, ui-monospace, monospace)',
            fontSize: '13px',
            lineHeight: '1.55'
          },
          '.cm-gutters': {
            backgroundColor: 'var(--editor-bg)',
            color: 'var(--muted)',
            borderRight: '1px solid var(--border)'
          },
          '.cm-content': { padding: '8px 0 24px' }
        })
      ]
    })
  })
  editor.value = view
  const match = LanguageDescription.matchLanguageName(languages, language, true)
  if (!match) return
  void match.load().then((support) => {
    if (editor.value !== view) return
    view.dispatch({ effects: languageCompartment.reconfigure(support) })
  })
}

async function load(): Promise<void> {
  phase.value = 'loading'
  message.value = ''
  file.value = null
  destroyEditor()
  const result = await window.desk.kbFiles.read({
    knowledgeBaseId: props.tab.knowledgeBaseId,
    relPath: props.tab.relPath
  })
  if (!result.ok) {
    phase.value = 'error'
    message.value = result.error.message
    return
  }
  file.value = result.value
  phase.value = 'ready'
  mountEditor(result.value.content, result.value.language)
}

onMounted(() => {
  void load()
})

watch(
  () => props.tab.relPath,
  () => {
    void load()
  }
)

onBeforeUnmount(() => {
  destroyEditor()
})
</script>

<template>
  <section class="text-file-pane">
    <header class="pane-header">
      <div class="path">
        <KbPathBreadcrumb
          :knowledge-base-id="tab.knowledgeBaseId"
          :rel-path="tab.relPath"
          :fallback-name="tab.knowledgeBaseName"
        />
      </div>
      <div class="head-meta">
        <span class="kind">{{ kindLabel(tab.relPath) }}</span>
        <span v-if="file" class="bytes">{{ file.bytes }} B</span>
        <span class="readonly" title="当前只支持查看">只读</span>
      </div>
    </header>
    <p v-if="phase === 'loading'" class="pane-note">正在读取…</p>
    <p v-else-if="phase === 'error'" class="pane-note is-error" role="alert">{{ message }}</p>
    <p v-else-if="file && !file.writable" class="pane-note is-hint">
      {{ file.writableReason }}
    </p>
    <div ref="hostRef" class="pane-editor" :data-state="phase" />
  </section>
</template>

<style scoped>
.text-file-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--editor-bg);
  color: var(--text);
}
.pane-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  font: 12px/1.6 var(--font-sans);
  flex: none;
}
.path {
  flex: 1 1 0;
  min-width: 0;
  color: var(--muted);
}
.head-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex: none;
  color: var(--muted);
}
.kind {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
}
.readonly {
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--hover);
}
.pane-note {
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font: 12px/1.6 var(--font-sans);
  color: var(--muted);
  flex: none;
}
.pane-note.is-error {
  color: var(--danger, #e5484d);
}
.pane-editor {
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.pane-editor :deep(.cm-editor) {
  height: 100%;
}
</style>
