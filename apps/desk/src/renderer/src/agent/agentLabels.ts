export interface SelectionLabelSource {
  fileName: string
  startLine: number
  endLine: number
  knowledgeBaseId: string
  knowledgeBaseName: string
}

/** 胶囊上的「文件名」和「:行号」分开给，文件名太长时只截文件名。其他知识库的前面带上库名。 */
export function selectionLabelParts(item: SelectionLabelSource, currentKbId: string): { name: string; lines: string } {
  const lines = item.startLine === item.endLine ? `${item.startLine}` : `${item.startLine}–${item.endLine}`
  const name = item.knowledgeBaseId === currentKbId ? item.fileName : `${item.knowledgeBaseName} · ${item.fileName}`
  return { name, lines: `:${lines}` }
}

export function selectionLabel(item: SelectionLabelSource, currentKbId: string): string {
  const parts = selectionLabelParts(item, currentKbId)
  return `${parts.name}${parts.lines}`
}
