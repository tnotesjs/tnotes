import { ref } from 'vue'

/** 侧栏按钮的选择，不进 Desk 配置文件。缺省显示。 */
const STORAGE_KEY = 'tnotes-desk-show-note-index'

function readShowNoteIndex(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export const showNoteIndex = ref(readShowNoteIndex())

export function toggleShowNoteIndex(): void {
  showNoteIndex.value = !showNoteIndex.value
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, showNoteIndex.value ? '1' : '0')
  } catch {
    // 记不住就只在这次会话里生效
  }
}
