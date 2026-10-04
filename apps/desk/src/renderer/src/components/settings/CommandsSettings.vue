<script setup lang="ts">
import { computed } from 'vue'

import { useWorkspaceStore } from '../../stores/workspace'
import { createPaletteCommands, type PaletteCommand } from '../../commands/paletteCommands'

const store = useWorkspaceStore()

const commands = computed(() =>
  createPaletteCommands({
    saveDocument: async () => undefined,
    openSettings: () => undefined,
    openKbSettings: () => undefined,
    openKbAssets: () => undefined,
    hasSelectedKnowledgeBase: () => true,
    toggleTerminal: () => undefined,
    theme: store.settings?.theme ?? 'system',
    setTheme: () => undefined
  })
)

interface CatalogRow {
  id: string
  category: string
  title: string
  alias: string
  current: boolean
  shortcut?: string
}

function toRow(command: PaletteCommand): CatalogRow {
  return {
    id: command.id,
    category: command.category,
    title: command.title,
    alias: command.keywords[0] ?? '',
    current: command.hint === '当前',
    shortcut: command.shortcut
  }
}

/** 12 条分级折叠合成两行，避免清单被近重复的条目撑长。 */
function catalogRows(list: PaletteCommand[]): CatalogRow[] {
  const rows: CatalogRow[] = []
  let folded = false
  let unfolded = false
  for (const command of list) {
    if (/^fold-level-\d$/.test(command.id)) {
      if (!folded) {
        folded = true
        rows.push({
          id: 'fold-levels',
          category: command.category,
          title: '折叠 1–6 级标题',
          alias: 'fold level 1…6',
          current: false
        })
      }
      continue
    }
    if (/^unfold-level-\d$/.test(command.id)) {
      if (!unfolded) {
        unfolded = true
        rows.push({
          id: 'unfold-levels',
          category: command.category,
          title: '展开 1–6 级标题',
          alias: 'unfold level 1…6',
          current: false
        })
      }
      continue
    }
    rows.push(toRow(command))
  }
  return rows
}

const groups = computed(() => {
  const rows = catalogRows(commands.value)
  const buckets: { category: string; items: CatalogRow[] }[] = []
  for (const row of rows) {
    const current = buckets[buckets.length - 1]
    if (!current || current.category !== row.category) {
      buckets.push({ category: row.category, items: [row] })
      continue
    }
    current.items.push(row)
  }
  return buckets
})
</script>

<template>
  <section class="settings-section">
    <header class="section-heading">
      <strong>命令清单</strong>
      <span>命令面板输入 &gt; 后执行。右侧是这条命令的名字。</span>
    </header>
    <div v-for="group in groups" :key="group.category" class="command-group">
      <h3>{{ group.category }}</h3>
      <div v-for="command in group.items" :key="command.id" class="command-row">
        <span class="command-title">{{ command.title }}</span>
        <span v-if="command.alias" class="command-alias">{{ command.alias }}</span>
        <span v-if="command.current" class="command-current">当前</span>
        <kbd v-if="command.shortcut">{{ command.shortcut }}</kbd>
      </div>
    </div>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.command-group + .command-group {
  margin-top: 18px;
}

.command-group h3 {
  margin: 0 0 6px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
}

.command-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}

.command-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-alias,
.command-current {
  flex: none;
  color: var(--muted);
}

.command-current {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 6px;
  font-size: 9px;
  line-height: 16px;
}

.command-row kbd {
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--input-bg);
  color: var(--text);
  padding: 3px 7px;
  font: inherit;
}

</style>
