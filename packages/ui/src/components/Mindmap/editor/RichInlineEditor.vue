<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  parseInlineSegments,
  nextGraphemeOffset,
  previousGraphemeOffset,
  replaceInlineDisplayText,
  replaceInlineRange,
  richSelectionOffsets,
  setRichSelection,
  stripInline
} from '@tnotesjs/mindmap-core'
import type { InlineLink, RichInlineEditorElement } from '@tnotesjs/mindmap-core'

const props = withDefaults(
  defineProps<{
    editorId: string
    raw: string
    active: boolean
    done?: boolean
    placeholder?: string
    pasteMode?: 'single-line' | 'outline'
  }>(),
  {
    done: false,
    placeholder: '',
    pasteMode: 'single-line'
  }
)

interface DraftPayload {
  raw: string
  text: string
}

const emit = defineEmits<{
  draftChange: [payload: DraftPayload]
  commit: [payload: DraftPayload]
  pasteImage: [blob: Blob]
  pasteMultiline: [text: string]
  linkEnter: [link: InlineLink, event: MouseEvent]
  linkLeave: []
  linkClick: [link: InlineLink, event: Event]
}>()

const rootRef = ref<RichInlineEditorElement>()
const draftRaw = ref(props.raw)
let sourceRaw = props.raw
let dirty = false
let composing = false
let compositionBaseRaw = props.raw

const text = computed(() => stripInline(draftRaw.value))

function renderInlineDom() {
  const root = rootRef.value
  if (!root) return
  const fragment = document.createDocumentFragment()
  let plainOffset = 0
  for (const segment of parseInlineSegments(draftRaw.value)) {
    const run = document.createElement('span')
    run.className = 'inline-run'
    for (const format of ['bold', 'italic', 'underline', 'strike', 'highlight', 'code'] as const) {
      if (segment.marks[format]) run.classList.add(format)
    }
    if (segment.link) {
      run.classList.add('link')
      run.dataset.linkUrl = segment.link.url
      run.dataset.linkRawStart = String(segment.link.rawStart)
      run.dataset.linkRawEnd = String(segment.link.rawEnd)
      if (!props.active) {
        run.setAttribute('role', 'link')
        run.tabIndex = 0
      }
      run.addEventListener('mouseenter', (event) => {
        if (!props.active) emit('linkEnter', segment.link!, event)
      })
      run.addEventListener('mouseleave', () => {
        if (!props.active) emit('linkLeave')
      })
    }
    run.dataset.plainStart = String(plainOffset)
    plainOffset += segment.text.length
    run.dataset.plainEnd = String(plainOffset)
    run.textContent = segment.text
    fragment.append(run)
  }
  root.replaceChildren(fragment)
}

function payload(): DraftPayload {
  return { raw: draftRaw.value, text: stripInline(draftRaw.value) }
}

function renderDraft(
  nextRaw: string,
  selection?: { start: number; end?: number; direction?: 'forward' | 'backward' }
) {
  draftRaw.value = nextRaw
  dirty = nextRaw !== sourceRaw
  renderInlineDom()
  emit('draftChange', payload())
  if (selection) {
    nextTick(() => {
      const root = rootRef.value
      if (!root || !props.active) return
      root.focus()
      setRichSelection(root, selection.start, selection.end ?? selection.start, selection.direction)
    })
  }
}

function replaceSelection(textToInsert: string) {
  const root = rootRef.value
  if (!root) return
  const selection = richSelectionOffsets(root) ?? {
    start: text.value.length,
    end: text.value.length,
    anchor: text.value.length,
    focus: text.value.length,
    direction: 'forward' as const
  }
  const nextRaw = replaceInlineRange(draftRaw.value, selection.start, selection.end, textToInsert)
  const caret = selection.start + textToInsert.length
  renderDraft(nextRaw, { start: caret })
}

function emitCommit() {
  if (!dirty) return
  const current = payload()
  dirty = false
  sourceRaw = current.raw
  emit('commit', current)
}

