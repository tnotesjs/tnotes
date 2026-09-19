<script setup lang="ts">
import { computed } from 'vue'

import { useWorkspaceStore } from '../../stores/workspace'

import type { AppSettings } from '../../../../shared/contracts'

defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()

const store = useWorkspaceStore()

const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  dateStyle: 'short',
  timeStyle: 'short',
  hour12: false
})

/** 时间统一按本地时区展示；缺失或非法一律显示「从未」，不猜一个假时间。 */
function formatTime(iso: string | null): string {
  if (!iso) return '从未'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '从未' : timeFormat.format(date)
}

/** 各知识库的上次成功远端检查（按最近优先；没检查过的一律「从未」）。 */
const rows = computed(() =>
  Object.values(store.gitStates)
    .map((state) => ({ name: state.knowledgeBaseName, at: state.lastFetchedAt }))
    .sort((left, right) => {
      if (left.at === right.at) return left.name.localeCompare(right.name)
      if (!left.at) return 1
      if (!right.at) return -1
      return right.at.localeCompare(left.at)
    })
)

/** 全局最近一次成功远端检查；一个都没有时显示「从未」。 */
const lastCheck = computed(() => rows.value.find((row) => row.at)?.at ?? null)
</script>

<template>
  <section class="settings-section git-settings">
    <header class="section-heading">
      <strong>Git 与远端</strong>
      <span>后台自动抓取开关与上次远端检查时间</span>
    </header>
    <button type="button" class="reset-group" @click="emit('reset')">重置</button>
    <div class="field-grid">
      <label class="card-toggle">
        <input v-model="draft.git.autoFetch" data-testid="git-auto-fetch" type="checkbox" />
        <span>
          <strong>后台自动抓取远端更新</strong>
          <small>
            默认关闭。打开后会打开知识库时抓取一次，之后每 5 分钟检查一次远端；失败会退避重试。
            手动「获取远端更新」与「拉取更新」始终可用，不受此开关影响。
          </small>
        </span>
      </label>
    </div>
    <div class="git-last-check">
      <div class="git-last-check__head">
        <span>上次成功远端检查</span>
        <strong data-testid="git-last-check">{{ formatTime(lastCheck) }}</strong>
      </div>
      <ul v-if="rows.length > 0" class="git-last-check__list">
        <li v-for="row in rows" :key="row.name">
          <span class="git-last-check__name">{{ row.name }}</span>
          <span>{{ formatTime(row.at) }}</span>
        </li>
      </ul>
      <p v-else class="git-last-check__empty">当前没有已打开的知识库</p>
    </div>
  </section>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.card-toggle {
  min-height: 56px;
  display: flex !important;
  flex-direction: row !important;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input-bg);
  padding: 9px 11px;
  cursor: pointer;
}

.card-toggle input {
  accent-color: var(--accent);
  margin: 0;
}

.card-toggle > span {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.card-toggle strong {
  color: var(--text);
  font-size: 10px;
}

.card-toggle small {
  color: var(--muted);
  font-size: 9px;
  line-height: 1.5;
}

.card-toggle:hover {
  border-color: var(--accent);
}

.git-last-check {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input-bg);
  padding: 10px 12px;
}

.git-last-check__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  color: var(--muted);
  font-size: 10px;
}

.git-last-check__head strong {
  color: var(--text);
  font-size: 11px;
  font-family: var(--font-mono);
}

.git-last-check__list {
  margin: 8px 0 0;
  padding: 8px 0 0;
  border-top: 1px solid var(--border);
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.git-last-check__list li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  color: var(--muted);
  font-size: 9px;
}

.git-last-check__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-last-check__empty {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 9px;
}
</style>
