import { ref } from 'vue'

/** 左侧内容区的三个视图（顶部 icon 切换）。完整文件树已移除，旧记忆值回到笔记目录。 */
export type NavigatorView = 'toc' | 'search' | 'git'

export const NAVIGATOR_VIEWS: readonly NavigatorView[] = ['toc', 'search', 'git']

/** 侧栏 UI 偏好，不进 Desk 配置文件。首次默认笔记目录，之后记住上次的视图。 */
const STORAGE_KEY = 'tnotes-desk-navigator-view'

export function readNavigatorView(): NavigatorView {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY)
    return NAVIGATOR_VIEWS.includes(stored as NavigatorView) ? (stored as NavigatorView) : 'toc'
  } catch {
    return 'toc'
  }
}

export const navigatorView = ref<NavigatorView>(readNavigatorView())

export function setNavigatorView(view: NavigatorView): void {
  navigatorView.value = view
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, view)
  } catch {
    // 记不住就只在这次会话里生效
  }
}
