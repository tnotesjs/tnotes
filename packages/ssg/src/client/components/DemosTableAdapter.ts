import DemosTable from '@tnotesjs/ui/demos-table'
import { computed, defineComponent, h, inject } from 'vue'

import type { DemosTableRow } from '@tnotesjs/ui'

export const DEMOS_DATA_KEY = Symbol('tnotes-demos')

export interface SiteDemo {
  id: string
  title: string
  description: string
}

export default defineComponent({
  name: 'DemosTableAdapter',
  props: {
    ids: { type: Array as () => string[], required: true }
  },
  setup(props) {
    const demos = inject<SiteDemo[]>(DEMOS_DATA_KEY, [])
    const byId = computed(() => new Map(demos.map((demo) => [demo.id, demo])))
    const rows = computed<DemosTableRow[]>(() =>
      props.ids.flatMap((id) => {
        const demo = byId.value.get(id)
        if (!demo) return []
        return [{ id, title: demo.title, description: demo.description }]
      })
    )
    const missing = computed(() => props.ids.filter((id) => !byId.value.has(id)))
    const error = computed(() => (props.ids.length === 0 ? '错误: ids 数组不能为空' : null))
    return () =>
      h(DemosTable, {
        demos: rows.value,
        missingIds: missing.value,
        error: error.value
      })
  }
})
