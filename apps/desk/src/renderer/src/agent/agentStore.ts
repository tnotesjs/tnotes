import { defineStore } from 'pinia'
import { computed, markRaw, nextTick, ref, watch } from 'vue'

import { allModelRefs, resolveModelRef } from '../../../shared/agentModels'
import { dismissStaleReview, onAgentReviewsChanged, setAgentReviewActions } from '../livePreview/agentReview'
import { liveEditorFor } from '../livePreview/editorRegistry'
import { useEditorStore } from '../stores/editor'
import { useWorkspaceStore } from '../stores/workspace'
import { eventMatchesTurn } from './turnFilter'
import {
  acceptNoteEdits,
  createToolContext,
  pendingReviewList,
  rejectNoteEdits,
  revealPendingNote,
  revealSelection,
  revealToolTarget,
  runAgentTool,
  staleReviewList
} from './agentTools'
import { selectionLabel } from './agentLabels'
import { findNote } from './agentNoteQuery'
import { agentTurnPayload } from './turnPayload'
import { cacheAttachment } from './attachmentCache'

import type {
  AgentContextRef,
  AgentImageRef,
  AgentMessagePart,
  AgentMode,
  AgentNoteContext,
  AgentReasoningEffort,
  AgentSelectionContext,
  AgentStoredChat,
  AgentToolRow
} from '../../../shared/contracts'

export interface MentionItem {
  knowledgeBaseId: string
  knowledgeBaseName: string
  noteUuid: string
  title: string
  index: string
}

export interface SelectionItem extends MentionItem {
  id: string
  fileName: string
  startLine: number
  endLine: number
  from: number
  to: number
  text: string
}

export interface PendingImage {
  id: string
  url: string
  data: Uint8Array
  width: number
  height: number
}

export const MAX_IMAGES = 4

function newChat(mode: AgentMode): AgentStoredChat {
  return {
    id: crypto.randomUUID(),
    title: '新对话',
    updatedAt: new Date().toISOString(),
    mode,
    messages: []
  }
}

function baseName(path: string, fallback: string): string {
  const name = path.split('/').pop() ?? ''
  return name || `${fallback}.md`
}

function kbDisplayName(knowledgeBaseId: string): string {
  return useWorkspaceStore().overview.knowledgeBases.find((item) => item.id === knowledgeBaseId)?.displayName ?? knowledgeBaseId
}

const RUNNING: Record<string, string> = {
  list_notes: '列出目录…',
  search_notes: '搜索中…',
  read_note: '读取中…',
  edit_note: '修改中…',
  create_note: '新建中…'
}

