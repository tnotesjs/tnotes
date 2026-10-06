/**
 * Completion statistics from TOC.md git history.
 *
 * Writes derived data to `tnotes.stats.json` (byYear → month → day → {delta,total,commits}).
 * `commits` = commits authored that day (heatmap colour); delta/total = TOC completion.
 * `tnotes.json` only keeps `stats.enabled`; old monthly `completedNotesCount` is wiped on update.
 *
 * Sampling: commits that touched TOC.md, keeping the last commit per natural day.
 * Default path is incremental from `sourceCommit`; `--rebuild-stats` forces a full rebuild.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from './atomic'
import { CONFIG_FILE, STATS_FILE, TOC_FILE } from './constants'
import { KbError } from './errors'
import {
  isCommitInHistory,
  isGitRepository,
  listCommitsAfter,
  listCommitsOldestFirst,
  listFileCommitsAfter,
  listFileCommitsOldestFirst,
  listRootCommits,
  readFileAtCommit,
  readHeadCommit,
  type GitCommitMeta
} from './git'
import { readKbConfig } from './scanner'
import { parseTocLine } from './toc'

import type { KbConfig, KbStats, MutationResult } from './types'

/** Parse completed note indexes from a TOC.md body (dedupe by index). */
export function parseCompletedNoteIndexes(tocContent: string): Set<string> {
  const indexes = new Set<string>()
  for (const line of tocContent.split('\n')) {
    const parsed = parseTocLine(line)
    if (parsed.kind !== 'note' || !parsed.noteIndex || !parsed.done) continue
    indexes.add(parsed.noteIndex)
  }
  return indexes
}

export function toMonthKey(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${yy}.${mm}`
}

export interface DayStat {
  /** Net change in completed notes vs the previous recorded day (may be negative). */
  delta: number
  /** Cumulative completed notes at end of day. */
  total: number
  /** Number of commits authored that day (any file) — drives heatmap colour ("update heat"). */
  commits?: number
}

/**
 * `tnotes.stats.json` on-disk shape.
 * v2 adds `commits` per day; v1 files are rebuilt in full on the next update.
 */
export const STATS_FILE_VERSION = 2

export interface KbStatsFile {
  version: 2
  sourceCommit: string
  byYear: Record<string, Record<string, Record<string, DayStat>>>
}

export interface StatsUpdateResult {
  stats: KbStatsFile
  /** Monthly cumulative totals derived from the last day of each month (compat). */
  completedNotesCount: Record<string, number>
  commitsScanned: number
  rebuilt: boolean
  skipped: boolean
}

function parseMonthKey(key: string): { year: number; month: number } | null {
  const match = /^(\d{2})\.(\d{2})$/.exec(key)
  if (!match) return null
  const year = 2000 + Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return null
  return { year, month }
}

/** Inclusive month range from `fromKey` through `toKey`. */
export function enumerateMonthKeys(fromKey: string, toKey: string): string[] {
  const from = parseMonthKey(fromKey)
  const to = parseMonthKey(toKey)
  if (!from || !to) return []
  const keys: string[] = []
  let y = from.year
  let m = from.month
  while (y < to.year || (y === to.year && m <= to.month)) {
    keys.push(`${String(y).slice(-2)}.${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return keys
}

/**
 * Fill gaps between birth and current month; carry forward the last known count.
 * Kept for tests / callers that still want a dense monthly map.
 */
export function fillCompletedNotesCount(
  snapshots: Record<string, number>,
  birthKey: string,
  currentKey: string
): Record<string, number> {
  const months = enumerateMonthKeys(birthKey, currentKey)
  const result: Record<string, number> = {}
  let prev = 0
  for (const key of months) {
    if (Object.prototype.hasOwnProperty.call(snapshots, key)) {
      prev = snapshots[key]
    }
    result[key] = prev
  }
  return result
}

function dayParts(date: Date): { year: string; month: string; day: string; key: string } {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return { year, month, day, key: `${year}-${month}-${day}` }
}

function commitDayKey(commit: GitCommitMeta): string {
  return dayParts(new Date(commit.authorDate || Date.now())).key
}

/** Keep the last commit of each natural day (local timezone of authorDate). */
export function lastCommitPerDay(commits: GitCommitMeta[]): GitCommitMeta[] {
  const byDay = new Map<string, GitCommitMeta>()
  for (const commit of commits) {
    byDay.set(commitDayKey(commit), commit)
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, commit]) => commit)
}

