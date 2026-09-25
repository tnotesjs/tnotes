/**
 * 可视化笔记里「新建画布」：主进程建源文件 + 占位 SVG，再插入图片并打开标签。
 * 顺序与主分支 Milkdown 斜杠菜单一致；本模块只给 Live Preview 用。
 */
import { serializeImageMarkdown } from '@tnotesjs/ui/image-markdown'

import { noteRelativeAssetPath } from '../../markdown/noteAssetPath'
import { useEditorStore } from '../../stores/editor'
import { useWorkspaceStore } from '../../stores/workspace'
import { documentKey } from '../../stores/workspace/helpers'

import { invalidateCanvasSource, placeholderCanvasSvg } from './canvasImage'

export interface InsertCanvasParams {
  knowledgeBaseId: string
  noteUuid: string
  insertTextAt: (text: string) => void
}

/**
 * 创建画布并插入到当前光标处。失败时把原因写到 workspace.error，不抛错。
 */
export async function insertExcalidrawCanvas(params: InsertCanvasParams): Promise<void> {
  const workspace = useWorkspaceStore()
  const session = workspace.documents[documentKey(params.knowledgeBaseId, params.noteUuid)]
  const noteRelPath = session?.document.relPath
  const noteIndex = session?.document.index ?? ''
  if (!noteRelPath) {
    workspace.error = '无法定位当前笔记，画布未创建'
    return
  }
  if (!/^\d{4}$/.test(noteIndex)) {
    workspace.error = '当前笔记缺少四位编号，画布未创建（文件名归属需要它）'
    return
  }

  const created = await window.desk.excalidraw.create({
    knowledgeBaseId: params.knowledgeBaseId,
    noteUuid: params.noteUuid
  })
  if (!created.ok) {
    workspace.error = `无法创建画布：${created.error.message}`
    return
  }

  const sourceRelPath = created.value.relPath
  const derived = await window.desk.excalidraw.writeDerived({
    knowledgeBaseId: params.knowledgeBaseId,
    sourceRelPath,
    content: placeholderCanvasSvg()
  })
  if (!derived.ok) {
    workspace.error = `画布已创建但占位图写入失败：${derived.error.message}`
    return
  }

  const relative = noteRelativeAssetPath(noteRelPath, derived.value.relPath)
  if (!relative) {
    workspace.error = `画布已创建但无法计算相对路径，请在资源面板找到它：${sourceRelPath}`
    return
  }

  params.insertTextAt(`${serializeImageMarkdown({ alt: '画布', src: relative })}\n`)
  invalidateCanvasSource(params.knowledgeBaseId, derived.value.relPath)

  const knowledgeBase =
    workspace.overview.allKnowledgeBases.find((item) => item.id === params.knowledgeBaseId) ?? null
  if (!knowledgeBase) {
    workspace.error = `画布已创建但无法打开标签页：${sourceRelPath}`
    return
  }

  const fileName = sourceRelPath.split('/').pop() ?? sourceRelPath
  const noteTitle = session?.document.title
  workspace.status = `已创建画布 ${sourceRelPath}`
  useEditorStore().openExcalidraw(knowledgeBase, sourceRelPath, {
    title: noteTitle ? `${fileName} · ${noteTitle}` : fileName
  })
}
