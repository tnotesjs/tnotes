import { createApp, h, reactive, type App } from 'vue'
import {
  BilibiliVideo,
  Mermaid,
  Mindmap,
  NotesTable,
  Footprints,
  WordList,
  WORD_LIST_FEATURES_STATIC
} from '@tnotesjs/ui'
import type { NotesTableRow, FootprintsPayload } from '@tnotesjs/ui'

export interface BilibiliVideoPreviewProps {
  id: string
  autoplay?: boolean
  muted?: boolean
}

export interface WordListPreviewProps {
  words: string[]
  needSort?: boolean
}

export interface MermaidPreviewProps {
  source: string
  center?: boolean
  /** Fired when the user toggles center; host decides whether to persist. */
  onCenterChange?: (center: boolean) => void
}

export interface MountedVuePreview<TProps> {
  unmount: () => void
  update: (props: TProps) => void
}

function normalizeBilibili(props: BilibiliVideoPreviewProps): Required<BilibiliVideoPreviewProps> {
  return {
    id: props.id ?? '',
    autoplay: Boolean(props.autoplay),
    muted: Boolean(props.muted)
  }
}

function normalizeWordList(props: WordListPreviewProps): Required<WordListPreviewProps> {
  return {
    words: Array.isArray(props.words) ? [...props.words] : [],
    needSort: Boolean(props.needSort)
  }
}

function mountVuePreview<TProps extends Record<string, unknown>>(
  host: HTMLElement,
  rootClass: string,
  Component: unknown,
  props: TProps,
  equal: (a: TProps, b: TProps) => boolean
): MountedVuePreview<TProps> {
  host.replaceChildren()
  const root = document.createElement('div')
  root.className = rootClass
  host.append(root)

  let current = { ...props }
  let app: App | null = createApp(Component as never, { ...current })
  app.mount(root)

  return {
    update: (nextProps) => {
      if (equal(current, nextProps)) return
      current = { ...nextProps }
      app?.unmount()
      app = createApp(Component as never, { ...current })
      app.mount(root)
    },
    unmount: () => {
      app?.unmount()
      app = null
      host.replaceChildren()
    }
  }
}

/** Mounts BilibiliVideo into a host element; returns an updater/unmount handle. */
export function mountBilibiliVideoPreview(
  host: HTMLElement,
  props: BilibiliVideoPreviewProps
): MountedVuePreview<BilibiliVideoPreviewProps> {
  const initial = normalizeBilibili(props)
  const handle = mountVuePreview(
    host,
    'desk-bilibili-video-root',
    BilibiliVideo,
    initial,
    (a, b) => {
      const na = normalizeBilibili(a)
      const nb = normalizeBilibili(b)
      return na.id === nb.id && na.autoplay === nb.autoplay && na.muted === nb.muted
    }
  )
  return {
    update: (next) => handle.update(normalizeBilibili(next)),
    unmount: handle.unmount
  }
}

/** Mounts WordList with the static (preview-safe) feature preset. */
export function mountWordListPreview(
  host: HTMLElement,
  props: WordListPreviewProps
): MountedVuePreview<WordListPreviewProps> {
  const initial = normalizeWordList(props)
  const withFeatures = {
    ...initial,
    features: WORD_LIST_FEATURES_STATIC
  }
  const handle = mountVuePreview(host, 'desk-word-list-root', WordList, withFeatures, (a, b) => {
    const na = normalizeWordList(a as WordListPreviewProps)
    const nb = normalizeWordList(b as WordListPreviewProps)
    return (
      na.needSort === nb.needSort &&
      na.words.length === nb.words.length &&
      na.words.every((w, i) => w === nb.words[i])
    )
  })
  return {
    update: (next) =>
      handle.update({
        ...normalizeWordList(next),
        features: WORD_LIST_FEATURES_STATIC
      }),
    unmount: handle.unmount
  }
}

/** Mounts shared Mermaid preview (strict security for Desk).
 * Uses a render-fn + reactive props so `centerChange` / `update:center`
 * listeners stay wired (createApp(Component, { onCenterChange }) was a no-op
 * for write-back) and source updates do not remount the tree.
 */
