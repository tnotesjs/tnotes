import fs from 'node:fs'
import path from 'node:path'

/** `demos/0001. 短标题/` — 序号 0001–9999，点号后有一个空格。 */
const DEMO_DIR_NAME = /^(\d{4})\. (.+)$/

export interface DemoCatalogEntry {
  id: string
  /** 文件夹名里序号后面的短标题。 */
  title: string
  /** `demos.json` 的 description；缺字段时为空字符串。 */
  description: string
  absolutePath: string
}

/**
 * 读 `demos/demos.json` 并扫一层 demo 文件夹。
 *
 * 一行要同时有文件夹和 json 键才算存在。json 没有 description 时简介为空，
 * 由表格显示「暂无简介」。文件读不到或不是对象时，目录为空（调用方把 id 都算未找到）。
 */
export function readDemoCatalog(rootPath: string): DemoCatalogEntry[] {
  const demosDir = path.join(rootPath, 'demos')
  let names: string[] = []
  try {
    names = fs
      .readdirSync(demosDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }

  let meta: Record<string, { description?: unknown } | undefined> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(demosDir, 'demos.json'), 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as typeof meta
    }
  } catch {
    meta = {}
  }

  const seen = new Set<string>()
  const entries: DemoCatalogEntry[] = []
  for (const name of names) {
    const match = DEMO_DIR_NAME.exec(name)
    if (!match) continue
    const id = match[1]
    if (id === '0000' || seen.has(id) || !Object.prototype.hasOwnProperty.call(meta, id)) continue
    seen.add(id)
    const description = meta[id]?.description
    entries.push({
      id,
      title: match[2].trim(),
      description: typeof description === 'string' ? description : '',
      absolutePath: path.join(demosDir, name)
    })
  }
  return entries
}

export function resolveDemoIds(
  entries: readonly DemoCatalogEntry[],
  ids: string[]
): { demos: DemoCatalogEntry[]; missingIds: string[] } {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const demos: DemoCatalogEntry[] = []
  const missingIds: string[] = []
  for (const id of ids) {
    const entry = byId.get(id)
    if (!entry) missingIds.push(id)
    else demos.push(entry)
  }
  return { demos, missingIds }
}
