/**
 * 侧栏头部的资源 / 实验入口用的目录探测。
 *
 * 只看知识库根下的 `assets/`、`demos/` 在不在，以及 `demos/` 的直属子文件夹。
 * 合规实验文件夹是 `0001. 名称`：恰好四位数字、一个「. 」、然后是名称。
 * 直属文件、不合规文件夹、更深层的目录都不算。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { KbDemoEntryDto, SidebarExtrasDto } from '../shared/contracts'

/** 恰好四位数字，接着「. 」和一个非空名称 */
export const DEMO_FOLDER_PATTERN = /^(\d{4})\. (.+)$/

export function selectDemoFolders(folderNames: readonly string[]): KbDemoEntryDto[] {
  const entries: KbDemoEntryDto[] = []
  for (const folder of folderNames) {
    if (folder.includes('/') || folder.includes('\\')) continue
    const match = DEMO_FOLDER_PATTERN.exec(folder)
    if (!match) continue
    entries.push({ index: match[1], title: match[2], folder })
  }
  entries.sort(
    (a, b) => Number(a.index) - Number(b.index) || a.folder.localeCompare(b.folder, 'zh')
  )
  return entries
}

async function isDirectory(absolute: string): Promise<boolean> {
  try {
    return (await fs.stat(absolute)).isDirectory()
  } catch {
    return false
  }
}

export async function probeSidebarExtras(rootPath: string): Promise<SidebarExtrasDto> {
  const root = path.resolve(rootPath)
  const [hasAssets, hasDemos] = await Promise.all([
    isDirectory(path.join(root, 'assets')),
    isDirectory(path.join(root, 'demos'))
  ])
  return { hasAssets, hasDemos }
}

/** `demos/` 不存在时返回空列表（入口本身也不会渲染） */
export async function listDemoFolders(rootPath: string): Promise<KbDemoEntryDto[]> {
  const demos = path.resolve(rootPath, 'demos')
  let dirents
  try {
    dirents = await fs.readdir(demos, { withFileTypes: true })
  } catch {
    return []
  }
  const folders = dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name)
  return selectDemoFolders(folders)
}

/**
 * 解析要交给 IDE 的目录。`folder` 为空串表示整个 `demos/`；
 * 否则必须是合规文件夹名，且确实是 `demos/` 下的目录。
 */
export async function resolveDemoDirectory(rootPath: string, folder: string): Promise<string> {
  const root = path.resolve(rootPath)
  const demos = path.join(root, 'demos')
  if (folder === '') {
    if (!(await isDirectory(demos))) throw new Error('demos 目录不存在')
    return demos
  }
  if (
    folder.includes('/') ||
    folder.includes('\\') ||
    folder.includes('..') ||
    !DEMO_FOLDER_PATTERN.test(folder)
  ) {
    throw new Error('不是合规的实验目录')
  }
  const target = path.join(demos, folder)
  if (!(await isDirectory(target))) throw new Error(`实验目录不存在：${folder}`)
  return target
}