export function mountMermaidPreview(
  host: HTMLElement,
  props: MermaidPreviewProps
): MountedVuePreview<MermaidPreviewProps> {
  host.replaceChildren()
  const root = document.createElement('div')
  root.className = 'desk-mermaid-root'
  host.append(root)

  const state = reactive({
    source: props.source ?? '',
    center: Boolean(props.center),
    onCenterChange: props.onCenterChange as ((center: boolean) => void) | undefined
  })

  const emitCenter = (center: boolean): void => {
    state.center = center
    state.onCenterChange?.(center)
  }

  let app: App | null = createApp({
    setup() {
      return () =>
        h(Mermaid, {
          source: state.source,
          center: state.center,
          onCenterChange: emitCenter,
          'onUpdate:center': emitCenter
        })
    }
  })
  app.mount(root)

  return {
    update: (next) => {
      state.source = next.source ?? ''
      state.center = Boolean(next.center)
      if (next.onCenterChange) state.onCenterChange = next.onCenterChange
    },
    unmount: () => {
      app?.unmount()
      app = null
      host.replaceChildren()
    }
  }
}

export interface MindmapPreviewProps {
  source: string
  initialExpandLevel?: number
  height?: number
  editable?: boolean
  expandLevelControl?: boolean
  onMarkdownChange?: (markdown: string) => void
  onExpandLevelChange?: (level: number) => void
  resolveImageSrc?: (src: string) => string
  writeAsset?: (blob: Blob) => Promise<{ relativePath: string; alt?: string }>
}

export function mountMindmapPreview(
  host: HTMLElement,
  props: MindmapPreviewProps
): MountedVuePreview<MindmapPreviewProps> {
  host.replaceChildren()
  const root = document.createElement('div')
  root.className = 'desk-mindmap-root'
  host.append(root)

  const state = reactive({
    source: props.source ?? '',
    initialExpandLevel: props.initialExpandLevel ?? 3,
    height: props.height,
    editable: Boolean(props.editable),
    expandLevelControl: Boolean(props.expandLevelControl),
    onMarkdownChange: props.onMarkdownChange,
    onExpandLevelChange: props.onExpandLevelChange,
    resolveImageSrc: props.resolveImageSrc,
    writeAsset: props.writeAsset
  })

  let app: App | null = createApp({
    setup() {
      return () =>
        h(Mindmap, {
          source: state.source,
          initialExpandLevel: state.initialExpandLevel,
          height: state.height,
          editable: state.editable,
          expandLevelControl: state.expandLevelControl,
          resolveImageSrc: state.resolveImageSrc,
          writeAsset: state.writeAsset,
          onChange: (markdown: string) => state.onMarkdownChange?.(markdown),
          onExpandLevelChange: (level: number) => state.onExpandLevelChange?.(level)
        })
    }
  })
  app.mount(root)

  return {
    update: (next) => {
      state.source = next.source ?? ''
      state.initialExpandLevel = next.initialExpandLevel ?? 3
      state.height = next.height
      state.editable = Boolean(next.editable)
      state.expandLevelControl = Boolean(next.expandLevelControl)
      if (next.onMarkdownChange) state.onMarkdownChange = next.onMarkdownChange
      if (next.onExpandLevelChange) state.onExpandLevelChange = next.onExpandLevelChange
      if (next.resolveImageSrc) state.resolveImageSrc = next.resolveImageSrc
      if (next.writeAsset) state.writeAsset = next.writeAsset
    },
    unmount: () => {
      app?.unmount()
      app = null
      host.replaceChildren()
    }
  }
}

export interface NotesTablePreviewProps {
  notes: NotesTableRow[]
  missingIds?: string[]
  error?: string | null
}

export function mountNotesTablePreview(
  host: HTMLElement,
  props: NotesTablePreviewProps
): MountedVuePreview<NotesTablePreviewProps> {
  return mountVuePreview(
    host,
    'desk-notes-table-root',
    NotesTable,
    {
      notes: props.notes ?? [],
      missingIds: props.missingIds ?? [],
      error: props.error ?? null
    } as Record<string, unknown>,
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  ) as unknown as MountedVuePreview<NotesTablePreviewProps>
}

export function mountFootprintsPreview(
  host: HTMLElement,
  props: FootprintsPayload
): MountedVuePreview<FootprintsPayload> {
  return mountVuePreview(
    host,
    'desk-footprints-root',
    Footprints,
    {
      times: props.times ?? [],
      paragraphs: props.paragraphs ?? [],
      images: props.images ?? [],
      otherInfo: props.otherInfo ?? ''
    } as Record<string, unknown>,
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  ) as unknown as MountedVuePreview<FootprintsPayload>
}
