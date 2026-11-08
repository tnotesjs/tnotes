<script setup lang="ts">
import type { NotesTableRow } from './types'

defineProps<{
  notes?: NotesTableRow[]
  missingIds?: string[]
  error?: string | null
}>()
</script>

<template>
  <div v-if="error" class="tn-notes-table__error">
    {{ error }}
  </div>

  <div v-else-if="(missingIds?.length ?? 0) > 0" class="tn-notes-table__warning">
    以下笔记 ID 未找到配置: {{ missingIds!.join(', ') }}
  </div>

  <table v-if="(notes?.length ?? 0) > 0" class="tn-notes-table">
    <thead>
      <tr>
        <th>笔记</th>
        <th>简介</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="note in notes" :key="note.id">
        <td>
          <a :href="note.url" class="tn-notes-table__link">
            <span class="tn-notes-table__id">{{ note.id }}.</span>
            <span>{{ note.title }}</span>
          </a>
        </td>
        <td>
          <span class="tn-notes-table__desc" :class="{ 'is-empty': !note.description }">
            {{ note.description || '暂无简介' }}
          </span>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style lang="scss">
:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-notes-table {
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

  tbody tr {
    transition: background-color 0.2s;

    &:hover {
      background-color: var(--tn-c-bg-soft);
    }
  }

  td {
    color: var(--tn-c-text-2);
  }
}

:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-notes-table__link {
  color: var(--tn-c-brand);
  text-decoration: none;
  font-weight: 500;

  &:hover {
    text-decoration: underline;
  }
}

:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-notes-table__id {
  margin-right: 0.5rem;
  font-family: var(--tn-font-mono);
  font-size: 0.9em;
  color: var(--tn-c-text-2);
}

:is(.tn-prose, .vp-doc, .cm-lp-card) .tn-notes-table__desc {
  line-height: 1.6;

  &.is-empty {
    color: var(--tn-c-text-2);
    font-style: italic;
  }
}

.tn-notes-table__error,
.tn-notes-table__warning {
  margin: 1rem 0;
  padding: 1rem;
  border-radius: 4px;
  border-left: 4px solid var(--tn-c-danger);
  background-color: var(--tn-c-danger-soft);
  color: var(--tn-c-danger);
}

.tn-notes-table__warning {
  border-left-color: #f9b44e;
  background-color: color-mix(in srgb, #f9b44e 16%, transparent);
  color: #f9b44e;
}
</style>