function onBeforeInput(event: InputEvent) {
  if (composing || event.isComposing) return
  const root = rootRef.value
  if (!root) return
  const selection = richSelectionOffsets(root) ?? {
    start: text.value.length,
    end: text.value.length,
    anchor: text.value.length,
    focus: text.value.length,
    direction: 'forward' as const
  }

  if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
    if (event.data == null) return
    event.preventDefault()
    const nextRaw = replaceInlineRange(draftRaw.value, selection.start, selection.end, event.data)
    renderDraft(nextRaw, { start: selection.start + event.data.length })
    return
  }

  if (event.inputType === 'deleteContentBackward') {
    event.preventDefault()
    const start =
      selection.start === selection.end
        ? previousGraphemeOffset(text.value, selection.start)
        : selection.start
    renderDraft(replaceInlineRange(draftRaw.value, start, selection.end, ''), { start })
    return
  }

  if (event.inputType === 'deleteContentForward') {
    event.preventDefault()
    const end =
      selection.start === selection.end
        ? nextGraphemeOffset(text.value, selection.end)
        : selection.end
    renderDraft(replaceInlineRange(draftRaw.value, selection.start, end, ''), {
      start: selection.start
    })
    return
  }

  if (event.inputType === 'deleteByCut') {
    event.preventDefault()
    renderDraft(replaceInlineRange(draftRaw.value, selection.start, selection.end, ''), {
      start: selection.start
    })
    return
  }

  if (
    event.inputType === 'insertParagraph' ||
    event.inputType === 'insertLineBreak' ||
    event.inputType === 'historyUndo' ||
    event.inputType === 'historyRedo'
  ) {
    event.preventDefault()
  }
}

/** 浏览器拼写替换等未被 beforeinput 精确接管的输入，回退为纯文本最小差异。 */
function onInput(event: InputEvent) {
  if (composing || event.isComposing) return
  const root = rootRef.value
  if (!root) return
  const nextText = (root.textContent ?? '').replace(/[\r\n]/g, '')
  if (nextText === text.value) return
  const selection = richSelectionOffsets(root)
  renderDraft(replaceInlineDisplayText(draftRaw.value, nextText), selection ?? undefined)
}

function onCompositionStart() {
  composing = true
  compositionBaseRaw = draftRaw.value
}

function finishComposition() {
  if (!composing) return
  const root = rootRef.value
  if (!root) return
  const nextText = (root.textContent ?? '').replace(/[\r\n]/g, '')
  const selection = richSelectionOffsets(root)
  composing = false
  renderDraft(replaceInlineDisplayText(compositionBaseRaw, nextText), selection ?? undefined)
}

function onCompositionEnd() {
  finishComposition()
}

function onPaste(event: ClipboardEvent) {
  event.preventDefault()
  const image = [...(event.clipboardData?.items ?? [])]
    .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    ?.getAsFile()
  if (image) {
    emitCommit()
    emit('pasteImage', image)
    return
  }
  const plain = event.clipboardData?.getData('text/plain') ?? ''
  if (props.pasteMode === 'outline' && /\r?\n/.test(plain)) {
    emitCommit()
    emit('pasteMultiline', plain)
    return
  }
  replaceSelection(plain.replace(/\r?\n/g, ' '))
}

function onBlur() {
  finishComposition()
  emitCommit()
}

function onLinkClick(link: InlineLink, event: Event) {
  if (props.active) return
  emit('linkClick', link, event)
}

function linkFromTarget(
  target: EventTarget | null
): { element: HTMLElement; link: InlineLink } | null {
  const element =
    target instanceof HTMLElement ? target.closest<HTMLElement>('.inline-run.link') : null
  const root = rootRef.value
  if (!element || !root?.contains(element) || !element.dataset.linkUrl) return null
  return {
    element,
    link: {
      url: element.dataset.linkUrl,
      rawStart: Number(element.dataset.linkRawStart ?? 0),
      rawEnd: Number(element.dataset.linkRawEnd ?? 0)
    }
  }
}

function onMouseOver(event: MouseEvent) {
  if (props.active) return
  const found = linkFromTarget(event.target)
  if (
    !found ||
    (event.relatedTarget instanceof Node && found.element.contains(event.relatedTarget))
  )
    return
  emit('linkEnter', found.link, event)
}

function onMouseOut(event: MouseEvent) {
  if (props.active) return
  const found = linkFromTarget(event.target)
  if (
    !found ||
    (event.relatedTarget instanceof Node && found.element.contains(event.relatedTarget))
  )
    return
  emit('linkLeave')
}

