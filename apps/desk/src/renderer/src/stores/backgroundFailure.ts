import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { BackgroundFailureDto } from '../../../shared/contracts'

import { resultValue } from './workspace/helpers'

/**
 * 「后台操作没能建出可见任务」的失败（当前只有一种成因：底部面板标签已达上限）。
 *
 * 这类失败在面板里没有任务、也就没有「查看输出」入口，所以单独持有：
 * 由设置里的「Git 与远端」分组展示（**不占面板标签**），保留主进程给出的错误原文。
 */
export const useBackgroundFailureStore = defineStore('backgroundFailure', () => {
  const failures = ref<BackgroundFailureDto[]>([])
  const loaded = ref(false)

  /** 最近一次发生的失败（用于提示"有新失败"，避免只是静默入库） */
  const latest = computed(() => failures.value[0] ?? null)

  async function load(): Promise<void> {
    try {
      failures.value = resultValue(await window.desk.backgroundFailures.list())
      loaded.value = true
    } catch {
      // 读不到就保持空列表：这是附加信息，不该反过来影响设置面板
      loaded.value = true
    }
  }

  async function clear(): Promise<void> {
    await window.desk.backgroundFailures.clear()
    failures.value = []
  }

  /** 返回取消订阅函数 */
  function subscribe(): () => void {
    return window.desk.backgroundFailures.onChanged((items) => {
      failures.value = items
      loaded.value = true
    })
  }

  return { failures, loaded, latest, load, clear, subscribe }
})
