import { reactive } from 'vue'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastItem {
  id: number
  message: string
  kind: ToastKind
  /** 可选动作（例如后台失败时的「查看输出」） */
  action?: { label: string; run: () => void }
}

const toasts = reactive<ToastItem[]>([])
let nextId = 1

export function pushToast(message: string, kind: ToastKind = 'info', duration = 3600): number {
  const id = nextId++
  toasts.push({ id, message, kind })
  window.setTimeout(() => dismissToast(id), duration)
  return id
}

/** 带动作的通知：动作执行后自动收起。 */
export function pushActionToast(
  message: string,
  label: string,
  run: () => void,
  kind: ToastKind = 'info',
  duration = 8000
): number {
  const id = nextId++
  toasts.push({
    id,
    message,
    kind,
    action: {
      label,
      run: () => {
        dismissToast(id)
        run()
      }
    }
  })
  window.setTimeout(() => dismissToast(id), duration)
  return id
}

export function dismissToast(id: number): void {
  const index = toasts.findIndex((toast) => toast.id === id)
  if (index >= 0) toasts.splice(index, 1)
}

export function useToasts(): ToastItem[] {
  return toasts
}
