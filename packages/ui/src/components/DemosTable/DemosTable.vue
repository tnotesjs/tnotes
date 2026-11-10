<script setup lang="ts">
import type { DemosTableRow } from './types'

defineProps<{
  demos?: DemosTableRow[]
  missingIds?: string[]
  error?: string | null
  /** Desk 里点 Demo 列复制目录路径；站点保持普通文本。 */
  interactive?: boolean
}>()

const emit = defineEmits<{ select: [path: string] }>()
</script>

<template>
  <div v-if="error" class="tn-demos-table__error">
    {{ error }}
  </div>

  <div v-else-if="(missingIds?.length ?? 0) > 0" class="tn-demos-table__warning">
    以下 Demo ID 未找到: {{ missingIds!.join(', ') }}
  </div>

  <table v-if="(demos?.length ?? 0) > 0" class="tn-demos-table">
    <thead>
      <tr>
        <th>Demo</th>
        <th>简介</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="demo in demos" :key="demo.id">
        <td>
          <button
            v-if="interactive && demo.path"
            type="button"
            class="tn-demos-table__link"
            @click="emit('select', demo.path)"
          >
            <span class="tn-demos-table__id">{{ demo.id }}.</span>
            <span>{{ demo.title }}</span>
          </button>
          <span v-else class="tn-demos-table__label">
            <span class="tn-demos-table__id">{{ demo.id }}.</span>
            <span>{{ demo.title }}</span>
          </span>
        </td>
        <td>
          <span class="tn-demos-table__desc" :class="{ 'is-empty': !demo.description }">
            {{ demo.description || '暂无简介' }}
          </span>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style lang="scss">
:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-demos-table {
  width: 100%;
  margin: 1.5rem 0;
  border-collapse: collapse;
  font-size: 0.95rem;

  th,
  td {
    padding: 0.75rem 1rem;
    text-align: left;
    border: 1px solid var(--tn-c-divider);
  }

  th {
    background-color: var(--tn-c-bg-soft);
    font-weight: 600;
    color: var(--tn-c-text);
  }

  tbody tr:hover {
    background-color: var(--tn-c-bg-soft);
  }

  td {
    color: var(--tn-c-text-2);
  }
}

:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-demos-table__link,
:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-demos-table__label {
  color: var(--tn-c-brand);
  font-weight: 500;
}

:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-demos-table__link {
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
  text-align: left;

  &:hover {
    text-decoration: underline;
  }
}

:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-demos-table__id {
  margin-right: 0.5rem;
  font-family: var(--tn-font-mono);
  font-size: 0.9em;
  color: var(--tn-c-text-2);
}

:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-demos-table__desc {
  line-height: 1.6;

  &.is-empty {
    color: var(--tn-c-text-2);
    font-style: italic;
  }
}

.tn-demos-table__error,
.tn-demos-table__warning {
  margin: 1rem 0;
  padding: 1rem;
  border-radius: 4px;
  border-left: 4px solid var(--tn-c-danger);
  background-color: var(--tn-c-danger-soft);
  color: var(--tn-c-danger);
}

.tn-demos-table__warning {
  border-left-color: #f9b44e;
  background-color: color-mix(in srgb, #f9b44e 16%, transparent);
  color: #f9b44e;
}
</style>