function onClick(event: MouseEvent) {
  const found = linkFromTarget(event.target)
  if (found) onLinkClick(found.link, event)
}

function onRootKeydown(event: KeyboardEvent) {
  if (props.active || event.key !== 'Enter') return
  const found = linkFromTarget(event.target)
  if (!found) return
  event.preventDefault()
  emit('linkClick', found.link, event)
}

function installCompatibilityApi(root: RichInlineEditorElement) {
  Object.defineProperties(root, {
    value: {
      configurable: true,
      get: () => stripInline(draftRaw.value),
      set: (next: string) => {
        renderDraft(replaceInlineDisplayText(draftRaw.value, String(next)))
      }
    },
    rawValue: { configurable: true, get: () => draftRaw.value },
    selectionStart: { configurable: true, get: () => richSelectionOffsets(root)?.start ?? 0 },
    selectionEnd: { configurable: true, get: () => richSelectionOffsets(root)?.end ?? 0 },
    isDirty: { configurable: true, get: () => dirty },
    isComposing: { configurable: true, get: () => composing }
  })
  root.setSelectionRange = (start: number, end: number) => setRichSelection(root, start, end)
  root.markCommitted = () => {
    dirty = false
    sourceRaw = draftRaw.value
  }
}

onMounted(() => {
  if (rootRef.value) {
    installCompatibilityApi(rootRef.value)
    renderInlineDom()
  }
})

watch(
  () => props.raw,
  (raw) => {
    sourceRaw = raw
    dirty = false
    if (composing) return
    if (draftRaw.value !== raw) {
      draftRaw.value = raw
      renderInlineDom()
    }
  }
)

watch(
  () => props.active,
  (active) => {
    if (!active) emitCommit()
    if (!composing && !dirty) renderInlineDom()
  }
)

onBeforeUnmount(emitCommit)
</script>

<template>
  <div
    ref="rootRef"
    class="rich-inline-editor"
    :class="{ active, done }"
    :contenteditable="active ? 'true' : 'false'"
    :data-id="editorId"
    :data-empty="text.length === 0 ? 'true' : undefined"
    :data-placeholder="placeholder"
    :tabindex="active ? 0 : -1"
    role="textbox"
    aria-multiline="false"
    spellcheck="false"
    @beforeinput="onBeforeInput"
    @input="onInput"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
    @paste="onPaste"
    @blur="onBlur"
    @mouseover="onMouseOver"
    @mouseout="onMouseOut"
    @click="onClick"
    @keydown="onRootKeydown"
  />
</template>

<style scoped>
.rich-inline-editor {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  caret-color: var(--mm-accent, var(--mm-text, #3b82f6));
}
.rich-inline-editor[data-empty='true']::before {
  content: attr(data-placeholder);
  color: var(--mm-text-dim);
  pointer-events: none;
}
.rich-inline-editor.active {
  cursor: text;
}
.rich-inline-editor :deep(.inline-run.bold) {
  font-weight: 700;
}
.rich-inline-editor :deep(.inline-run.italic) {
  font-style: italic;
}
.rich-inline-editor :deep(.inline-run.underline) {
  text-decoration-line: underline;
  text-underline-offset: 3px;
}
.rich-inline-editor :deep(.inline-run.strike) {
  text-decoration-line: line-through;
}
.rich-inline-editor :deep(.inline-run.underline.strike) {
  text-decoration-line: underline line-through;
}
.rich-inline-editor :deep(.inline-run.highlight:not(.code)) {
  padding: 0 1px;
  border-radius: 2px;
  background: var(--tn-c-mark-bg, rgba(255, 221, 0, 0.45));
}
.rich-inline-editor :deep(.inline-run.code) {
  padding: 0 4px;
  border: 1px solid var(--tn-c-inline-code-border, #e7e9e8);
  border-radius: 4px;
  background: var(--tn-c-inline-code-bg, rgba(0, 0, 0, 0.06));
  color: inherit;
  font-family: var(--tn-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 1em;
  font-weight: 400;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.rich-inline-editor :deep(.inline-run.link) {
  color: var(--mm-accent);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.rich-inline-editor.done {
  color: var(--mm-text-dim);
  text-decoration: line-through;
}
</style>
