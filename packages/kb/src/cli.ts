/**
 * tnotes-kb — knowledge-base maintenance CLI.
 *
 * Commands:
 *   update   Refresh completion stats from TOC.md git history
 *   push     Optional update → add/commit/push
 *   pull     Thin fetch + ff-only pull (fails clearly on conflict)
 *   init     Create a minimal knowledge base under the current (or given) parent
 */

import path from 'node:path'

import { createKnowledgeBase } from './create'
import {
  DEFAULT_PUSH_COMMIT_MESSAGE,
  pullKnowledgeBase,
  pushKnowledgeBase
} from './sync'
import { createWorkspace } from './workspace'

function printHelp(): void {
  console.log(`用法:
  tnotes-kb update [知识库目录] [--rebuild-stats]
  tnotes-kb push [知识库目录] [--no-update]
  tnotes-kb pull [知识库目录]
  tnotes-kb init <文件夹名> [选项]

选项:
  --title <显示名称>
  --parent <父目录>          默认当前工作目录
  --package-json             写入 package.json（CLI / 本地构建）
  --github-pages             写入 deploy.yml（并附带 package.json）
  --readme                   写入根 README.md
  --git-init                 在知识库目录执行 git init
  --no-update                push 时跳过推送前 update（覆盖 tnotes.json）
  --rebuild-stats            update 时全量重建 tnotes.stats.json（见待办 10）

说明:
  update  根据 Git 中 TOC.md 历史写入 tnotes.stats.json（需 stats.enabled）；
          并清除 tnotes.json 中旧的 stats.completedNotesCount。
  push    按 tnotes.json → push.runUpdateBefore（默认 true）可选先 update，
          再 git add . / commit（「${DEFAULT_PUSH_COMMIT_MESSAGE}」）/ push。
  pull    fetch + pull --ff-only；冲突或无法快进时失败。
  init    创建最小知识库（tnotes.json / TOC.md / notes/0001. 开始使用.md）。
`)
}

function resolveTargetDir(args: string[]): string {
  const targetArg = args.find((arg) => !arg.startsWith('--')) ?? process.cwd()
  return path.resolve(targetArg)
}

async function runUpdate(rootPath: string, rebuildStats: boolean): Promise<void> {
  const ws = createWorkspace({ rootPath })
  const { value, changedFiles } = await ws.stats.update({ rebuild: rebuildStats })
  const counts = value.completedNotesCount ?? {}
  const keys = Object.keys(counts).sort()
  const latest = keys[keys.length - 1]
  const files = changedFiles.map((f) => f.path).join('、') || '无变更'
  console.log(
    `完成趋势已更新: ${keys.length} 个月` +
      (latest ? `，当前 ${latest} = ${counts[latest]}` : '') +
      (rebuildStats ? '（全量重建）' : '') +
      `；写入 ${files}`
  )
}

async function runPush(rootPath: string, noUpdate: boolean): Promise<void> {
  const result = await pushKnowledgeBase(rootPath, {
    runUpdateBefore: noUpdate ? false : undefined
  })
  const bits = [
    result.updated ? '已 update' : null,
    result.committed ? '已 commit' : null,
    result.pushed ? '已 push' : null
  ].filter(Boolean)
  console.log(result.message + (bits.length ? `（${bits.join('，')}）` : ''))
}

async function runPull(rootPath: string): Promise<void> {
  const result = await pullKnowledgeBase(rootPath)
  console.log(result.message)
  if (!result.ok) process.exit(1)
}

async function runInit(args: string[]): Promise<void> {
  let folderName = ''
  let title: string | undefined
  let parentDir = process.cwd()
  const options = {
    packageJson: false,
    githubPages: false,
    readme: false,
    gitInit: false
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--title') {
      title = args[++i]
      continue
    }
    if (arg === '--parent') {
      parentDir = path.resolve(args[++i] ?? process.cwd())
      continue
    }
    if (arg === '--package-json') {
      options.packageJson = true
      continue
    }
    if (arg === '--github-pages') {
      options.githubPages = true
      continue
    }
    if (arg === '--readme') {
      options.readme = true
      continue
    }
    if (arg === '--git-init') {
      options.gitInit = true
      continue
    }
    if (arg.startsWith('-')) {
      console.error(`未知参数: ${arg}`)
      printHelp()
      process.exit(1)
    }
    if (!folderName) {
      folderName = arg
      continue
    }
    console.error(`多余参数: ${arg}`)
    printHelp()
    process.exit(1)
  }

  if (!folderName) {
    console.error('缺少文件夹名')
    printHelp()
    process.exit(1)
  }

  const result = await createKnowledgeBase({ parentDir, folderName, title, options })
  console.log(`已创建知识库: ${result.rootPath}`)
  console.log(`  配置: tnotes.json (name=${result.config.name}, title=${result.config.title})`)
  console.log(`  引导笔记: ${result.starterNoteRelPath}`)
  if (result.extras.length > 0) {
    console.log(`  可选文件: ${result.extras.join('、')}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === '--help' || command === '-h') {
    printHelp()
    process.exit(command ? 0 : 1)
  }

  if (command === 'update') {
    const rest = args.slice(1)
    const rebuildStats = rest.includes('--rebuild-stats')
    await runUpdate(resolveTargetDir(rest), rebuildStats)
    return
  }

  if (command === 'push') {
    const rest = args.slice(1)
    const noUpdate = rest.includes('--no-update')
    await runPush(resolveTargetDir(rest), noUpdate)
    return
  }

  if (command === 'pull') {
    await runPull(resolveTargetDir(args.slice(1)))
    return
  }

  if (command === 'init') {
    await runInit(args.slice(1))
    return
  }

  console.error(`未知命令: ${command}`)
  printHelp()
  process.exit(1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
