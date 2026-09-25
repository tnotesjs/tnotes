import type { EditorView } from '@codemirror/view'

import { locateUniqueReplace } from '../../../shared/agentReplace'
import { applyAgentChanges } from '../livePreview/agentReview'

export async function applyEditInView(
  view: EditorView | null,
  oldString: string,
  newString: string
): Promise<{ ok: boolean; message: string }> {
  if (!view) return { ok: false, message: '这篇笔记没有打开可视化编辑器' }
  if (view.state.readOnly) return { ok: false, message: '这篇笔记是只读的' }
  const located = locateUniqueReplace(view.state.doc.toString(), oldString)
  if ('error' in located) return { ok: false, message: located.error }
  applyAgentChanges(view, { from: located.from, to: located.to, insert: newString }, '替换一段文字')
  return { ok: true, message: '已标在编辑器里' }
}