export const useAgentStore = defineStore('agent', () => {
  const open = ref(false)
  const width = ref(Number(localStorage.getItem('desk-agent-width') || 380))
  const mode = ref<AgentMode>('agent')
  const draft = ref('')
  const pending = ref(false)
  const error = ref('')
  const streaming = ref('')
  const reasoning = ref('')
  const reasoningStartedAt = ref(0)
  const reasoningEndedAt = ref(0)
  const liveSelection = ref<SelectionItem | null>(null)
  const selections = ref<SelectionItem[]>([])
  const mentions = ref<MentionItem[]>([])
  const images = ref<PendingImage[]>([])
  const keyProviders = ref<Record<string, boolean>>({})
  const keyLoaded = ref(false)
  const modelRef = ref(localStorage.getItem('desk-agent-model') ?? '')
  const reasoningEffort = ref<AgentReasoningEffort | ''>(
    (localStorage.getItem('desk-agent-effort') as AgentReasoningEffort | null) ?? 'medium'
  )
  const chats = ref<AgentStoredChat[]>([])
  const activeId = ref<string | null>(null)
  const historyOpen = ref(false)
  const liveParts = ref<AgentMessagePart[]>([])
  const created = new Set<string>()
  const reviewTick = ref(0)
  let listening = false
  let chatsWorkspace = ''
  let turnId = ''
  let toolContext = createToolContext()

  const active = computed(() => chats.value.find((chat) => chat.id === activeId.value) ?? null)

  const agentSettings = computed(() => useWorkspaceStore().settings?.agent ?? null)
  const models = computed(() => (agentSettings.value ? allModelRefs(agentSettings.value) : []))
  const currentModel = computed(() => {
    const settings = agentSettings.value
    if (!settings) return null
    return resolveModelRef(settings, modelRef.value) ?? resolveModelRef(settings, settings.defaultModel)
  })
  const currentModelRef = computed(() =>
    currentModel.value ? `${currentModel.value.provider.id}/${currentModel.value.model.id}` : ''
  )
  const keyReady = computed(() => {
    if (!keyLoaded.value) return true
    const provider = currentModel.value?.provider.id
    return provider ? Boolean(keyProviders.value[provider]) : false
  })

  function setModel(value: string): void {
    modelRef.value = value
    localStorage.setItem('desk-agent-model', value)
    if (active.value) active.value.modelRef = value
  }

  function setEffort(effort: AgentReasoningEffort): void {
    reasoningEffort.value = effort
    localStorage.setItem('desk-agent-effort', effort)
    if (active.value) active.value.reasoningEffort = effort
  }

  function patchTool(id: string, patch: Partial<AgentToolRow>): void {
    liveParts.value = liveParts.value.map((part) =>
      part.type === 'tool' && part.tool?.id === id ? { ...part, tool: { ...part.tool, ...patch } } : part
    )
  }

  function ensureListening(): void {
    if (listening) return
    listening = true
    onAgentReviewsChanged(() => {
      reviewTick.value += 1
    })
    window.desk.agent.onEvent((event) => {
      if (!eventMatchesTurn(event.turnId, turnId)) return
      if (event.type === 'text') appendText(event.delta)
      if (event.type === 'reasoning') appendReasoning(event.delta)
      if (event.type === 'tool-start') {
        liveParts.value = [
          ...liveParts.value,
          {
            type: 'tool',
            tool: {
              id: event.id,
              name: event.name,
              args: event.args,
              ok: true,
              summary: RUNNING[event.name] ?? '进行中…',
              detail: '',
              running: true
            }
          }
        ]
      }
      if (event.type === 'tool-end') patchTool(event.id, { ok: event.ok, summary: event.summary, running: false })
      if (event.type === 'error' && event.message !== '已停止') error.value = event.message
    })
    window.desk.agent.onToolCall((request) => {
      if (!eventMatchesTurn(request.turnId, turnId)) {
        void window.desk.agent.toolResult({ id: request.id, ok: false, summary: '已停止', detail: '' })
        return
      }
      void runAgentTool(request.name, request.args, created, toolContext).then((result) => {
        patchTool(request.id, {
          detail: result.detail,
          ok: result.ok,
          summary: result.summary,
          noteUuid: result.noteUuid,
          knowledgeBaseId: result.knowledgeBaseId,
          added: result.added,
          removed: result.removed,
          running: false
        })
        void window.desk.agent.toolResult({
          id: request.id,
          ok: result.ok,
          summary: result.summary,
          detail: result.detail
        })
      })
    })
  }

  /** 对话按工作区存：切换知识库不换对话，换工作区才重新加载。 */
  watch(
    () => useWorkspaceStore().overview.path,
    (next, previous) => {
      if (!next || next === previous) return
      activeId.value = null
      void loadChats()
    }
  )

  function appendText(delta: string): void {
    streaming.value += delta
    const parts = liveParts.value
    const last = parts[parts.length - 1]
    if (last?.type === 'text') {
      liveParts.value = [...parts.slice(0, -1), { type: 'text', text: (last.text ?? '') + delta }]
    } else {
      liveParts.value = [...parts, { type: 'text', text: delta }]
    }
  }

  function appendReasoning(delta: string): void {
    const now = Date.now()
    if (!reasoningStartedAt.value) reasoningStartedAt.value = now
    reasoningEndedAt.value = now
    reasoning.value += delta
  }

  /** 编辑器报告的当前选区（不会自动附带，⌘L 才加成胶囊）。 */
  function setSelection(
    input: {
      knowledgeBaseId: string
      noteUuid: string
      text: string
      range?: { startLine: number; endLine: number; startOffset: number; endOffset: number }
    } | null
  ): void {
    if (!input || !input.text || !input.range) {
      liveSelection.value = null
      return
    }
    const session = useWorkspaceStore().getDocumentSession(input.knowledgeBaseId, input.noteUuid)
    const title = session?.document.title ?? ''
    liveSelection.value = {
      id: '',
      knowledgeBaseId: input.knowledgeBaseId,
      knowledgeBaseName: kbDisplayName(input.knowledgeBaseId),
      noteUuid: input.noteUuid,
      title,
      index: session?.document.index ?? '',
      fileName: baseName(session?.document.relPath ?? '', title),
      startLine: input.range.startLine,
      endLine: input.range.endLine,
      from: input.range.startOffset,
      to: input.range.endOffset,
      text: input.text
    }
  }

  /** ⌘L：把当前选区加成胶囊。同一段不重复加。 */
  function addSelection(): boolean {
    const selection = liveSelection.value
    if (!selection) return false
    const duplicate = selections.value.some(
      (item) =>
        item.knowledgeBaseId === selection.knowledgeBaseId &&
        item.noteUuid === selection.noteUuid &&
        item.from === selection.from &&
        item.to === selection.to
    )
    if (!duplicate) selections.value = [...selections.value, { ...selection, id: crypto.randomUUID() }]
    return true
  }

  function removeSelection(id: string): void {
    selections.value = selections.value.filter((item) => item.id !== id)
  }

  function addMention(item: MentionItem): void {
    if (mentions.value.some((mention) => mention.knowledgeBaseId === item.knowledgeBaseId && mention.noteUuid === item.noteUuid)) return
    mentions.value = [...mentions.value, item]
  }

  /** 右键「添加到对话」或拖进对话框：点名这篇笔记，打开面板并聚焦输入框。 */
  async function addNoteToChat(knowledgeBaseId: string, noteUuid: string): Promise<boolean> {
    const workspace = useWorkspaceStore()
    const kb = workspace.knowledgeBase
    const node = kb?.id === knowledgeBaseId ? findNote(kb.toc, noteUuid) : null
    let title = node?.title ?? ''
    let index = node?.noteIndex ?? ''
    if (!node) {
      const session = await workspace.ensureDocument(knowledgeBaseId, noteUuid).catch(() => null)
      if (!session) return false
      title = session.document.title
      index = session.document.index ?? ''
    }
    addMention({ knowledgeBaseId, knowledgeBaseName: kbDisplayName(knowledgeBaseId), noteUuid, title, index })
    open.value = true
    await nextTick()
    document.querySelector<HTMLTextAreaElement>('.agent-dock textarea')?.focus()
    return true
  }

  function removeMention(item: MentionItem): void {
    mentions.value = mentions.value.filter(
      (mention) => !(mention.knowledgeBaseId === item.knowledgeBaseId && mention.noteUuid === item.noteUuid)
    )
  }

  function addImage(image: PendingImage): boolean {
    if (images.value.length >= MAX_IMAGES) return false
    images.value = [...images.value, markRaw(image)]
    return true
  }

  function removeImage(id: string): void {
    images.value = images.value.filter((image) => image.id !== id)
  }

  async function loadChats(): Promise<void> {
    const workspacePath = useWorkspaceStore().overview.path
    if (!workspacePath) return
    const result = await window.desk.agent.listChats(workspacePath)
    if (!result.ok || useWorkspaceStore().overview.path !== workspacePath) return
    const sameWorkspace = chatsWorkspace === workspacePath
    const local = sameWorkspace
      ? chats.value.filter(
          (chat) => !result.value.some((saved) => saved.id === chat.id) && (chat.messages.length > 0 || chat.id === activeId.value)
        )
      : []
    chatsWorkspace = workspacePath
    chats.value = [...local, ...result.value]
    if (!activeId.value || !chats.value.some((chat) => chat.id === activeId.value)) {
      activeId.value = chats.value[0]?.id ?? null
    }
    adoptChatSettings()
  }

  function adoptChatSettings(): void {
    const chat = active.value
    if (!chat) return
    mode.value = chat.mode
    if (chat.modelRef) modelRef.value = chat.modelRef
    if (chat.reasoningEffort) reasoningEffort.value = chat.reasoningEffort
  }

  async function persist(chat: AgentStoredChat, workspacePath: string): Promise<void> {
    if (!workspacePath || chat.messages.length === 0) return
    chat.updatedAt = new Date().toISOString()
    chat.mode = mode.value
    await window.desk.agent.saveChat({ workspacePath, chat: JSON.parse(JSON.stringify(chat)) })
  }

  function startChat(): void {
    const chat = newChat(mode.value)
    chat.modelRef = currentModelRef.value
    chat.reasoningEffort = reasoningEffort.value
    chats.value = [chat, ...chats.value]
    activeId.value = chat.id
    streaming.value = ''
    reasoning.value = ''
    liveParts.value = []
    error.value = ''
    historyOpen.value = false
  }

  function selectChat(id: string): void {
    activeId.value = id
    adoptChatSettings()
    historyOpen.value = false
  }

  async function renameChat(id: string, title: string): Promise<void> {
    const chat = chats.value.find((item) => item.id === id)
    const next = title.trim().slice(0, 80)
    if (!chat || !next || next === chat.title) return
    chat.title = next
    const workspacePath = useWorkspaceStore().overview.path
    if (!workspacePath || chat.messages.length === 0) return
    chat.updatedAt = new Date().toISOString()
    await window.desk.agent.saveChat({
      workspacePath,
      chat: JSON.parse(JSON.stringify(chat))
    })
  }

  async function removeChat(id: string): Promise<void> {
    const workspacePath = useWorkspaceStore().overview.path
    if (!workspacePath) return
    await window.desk.agent.deleteChat({ workspacePath, chatId: id })
    chats.value = chats.value.filter((chat) => chat.id !== id)
    if (activeId.value === id) activeId.value = chats.value[0]?.id ?? null
  }

  function currentNote() {
    const tab = useEditorStore().activeTab
    if (tab?.type !== 'note') return null
    const session = useWorkspaceStore().getDocumentSession(tab.knowledgeBaseId, tab.noteUuid)
    return {
      knowledgeBaseId: tab.knowledgeBaseId,
      knowledgeBaseName: kbDisplayName(tab.knowledgeBaseId),
      noteUuid: tab.noteUuid,
      noteIndex: session?.document.index ?? '',
      title: session?.document.title ?? tab.title
    }
  }

  async function noteContext(item: MentionItem): Promise<AgentNoteContext> {
    const workspace = useWorkspaceStore()
    const view = liveEditorFor(item.knowledgeBaseId, item.noteUuid)
    const session = await workspace.ensureDocument(item.knowledgeBaseId, item.noteUuid)
    const content = view ? view.state.doc.toString() : session.content
    return {
      knowledgeBaseId: item.knowledgeBaseId,
      knowledgeBaseName: item.knowledgeBaseName,
      noteUuid: item.noteUuid,
      noteIndex: item.index,
      title: item.title,
      path: session.document.relPath,
      lines: content.split('\n').length,
      content
    }
  }

  function contextRefs(kbId: string): AgentContextRef[] {
    const name = (item: MentionItem): string => (item.knowledgeBaseId === kbId ? item.title : `${item.knowledgeBaseName} · ${item.title}`)
    return [
      ...mentions.value.map((item) => ({
        type: 'note' as const,
        knowledgeBaseId: item.knowledgeBaseId,
        knowledgeBaseName: item.knowledgeBaseName,
        noteUuid: item.noteUuid,
        title: item.title,
        label: name(item)
      })),
      ...selections.value.map((item) => ({
        type: 'selection' as const,
        knowledgeBaseId: item.knowledgeBaseId,
        knowledgeBaseName: item.knowledgeBaseName,
        noteUuid: item.noteUuid,
        title: item.title,
        label: selectionLabel(item, kbId),
        startLine: item.startLine,
        endLine: item.endLine,
        from: item.from,
        to: item.to,
        head: item.text.slice(0, 2000)
      }))
    ]
  }

  async function send(text: string): Promise<void> {
    const content = text.trim()
    if ((!content && images.value.length === 0) || pending.value) return
    ensureListening()
    const workspace = useWorkspaceStore()
    const kb = workspace.knowledgeBase
    if (!kb) {
      error.value = '没有打开知识库'
      return
    }
    const resolved = currentModel.value
    if (!resolved) {
      error.value = '还没有可用的模型。打开设置 → 内置 Agent 添加。'
      return
    }
    await refreshKey()
    if (!keyReady.value && !import.meta.env.DEV) {
      error.value = `还没有填写「${resolved.provider.name}」的 API Key。打开设置 → 内置 Agent。`
      return
    }
    if (images.value.length > 0 && !resolved.model.vision) {
      error.value = '当前模型不能看图，换一个能看图的模型'
      return
    }
    const workspacePath = workspace.overview.path ?? ''
    const attachedImages: AgentImageRef[] = []
    for (const image of images.value) {
      const saved = await window.desk.agent.saveAttachment({ data: image.data, width: image.width, height: image.height })
      if (!saved.ok) {
        error.value = saved.error.message
        return
      }
      cacheAttachment(saved.value.id, image.url)
      attachedImages.push(saved.value)
    }
    if (!active.value) startChat()
    const chat = active.value
    if (!chat) return
    if (chat.messages.length === 0 && (!chat.title || chat.title === '新对话')) {
      chat.title = (content || '图片').slice(0, 24)
    }
    chat.modelRef = currentModelRef.value
    chat.reasoningEffort = reasoningEffort.value
    chat.knowledgeBaseId = kb.id
    chat.knowledgeBaseName = kbDisplayName(kb.id)
    const refs = contextRefs(kb.id)
    const mentioned = [...mentions.value]
    const selected = [...selections.value]
    chat.messages.push({ role: 'user', content, refs, images: attachedImages.length ? attachedImages : undefined })
    draft.value = ''
    mentions.value = []
    selections.value = []
    images.value = []
    pending.value = true
    error.value = ''
    streaming.value = ''
    reasoning.value = ''
    reasoningStartedAt.value = 0
    reasoningEndedAt.value = 0
    liveParts.value = []
    turnId = crypto.randomUUID()
    const thisTurn = turnId
    const selectionContexts: AgentSelectionContext[] = selected.map((item) => ({
      knowledgeBaseId: item.knowledgeBaseId,
      knowledgeBaseName: item.knowledgeBaseName,
      noteUuid: item.noteUuid,
      noteIndex: item.index,
      title: item.title,
      startLine: item.startLine,
      endLine: item.endLine,
      text: item.text
    }))
    toolContext = createToolContext(kb.id)
    toolContext.contextKbIds = [...new Set([...mentioned, ...selected].map((item) => item.knowledgeBaseId))]
    toolContext.isCurrent = () => turnId === thisTurn
    try {
      const notes = await Promise.all(mentioned.map(noteContext))
      const payload = agentTurnPayload({
        turnId,
        messages: chat.messages.map((message) => ({
          role: message.role,
          content:
            message.role === 'assistant' && message.tools?.length
              ? `${message.content}\n\n工具摘要：\n${message.tools.map((tool) => `- ${tool.summary}${tool.added !== undefined ? ` +${tool.added} −${tool.removed ?? 0}` : ''}`).join('\n')}`
              : message.content,
          images: message.images?.map((image) => image.id)
        })),
        mode: mode.value,
        knowledgeBaseId: kb.id,
        knowledgeBaseName: kbDisplayName(kb.id),
        current: currentNote(),
        notes,
        selections: selectionContexts,
        modelRef: currentModelRef.value,
        reasoningEffort: resolved.model.reasoning ? reasoningEffort.value : ''
      })
      toolContext.defaultNote = payload.defaultNote
      const result = await window.desk.agent.turn(payload)
      const thoughtMs = reasoningStartedAt.value ? Math.max(1000, reasoningEndedAt.value - reasoningStartedAt.value) : undefined
      if (!result.ok) {
        const stopped = result.error.message === '已停止'
        if (!stopped) error.value = result.error.message
        chat.messages.push({
          role: 'assistant',
          content: streaming.value,
          reasoning: reasoning.value || undefined,
          thoughtMs,
          tools: toolRows(),
          parts: [...liveParts.value],
          status: stopped ? 'stopped' : 'error'
        })
      } else {
        chat.messages.push({
          role: 'assistant',
          content: result.value.reply,
          reasoning: reasoning.value || undefined,
          thoughtMs,
          tools: toolRows(),
          parts: [...liveParts.value],
          status: result.value.truncated ? 'truncated' : undefined
        })
      }
      streaming.value = ''
      await persist(chat, workspacePath)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      chat.messages.push({
        role: 'assistant',
        content: streaming.value,
        parts: [...liveParts.value],
        status: 'error'
      })
      await persist(chat, workspacePath)
    } finally {
      if (turnId === thisTurn) turnId = ''
      pending.value = false
      liveParts.value = []
    }
  }

  function toolRows(): AgentToolRow[] {
    return liveParts.value.flatMap((part) =>
      part.type === 'tool' && part.tool ? [{ ...part.tool, detail: '', running: false }] : []
    )
  }

  function stop(): void {
    turnId = ''
    void window.desk.agent.cancel()
  }

  const pendingNotes = computed(() => {
    reviewTick.value
    useWorkspaceStore().knowledgeBase
    return pendingReviewList()
  })

  const pendingByKb = computed(() => {
    const counts: Record<string, number> = {}
    for (const item of pendingNotes.value) counts[item.knowledgeBaseId] = (counts[item.knowledgeBaseId] ?? 0) + 1
    return counts
  })

  const pendingNoteKeys = computed(() => new Set(pendingNotes.value.map((item) => `${item.knowledgeBaseId}:${item.uuid}`)))

  const staleNotes = computed(() => {
    reviewTick.value
    return staleReviewList()
  })

  function dismissStale(knowledgeBaseId: string, noteUuid: string): void {
    dismissStaleReview(knowledgeBaseId, noteUuid)
  }

  type Target = { knowledgeBaseId: string; uuid: string }

  async function accept(target?: Target): Promise<void> {
    const list = target ? [target] : pendingNotes.value.map((item) => ({ knowledgeBaseId: item.knowledgeBaseId, uuid: item.uuid }))
    for (const item of list) {
      const result = await acceptNoteEdits(item.knowledgeBaseId, item.uuid)
      if (!result.ok) {
        error.value = result.message
        continue
      }
      created.delete(`${item.knowledgeBaseId}:${item.uuid}`)
    }
  }

  async function reject(target?: Target): Promise<void> {
    const list = target ? [target] : pendingNotes.value.map((item) => ({ knowledgeBaseId: item.knowledgeBaseId, uuid: item.uuid }))
    for (const item of list) {
      const result = await rejectNoteEdits(item.knowledgeBaseId, item.uuid, created)
      if (!result.ok) error.value = result.message
    }
  }

  function revealPending(target: Target): void {
    void revealPendingNote(target.knowledgeBaseId, target.uuid)
  }

  function revealTool(tool: AgentToolRow): void {
    void revealToolTarget(tool, useWorkspaceStore().knowledgeBase?.id ?? '')
  }

  function revealRef(ref: AgentContextRef | SelectionItem | MentionItem): void {
    void revealSelection({
      knowledgeBaseId: ref.knowledgeBaseId,
      noteUuid: ref.noteUuid,
      from: 'from' in ref ? ref.from : undefined,
      to: 'to' in ref ? ref.to : undefined,
      startLine: 'startLine' in ref ? ref.startLine : undefined,
      endLine: 'endLine' in ref ? ref.endLine : undefined,
      text: 'text' in ref ? ref.text : 'head' in ref ? ref.head : undefined
    })
  }

  function setWidth(next: number): void {
    width.value = Math.min(640, Math.max(280, next))
    localStorage.setItem('desk-agent-width', String(width.value))
  }

  async function refreshKey(): Promise<void> {
    const status = await window.desk.agent.keyStatus()
    if (!status.ok) return
    keyProviders.value = status.value.providers
    keyLoaded.value = true
  }

  setAgentReviewActions({
    accept: (knowledgeBaseId, noteUuid) => void accept({ knowledgeBaseId, uuid: noteUuid }),
    reject: (knowledgeBaseId, noteUuid) => void reject({ knowledgeBaseId, uuid: noteUuid })
  })

  return {
    open,
    width,
    mode,
    draft,
    pending,
    error,
    streaming,
    reasoning,
    reasoningStartedAt,
    liveParts,
    liveSelection,
    selections,
    mentions,
    images,
    keyReady,
    models,
    currentModel,
    currentModelRef,
    reasoningEffort,
    chats,
    activeId,
    active,
    historyOpen,
    ensureListening,
    loadChats,
    startChat,
    selectChat,
    renameChat,
    removeChat,
    send,
    stop,
    accept,
    reject,
    revealPending,
    revealRef,
    revealTool,
    setWidth,
    setModel,
    setEffort,
    pendingNotes,
    pendingByKb,
    pendingNoteKeys,
    staleNotes,
    dismissStale,
    setSelection,
    addSelection,
    removeSelection,
    addMention,
    addNoteToChat,
    removeMention,
    addImage,
    removeImage,
    refreshKey
  }
})

