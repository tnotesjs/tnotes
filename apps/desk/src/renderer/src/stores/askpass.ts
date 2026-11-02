import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { AskpassPromptDto } from '../../../shared/contracts'

/** git 凭据询问队列：一次只显示一个，按到达顺序作答。 */
export const useAskpassStore = defineStore('askpass', () => {
  const queue = ref<AskpassPromptDto[]>([])
  const current = computed(() => queue.value[0] ?? null)

  function remove(id: string): void {
    queue.value = queue.value.filter((item) => item.id !== id)
  }

  function subscribe(): () => void {
    const offRequest = window.desk.askpass.onRequest((prompt) => {
      queue.value = [...queue.value, prompt]
    })
    const offDismiss = window.desk.askpass.onDismiss((id) => remove(id))
    return () => {
      offRequest()
      offDismiss()
    }
  }

  /** 作答当前询问；`null` 表示取消 */
  async function answer(value: string | null): Promise<void> {
    const prompt = current.value
    if (!prompt) return
    remove(prompt.id)
    await window.desk.askpass.answer(prompt.id, value)
  }

  return { queue, current, subscribe, answer }
})
