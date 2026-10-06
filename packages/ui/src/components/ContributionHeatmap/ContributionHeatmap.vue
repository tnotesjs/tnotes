<!--
  完成热力图（GitHub contribution graph 风格）

  ⚠️ 本文件在两处保持逐字节一致，改动请同步：
    - tnotes/packages/ui/src/components/ContributionHeatmap/ContributionHeatmap.vue（@tnotesjs/ui，子库站点 SSG 使用）
    - TNotes.root/src/components/ContributionHeatmap.vue（根库站点；根库未依赖 @tnotesjs/ui，暂以副本形式存在）

  着色：按「当天 commit 数」（更新热度，非负）
    - GitHub 同款 4 档绿色，强度按当年最大 commit 数做对数分档
    - 0 / 无记录：GitHub 空格子色（暗色主题下比背景亮一档，避免黑底黑格）
  底栏左侧：当年累计完成数（+ 本年净增），静态，不随悬停变化；
  单日详情（commits / delta / total）只在悬停气泡里展示；
  delta < 0（取消勾选净减）在详情中以粉色标注。
  顶栏：左侧为当前范围 + 年份的 commit 总数，右侧为年份下拉（无标题）。
-->
<template>
  <div v-if="cells.length" ref="rootRef" class="tn-heatmap">
    <div class="tn-heatmap-toolbar">
      <div class="tn-heatmap-total">
        <strong>{{ yearStats.commits }}</strong> 次提交 · {{ activeYear }} 年
      </div>
      <select
        v-if="years.length"
        v-model="activeYear"
        class="tn-heatmap-year-select"
        aria-label="选择年份"
      >
        <option v-for="y in yearsDesc" :key="y" :value="y">{{ y }}</option>
      </select>
    </div>

    <div class="tn-heatmap-panel">
      <div ref="scrollRef" class="tn-heatmap-scroll" @mouseleave="hideTip">
        <div class="tn-heatmap-graph">
          <div class="tn-heatmap-months" :style="{ width: gridWidth }">
            <span v-for="m in monthLabels" :key="m.month" :style="{ left: colOffset(m.col) }">{{
              m.text
            }}</span>
          </div>
          <div class="tn-heatmap-body">
            <div class="tn-heatmap-weekdays" aria-hidden="true">
              <span v-for="(label, i) in weekdayLabels" :key="i">{{ label }}</span>
            </div>
            <div
              class="tn-heatmap-cells"
              :style="{ gridTemplateColumns: `repeat(${weekCount}, var(--tn-hm-cell))` }"
            >
              <span
                v-for="cell in yearCells"
                :key="cell.date"
                class="tn-heatmap-cell"
                :class="levelClass(cell.level)"
                :style="{ gridColumn: String(cell.week + 1), gridRow: String(cell.weekday + 1) }"
                :aria-label="cell.level === LEVEL_OUT ? undefined : cellTitle(cell)"
                :aria-hidden="cell.level === LEVEL_OUT ? 'true' : undefined"
                @mouseenter="showTip(cell, $event)"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="tn-heatmap-footer">
        <div class="tn-heatmap-detail">
          <span class="tn-heatmap-year-done">
            {{ activeYear }} 年累计完成 <strong>{{ yearStats.total }}</strong> 篇<template
              v-if="yearStats.net"
            >
              · 本年
              <span :class="deltaClass(yearStats.net)"
                >{{ yearStats.net > 0 ? '+' : '' }}{{ yearStats.net }}</span
              ></template
            >
          </span>
        </div>
        <div class="tn-heatmap-legend">
          <span>少</span>
          <i class="tn-heatmap-swatch l0" />
          <i class="tn-heatmap-swatch l1" />
          <i class="tn-heatmap-swatch l2" />
          <i class="tn-heatmap-swatch l3" />
          <i class="tn-heatmap-swatch l4" />
          <span>多</span>
        </div>
      </div>

      <div
        v-if="tip"
        class="tn-heatmap-tooltip"
        role="tooltip"
        :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
      >
        <div>{{ tip.cell.date }} · {{ tip.cell.commits }} 次提交</div>
        <div v-if="tip.cell.recorded" class="tn-heatmap-tooltip-sub">
          <span :class="deltaClass(tip.cell.delta)">{{ deltaText(tip.cell.delta) }}</span>
          · 累计 {{ tip.cell.total }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

export interface DayStat {
  delta: number
  total: number
  /** 当天 commit 数（tnotes.stats.json v2）；着色依据 */
  commits?: number
}

export type ByYear = Record<string, Record<string, Record<string, DayStat>>>

const props = defineProps<{
  byYear: ByYear
  title?: string
}>()

/** 年外补位格（不显示） */
const LEVEL_OUT = -99

interface Cell {
  date: string
  year: number
  month: number
  day: number
  delta: number
  total: number
  commits: number
  /** 当天是否有统计记录 */
  recorded: boolean
  week: number
  weekday: number
  /** LEVEL_OUT 年外；0 空；1..4 绿（按 commits） */
  level: number
}

const years = computed(() => Object.keys(props.byYear || {}).sort())
const yearsDesc = computed(() => [...years.value].reverse())
const activeYear = ref<string>('')
watch(
  years,
  (list) => {
    if (!list.length) {
      activeYear.value = ''
      return
    }
    if (!list.includes(activeYear.value)) {
      activeYear.value = list[list.length - 1]
    }
  },
  { immediate: true }
)

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtDate(dt: Date): string {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
}

/** 周一 = 0 … 周日 = 6 */
function mondayIndex(dt: Date): number {
  return (dt.getDay() + 6) % 7
}

function flatten(byYear: ByYear): Cell[] {
  const out: Cell[] = []
  for (const y of Object.keys(byYear || {})) {
    for (const m of Object.keys(byYear[y] || {})) {
      for (const d of Object.keys(byYear[y][m] || {})) {
        const stat = byYear[y][m][d]
        const dt = new Date(Number(y), Number(m) - 1, Number(d))
        out.push({
          date: fmtDate(dt),
          year: dt.getFullYear(),
          month: dt.getMonth() + 1,
          day: dt.getDate(),
          delta: Number(stat?.delta) || 0,
          total: Number(stat?.total) || 0,
          commits: Number(stat?.commits) || 0,
          recorded: true,
          week: 0,
          weekday: mondayIndex(dt),
          level: 0
        })
      }
    }
  }
  return out
}

const cells = computed(() => flatten(props.byYear || {}))

/**
 * 强度分档：按当天 commit 数对数分档 → 1..4（绿）。
 */
function levelFor(commits: number, max: number): number {
  if (commits <= 0 || max <= 0) return 0
  // 刻度下限取 4，避免全年最大值很小（如只有 1）时所有格子直接顶到最深档
  const ratio = Math.min(1, Math.log1p(commits) / Math.log1p(Math.max(max, 4)))
  return Math.min(4, Math.max(1, Math.ceil(ratio * 4)))
}

const yearStats = computed(() => {
  const y = Number(activeYear.value)
  const list = cells.value.filter((c) => c.year === y)
  let commits = 0
  let maxCommits = 0
  let net = 0
  let total = 0
  let lastDate = ''
  for (const c of list) {
    commits += c.commits
    net += c.delta
    maxCommits = Math.max(maxCommits, c.commits)
    if (c.date > lastDate) {
      lastDate = c.date
      total = c.total
    }
  }
  // total：该年最后一个有记录日的累计完成数；net：该年净增
  return { byDate: new Map(list.map((c) => [c.date, c])), commits, maxCommits, total, net }
})

const yearCells = computed<Cell[]>(() => {
  const y = Number(activeYear.value)
  if (!y) return []
  const first = new Date(y, 0, 1)
  const last = new Date(y, 11, 31)
  // 网格从 1/1 所在周的周一开始，到 12/31 所在周的周日结束（周一为每列第一行）
  const cursor = new Date(first)
  cursor.setDate(first.getDate() - mondayIndex(first))
  const gridEnd = new Date(last)
  gridEnd.setDate(last.getDate() + (6 - mondayIndex(last)))

  const { byDate, maxCommits } = yearStats.value
  const out: Cell[] = []
  let week = 0
  while (cursor <= gridEnd) {
    const date = fmtDate(cursor)
    const weekday = mondayIndex(cursor)
    const inYear = cursor.getFullYear() === y
    const hit = inYear ? byDate.get(date) : undefined
    out.push({
      date,
      year: cursor.getFullYear(),
      month: cursor.getMonth() + 1,
      day: cursor.getDate(),
      delta: hit?.delta ?? 0,
      total: hit?.total ?? 0,
      commits: hit?.commits ?? 0,
      recorded: Boolean(hit),
      week,
      weekday,
      level: !inYear ? LEVEL_OUT : hit ? levelFor(hit.commits, maxCommits) : 0
    })
    if (weekday === 6) week += 1
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
})

const weekCount = computed(() => Math.max(...yearCells.value.map((c) => c.week + 1), 1))

/** 与 GitHub 一样只标隔行（周一为首行：一、三、五、日） */
const weekdayLabels = ['一', '', '三', '', '五', '', '日']

function colOffset(col: number): string {
  return `calc(${col} * (var(--tn-hm-cell) + var(--tn-hm-gap)))`
}

const gridWidth = computed(
  () => `calc(${weekCount.value} * (var(--tn-hm-cell) + var(--tn-hm-gap)) - var(--tn-hm-gap))`
)

/**
 * 月份标签：落在该月 1 号所在列（1 号在周五及以后时顺延一列，和 GitHub 一样让标签对齐“整周”），
 * 与上一个标签相距不足 3 列时丢弃上一个，避免文字重叠。
 */
const monthLabels = computed(() => {
  const y = Number(activeYear.value)
  if (!y) return []
  const byDate = new Map(yearCells.value.map((c) => [c.date, c]))
  const labels: Array<{ month: number; text: string; col: number }> = []
  for (let m = 1; m <= 12; m++) {
    const cell = byDate.get(`${y}-${pad2(m)}-01`)
    if (!cell) continue
    const col = cell.weekday >= 4 && m !== 1 ? cell.week + 1 : cell.week
    const prev = labels[labels.length - 1]
    if (prev && col - prev.col < 3) labels.pop()
    labels.push({ month: m, text: `${m}月`, col })
  }
  return labels
})

function levelClass(level: number): string {
  if (level === LEVEL_OUT) return 'out'
  if (level > 0) return `l${level}`
  return 'l0'
}

function deltaText(delta: number): string {
  if (delta > 0) return `完成 +${delta}`
  if (delta < 0) return `回退 ${delta}`
  return '完成 ±0'
}

function deltaClass(delta: number): string {
  if (delta > 0) return 'tn-hm-pos'
  if (delta < 0) return 'tn-hm-neg'
  return ''
}

function cellTitle(cell: Cell): string {
  const head = `${cell.date} · ${cell.commits} 次提交`
  return cell.recorded ? `${head} · ${deltaText(cell.delta)} · 累计 ${cell.total}` : head
}

// ---- tooltip（GitHub 风格：悬浮在格子正上方） ----
const rootRef = ref<HTMLElement | null>(null)
const scrollRef = ref<HTMLElement | null>(null)
const tip = ref<{ cell: Cell; x: number; y: number } | null>(null)
function showTip(cell: Cell, ev: MouseEvent): void {
  const root = rootRef.value
  const target = ev.currentTarget as HTMLElement | null
  if (!root || !target || cell.level === LEVEL_OUT) {
    tip.value = null
    return
  }
  const r = target.getBoundingClientRect()
  const base = root.getBoundingClientRect()
  tip.value = {
    cell,
    x: r.left - base.left + r.width / 2,
    y: r.top - base.top - 6
  }
}

function hideTip(): void {
  tip.value = null
}

// 窄容器（如子库侧边栏）里横向滚动时，默认把最近有记录的那一列滚进视野
watch(
  [activeYear, yearCells],
  async () => {
    tip.value = null
    await nextTick()
    const el = scrollRef.value
    if (!el || el.scrollWidth <= el.clientWidth) return
    let lastWeek = 0
    for (const c of yearCells.value) if (c.recorded) lastWeek = c.week
    const cs = getComputedStyle(el)
    const pitch =
      (parseFloat(cs.getPropertyValue('--tn-hm-cell')) || 10) +
      (parseFloat(cs.getPropertyValue('--tn-hm-gap')) || 3)
    el.scrollLeft = Math.max(0, (lastWeek + 4) * pitch - el.clientWidth + 32)
  },
  { flush: 'post', immediate: true }
)
</script>

<style scoped>
.tn-heatmap {
  /* 尺寸：对齐 GitHub（10px 格 + 3px 间距） */
  --tn-hm-cell: 10px;
  --tn-hm-gap: 3px;
  --tn-hm-radius: 2px;
  --tn-hm-label-w: 22px;

  /* 文本 / 边框（兼容根库 --vp-* 与子库 SSG --tn-* 变量） */
  --tn-hm-text: var(--vp-c-text-1, var(--tn-c-text, #1f2328));
  --tn-hm-text-2: var(--vp-c-text-2, var(--tn-c-text-2, #59636e));
  --tn-hm-text-3: var(--vp-c-text-3, var(--tn-c-text-2, #8c959f));
  --tn-hm-divider: var(--vp-c-divider, var(--tn-c-divider, #d1d9e0));
  --tn-hm-bg: var(--vp-c-bg, var(--tn-c-bg, #ffffff));
  --tn-hm-bg-soft: var(--vp-c-bg-soft, var(--tn-c-bg-soft, #f6f8fa));
  --tn-hm-brand: var(--vp-c-brand, var(--tn-c-brand, #3451b2));

  /* GitHub light 色阶 */
  --tn-hm-l0: #ebedf0;
  --tn-hm-l1: #9be9a8;
  --tn-hm-l2: #40c463;
  --tn-hm-l3: #30a14e;
  --tn-hm-l4: #216e39;
  /* 回退（粉 / 浅红） */
  --tn-hm-n1: #ffd3dc;
  --tn-hm-n2: #ff9aac;
  --tn-hm-n3: #e5566f;
  --tn-hm-cell-outline: rgba(27, 31, 36, 0.06);
  --tn-hm-tip-bg: #24292f;
  --tn-hm-tip-fg: #ffffff;

  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--tn-glass-border, var(--tn-hm-divider));
  border-radius: 12px;
  background: color-mix(in srgb, var(--tn-hm-bg-soft) 70%, transparent);
  position: relative;
  min-width: 0;
}

/* GitHub dark 色阶；空格子比面板背景亮一档，避免黑底黑格 */
.dark .tn-heatmap,
:root[data-theme='dark'] .tn-heatmap {
  --tn-hm-l0: #2d333b;
  --tn-hm-l1: #0e4429;
  --tn-hm-l2: #006d32;
  --tn-hm-l3: #26a641;
  --tn-hm-l4: #39d353;
  --tn-hm-n1: #6b2a3a;
  --tn-hm-n2: #a3384f;
  --tn-hm-n3: #f0738b;
  --tn-hm-cell-outline: rgba(255, 255, 255, 0.04);
  --tn-hm-tip-bg: #6e7681;
  --tn-hm-tip-fg: #ffffff;
}
:root[data-theme='light'] .tn-heatmap {
  --tn-hm-l0: #ebedf0;
  --tn-hm-l1: #9be9a8;
  --tn-hm-l2: #40c463;
  --tn-hm-l3: #30a14e;
  --tn-hm-l4: #216e39;
  --tn-hm-n1: #ffd3dc;
  --tn-hm-n2: #ff9aac;
  --tn-hm-n3: #e5566f;
  --tn-hm-cell-outline: rgba(27, 31, 36, 0.06);
  --tn-hm-tip-bg: #24292f;
}

.tn-heatmap-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.tn-heatmap-total {
  font-size: 12px;
  color: var(--tn-hm-text-2);
}
.tn-heatmap-total strong {
  color: var(--tn-hm-text);
  font-weight: 600;
}
.tn-heatmap-year-select {
  margin-left: auto;
  border: 1px solid var(--tn-hm-divider);
  color: var(--tn-hm-text-2);
  border-radius: 6px;
  /* 自绘箭头：原生箭头贴边，改为 appearance:none + 右侧留白 */
  appearance: none;
  -webkit-appearance: none;
  background-color: var(--tn-hm-bg);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238c959f' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px 6px;
  padding: 2px 24px 2px 8px;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.tn-heatmap-year-select:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--tn-hm-brand) 50%, transparent);
  outline-offset: 1px;
}

/* ---- 网格 ---- */
/* 面板宽度跟随图本身（像 GitHub 一样让图例贴着图的右边缘），窄容器里再横向滚动 */
.tn-heatmap-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: max-content;
  max-width: 100%;
}
.tn-heatmap-scroll {
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 2px;
  scrollbar-width: thin;
}
.tn-heatmap-graph {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  font-size: 10px;
  line-height: 1;
  color: var(--tn-hm-text-2);
}
.tn-heatmap-months {
  position: relative;
  height: 12px;
  margin-left: calc(var(--tn-hm-label-w) + var(--tn-hm-gap));
}
.tn-heatmap-months span {
  position: absolute;
  top: 0;
  white-space: nowrap;
}
.tn-heatmap-body {
  display: flex;
  gap: var(--tn-hm-gap);
}
.tn-heatmap-weekdays {
  width: var(--tn-hm-label-w);
  flex: none;
  display: grid;
  grid-template-rows: repeat(7, var(--tn-hm-cell));
  row-gap: var(--tn-hm-gap);
}
.tn-heatmap-weekdays span {
  font-size: 9px;
  line-height: var(--tn-hm-cell);
  height: var(--tn-hm-cell);
  overflow: visible;
  white-space: nowrap;
}
.tn-heatmap-cells {
  display: grid;
  grid-template-rows: repeat(7, var(--tn-hm-cell));
  gap: var(--tn-hm-gap);
}
.tn-heatmap-cell,
.tn-heatmap-swatch {
  display: block;
  width: var(--tn-hm-cell);
  height: var(--tn-hm-cell);
  border-radius: var(--tn-hm-radius);
  outline: 1px solid var(--tn-hm-cell-outline);
  outline-offset: -1px;
  background: var(--tn-hm-l0);
}
.tn-heatmap-cell:hover {
  outline: 1px solid var(--tn-hm-text-2);
  outline-offset: -1px;
}
.tn-heatmap-cell.out {
  visibility: hidden;
}
.l0 {
  background: var(--tn-hm-l0);
}
.l1 {
  background: var(--tn-hm-l1);
}
.l2 {
  background: var(--tn-hm-l2);
}
.l3 {
  background: var(--tn-hm-l3);
}
.l4 {
  background: var(--tn-hm-l4);
}
/* 详情中的完成数：正 → 绿，负（回退）→ 粉 */
.tn-hm-pos {
  color: var(--tn-hm-l3);
}
.tn-hm-neg {
  color: var(--tn-hm-n3);
}

/* ---- 底栏：左侧当年完成汇总（静态），右侧图例（少 → 多） ---- */
.tn-heatmap-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 16px;
  font-size: 11px;
  color: var(--tn-hm-text-2);
}
.tn-heatmap-detail {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  min-height: 14px;
  color: var(--tn-hm-text-2);
}
.tn-heatmap-year-done strong {
  color: var(--tn-hm-text);
  font-weight: 600;
}
.tn-heatmap-legend {
  display: inline-flex;
  align-items: center;
  gap: var(--tn-hm-gap);
  line-height: 1;
}
.tn-heatmap-legend > span:first-child {
  margin-right: 2px;
}
.tn-heatmap-legend > span:nth-of-type(2) {
  margin-left: 2px;
}
.tn-heatmap-tooltip {
  position: absolute;
  z-index: 10;
  transform: translate(-50%, -100%);
  pointer-events: none;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.4;
  color: var(--tn-hm-tip-fg);
  background: var(--tn-hm-tip-bg);
  border-radius: 6px;
  padding: 4px 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
.tn-heatmap-tooltip-sub {
  font-size: 11px;
  opacity: 0.9;
}
/* tooltip 深底上用更亮的粉 / 绿 */
.tn-heatmap-tooltip .tn-hm-neg {
  color: #ff9aac;
}
.tn-heatmap-tooltip .tn-hm-pos {
  color: #7ee2a0;
}
.tn-heatmap-tooltip::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -4px;
  width: 8px;
  height: 8px;
  background: inherit;
  transform: translateX(-50%) rotate(45deg);
}
</style>