/** Count commits per natural day (`YYYY-MM-DD` → n). */
export function countCommitsPerDay(commits: GitCommitMeta[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const commit of commits) {
    const key = commitDayKey(commit)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function emptyStatsFile(sourceCommit = ''): KbStatsFile {
  return { version: STATS_FILE_VERSION, sourceCommit, byYear: {} }
}

/** Read `tnotes.stats.json`. Older versions are returned as-is so callers can decide to rebuild. */
export async function readStatsFile(
  rootPath: string
): Promise<(Omit<KbStatsFile, 'version'> & { version: number }) | null> {
  try {
    const raw = await fs.readFile(path.join(rootPath, STATS_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { version?: number; sourceCommit?: unknown; byYear?: unknown }
    if (typeof parsed?.version !== 'number' || typeof parsed.byYear !== 'object' || !parsed.byYear) {
      return null
    }
    return {
      version: parsed.version,
      sourceCommit: typeof parsed.sourceCommit === 'string' ? parsed.sourceCommit : '',
      byYear: parsed.byYear as KbStatsFile['byYear']
    }
  } catch {
    return null
  }
}

export async function writeStatsFile(rootPath: string, stats: KbStatsFile): Promise<void> {
  await writeFileAtomic(
    path.join(rootPath, STATS_FILE),
    `${JSON.stringify(stats, null, 2)}\n`
  )
}

export interface DayRow {
  year: string
  month: string
  day: string
  delta: number
  total: number
  commits: number
}

/** Flatten byYear into chronological day samples. */
export function flattenDayStats(byYear: KbStatsFile['byYear']): DayRow[] {
  const rows: DayRow[] = []
  for (const year of Object.keys(byYear).sort()) {
    const months = byYear[year] ?? {}
    for (const month of Object.keys(months).sort()) {
      const days = months[month] ?? {}
      for (const day of Object.keys(days).sort()) {
        const cell = days[day]
        rows.push({
          year,
          month,
          day,
          delta: cell.delta,
          total: cell.total,
          commits: Number(cell.commits) || 0
        })
      }
    }
  }
  return rows
}

/** Last recorded total in byYear, or 0. */
export function latestTotal(byYear: KbStatsFile['byYear']): number {
  const rows = flattenDayStats(byYear)
  return rows.length > 0 ? rows[rows.length - 1].total : 0
}

/**
 * Derive dense monthly cumulative map (YY.MM → total) from byYear for root collect / legacy UIs.
 * Uses the last day of each month that has a sample; fills forward through current month.
 */
export function monthlyTotalsFromByYear(
  byYear: KbStatsFile['byYear'],
  birthKey: string,
  currentKey: string
): Record<string, number> {
  const snapshots: Record<string, number> = {}
  for (const row of flattenDayStats(byYear)) {
    const yy = row.year.slice(-2)
    const key = `${yy}.${row.month}`
    snapshots[key] = row.total
  }
  if (!Object.prototype.hasOwnProperty.call(snapshots, birthKey)) {
    snapshots[birthKey] = 0
  }
  return fillCompletedNotesCount(snapshots, birthKey, currentKey)
}

/**
 * Build sparse byYear from per-day TOC totals + per-day commit counts.
 * Days with commits but no TOC sample carry the previous total (delta 0).
 * delta is always recomputed as total − previous day's total.
 */
export function buildByYear(
  dayTotals: Map<string, number>,
  dayCommits: Map<string, number>
): KbStatsFile['byYear'] {
  const keys = [...new Set([...dayTotals.keys(), ...dayCommits.keys()])].sort()
  const byYear: KbStatsFile['byYear'] = {}
  let prev = 0
  for (const key of keys) {
    const total = dayTotals.has(key) ? (dayTotals.get(key) as number) : prev
    const [year, month, day] = key.split('-')
    byYear[year] ??= {}
    byYear[year][month] ??= {}
    byYear[year][month][day] = { delta: total - prev, total, commits: dayCommits.get(key) ?? 0 }
    prev = total
  }
  return byYear
}

async function sampleDayTotals(
  rootPath: string,
  commits: GitCommitMeta[]
): Promise<Map<string, number>> {
  const totals = new Map<string, number>()
  for (const commit of lastCommitPerDay(commits)) {
    const toc = await readFileAtCommit(rootPath, commit.hash, TOC_FILE)
    if (toc == null) continue
    totals.set(commitDayKey(commit), parseCompletedNoteIndexes(toc).size)
  }
  return totals
}

async function monthKeys(rootPath: string): Promise<{ birthKey: string; currentKey: string }> {
  const roots = await listRootCommits(rootPath)
  return {
    birthKey: toMonthKey(new Date(roots[0]?.authorDate || Date.now())),
    currentKey: toMonthKey(new Date())
  }
}

async function computeFullStats(rootPath: string, head: string): Promise<StatsUpdateResult> {
  const roots = await listRootCommits(rootPath)
  if (roots.length === 0) {
    throw new KbError('INVALID_OPERATION', '无法确定知识库首次 commit')
  }
  const { birthKey, currentKey } = await monthKeys(rootPath)

  const [tocCommits, allCommits] = await Promise.all([
    listFileCommitsOldestFirst(rootPath, TOC_FILE),
    listCommitsOldestFirst(rootPath)
  ])
  const dayTotals = await sampleDayTotals(rootPath, tocCommits)
  const dayCommits = countCommitsPerDay(allCommits)
  const byYear = buildByYear(dayTotals, dayCommits)

  const stats: KbStatsFile = { version: STATS_FILE_VERSION, sourceCommit: head, byYear }
  return {
    stats,
    completedNotesCount: monthlyTotalsFromByYear(byYear, birthKey, currentKey),
    commitsScanned: allCommits.length,
    rebuilt: true,
    skipped: false
  }
}

async function computeIncrementalStats(
  rootPath: string,
  existing: KbStatsFile,
  head: string
): Promise<StatsUpdateResult> {
  const { birthKey, currentKey } = await monthKeys(rootPath)
  if (existing.sourceCommit === head) {
    return {
      stats: existing,
      completedNotesCount: monthlyTotalsFromByYear(existing.byYear, birthKey, currentKey),
      commitsScanned: 0,
      rebuilt: false,
      skipped: true
    }
  }

  if (!(await isCommitInHistory(rootPath, existing.sourceCommit))) {
    return computeFullStats(rootPath, head)
  }

  const [newTocCommits, newCommits] = await Promise.all([
    listFileCommitsAfter(rootPath, existing.sourceCommit, TOC_FILE),
    listCommitsAfter(rootPath, existing.sourceCommit)
  ])

  const dayTotals = new Map<string, number>()
  const dayCommits = new Map<string, number>()
  for (const row of flattenDayStats(existing.byYear)) {
    const key = `${row.year}-${row.month}-${row.day}`
    dayTotals.set(key, row.total)
    dayCommits.set(key, row.commits)
  }
  for (const [key, total] of await sampleDayTotals(rootPath, newTocCommits)) {
    dayTotals.set(key, total)
  }
  for (const [key, n] of countCommitsPerDay(newCommits)) {
    dayCommits.set(key, (dayCommits.get(key) ?? 0) + n)
  }
  const byYear = buildByYear(dayTotals, dayCommits)

  const stats: KbStatsFile = { version: STATS_FILE_VERSION, sourceCommit: head, byYear }
  return {
    stats,
    completedNotesCount: monthlyTotalsFromByYear(byYear, birthKey, currentKey),
    commitsScanned: newCommits.length,
    rebuilt: false,
    skipped: false
  }
}

/**
 * Compute stats into memory. Does not write files.
 * @param rebuild force full rebuild (ignore existing sourceCommit)
 */
export async function computeStatsFile(
  rootPath: string,
  options: { rebuild?: boolean } = {}
): Promise<StatsUpdateResult> {
  if (!(await isGitRepository(rootPath))) {
    throw new KbError('INVALID_OPERATION', '当前目录不是 Git 仓库，无法更新完成趋势统计')
  }
  const head = await readHeadCommit(rootPath)
  if (!head) {
    throw new KbError('INVALID_OPERATION', '无法读取 HEAD commit')
  }

  if (!options.rebuild) {
    const existing = await readStatsFile(rootPath)
    // v1 files have no per-day `commits`; rebuild once to backfill.
    if (existing?.sourceCommit && existing.version === STATS_FILE_VERSION) {
      return computeIncrementalStats(rootPath, existing as KbStatsFile, head)
    }
  }
  return computeFullStats(rootPath, head)
}

/**
 * Legacy helper: monthly map only (used by older tests). Prefer `computeStatsFile`.
 */
export async function computeCompletedNotesCount(rootPath: string): Promise<{
  completedNotesCount: Record<string, number>
  birthMonth: string
  currentMonth: string
  commitsScanned: number
}> {
  const computed = await computeStatsFile(rootPath, { rebuild: true })
  const roots = await listRootCommits(rootPath)
  const birthMonth = toMonthKey(new Date(roots[0]?.authorDate || Date.now()))
  const currentMonth = toMonthKey(new Date())
  return {
    completedNotesCount: computed.completedNotesCount,
    birthMonth,
    currentMonth,
    commitsScanned: computed.commitsScanned
  }
}

export interface UpdateStatsOptions {
  rebuild?: boolean
}

/**
 * Update `tnotes.stats.json` when `stats.enabled` is true.
 * Wipes `stats.completedNotesCount` from `tnotes.json`, keeping only `enabled`.
 */
export async function updateCompletedNotesStats(
  rootPath: string,
  options: UpdateStatsOptions = {}
): Promise<MutationResult<KbStats>> {
  const { config } = await readKbConfig(rootPath)
  if (!config.stats?.enabled) {
    throw new KbError('INVALID_OPERATION', '完成趋势统计未开启（tnotes.json → stats.enabled）')
  }

  const computed = await computeStatsFile(rootPath, { rebuild: options.rebuild })
  if (!computed.skipped) {
    await writeStatsFile(rootPath, computed.stats)
  }

  // Wipe legacy monthly blob from tnotes.json; keep enabled (+ other unknown stats keys except completedNotesCount).
  const prevStats = config.stats ?? {}
  const nextStats: KbStats = { enabled: true }
  for (const [key, value] of Object.entries(prevStats)) {
    if (key === 'completedNotesCount') continue
    if (key === 'enabled') continue
    nextStats[key as keyof KbStats] = value as never
  }
  nextStats.enabled = true

  const nextConfig: KbConfig = { ...config, stats: nextStats }
  const changedFiles: MutationResult<KbStats>['changedFiles'] = []

  const configNeedsWrite =
    JSON.stringify(config.stats ?? null) !== JSON.stringify(nextStats)
  if (configNeedsWrite) {
    await writeFileAtomic(
      path.join(rootPath, CONFIG_FILE),
      `${JSON.stringify(nextConfig, null, 2)}\n`
    )
    changedFiles.push({ path: CONFIG_FILE, kind: 'updated' })
  }
  if (!computed.skipped) {
    changedFiles.push({ path: STATS_FILE, kind: 'updated' })
  }

  // Expose derived monthly map on the return value for CLI / transitional callers
  // without writing it back into tnotes.json.
  return {
    value: {
      ...nextStats,
      completedNotesCount: computed.completedNotesCount
    },
    changedFiles
  }
}
