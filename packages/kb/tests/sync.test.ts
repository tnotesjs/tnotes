import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PUSH_COMMIT_MESSAGE,
  PULL_CONFLICT_USER_MESSAGE,
  buildPullConflictAgentPrompt,
  pullKnowledgeBase,
  pushKnowledgeBase,
  shouldRunUpdateBeforePush
} from '../src/sync'

const execFileAsync = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

/** Per-test fixtures — never share module-level dirs (CI workers race on them). */
async function setupRepo(): Promise<{ root: string; remote: string; remoteUrl: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-kb-sync-'))
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-kb-sync-remote-'))
  const remoteUrl = `file://${remote}`
  await execFileAsync('git', ['init', '--bare'], { cwd: remote })

  await git(['init'], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await git(['config', 'protocol.file.allow', 'always'], root)
  await write(
    root,
    'tnotes.json',
    JSON.stringify(
      {
        name: 'TNotes.test-sync',
        title: 'sync-test',
        stats: { enabled: false },
        push: { runUpdateBefore: true }
      },
      null,
      2
    )
  )
  await write(root, 'TOC.md', '- [ ] 0001. hello\n')
  await write(root, 'notes/0001. hello.md', '---\nid: note-1\n---\n\nbody\n')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'init'], root)
  await git(['branch', '-M', 'main'], root)
  await git(['remote', 'add', 'origin', remoteUrl], root)
  await git(['push', '-u', 'origin', 'main'], root)
  return { root, remote, remoteUrl }
}

async function cleanup(dirs: { root: string; remote: string }, other?: string): Promise<void> {
  await fs.rm(dirs.root, { recursive: true, force: true })
  await fs.rm(dirs.remote, { recursive: true, force: true })
  if (other) await fs.rm(other, { recursive: true, force: true })
}

describe('shouldRunUpdateBeforePush', () => {
  it('defaults to true and respects config / override', () => {
    expect(shouldRunUpdateBeforePush({})).toBe(true)
    expect(shouldRunUpdateBeforePush({ push: {} })).toBe(true)
    expect(shouldRunUpdateBeforePush({ push: { runUpdateBefore: false } })).toBe(false)
    expect(shouldRunUpdateBeforePush({ push: { runUpdateBefore: false } }, true)).toBe(true)
    expect(shouldRunUpdateBeforePush({}, false)).toBe(false)
  })
})

describe('pushKnowledgeBase', () => {
  it('commits with the short sentence and pushes', async () => {
    const dirs = await setupRepo()
    try {
      await write(dirs.root, 'notes/0001. hello.md', '---\nid: note-1\n---\n\nchanged\n')
      const result = await pushKnowledgeBase(dirs.root)
      expect(result.committed).toBe(true)
      expect(result.pushed).toBe(true)
      expect(result.commitMessage).toBe(DEFAULT_PUSH_COMMIT_MESSAGE)
      const log = await git(['log', '-1', '--pretty=%s'], dirs.root)
      expect(log).toBe(DEFAULT_PUSH_COMMIT_MESSAGE)
    } finally {
      await cleanup(dirs)
    }
  })

  it('reports nothing to do when clean', async () => {
    const dirs = await setupRepo()
    try {
      const result = await pushKnowledgeBase(dirs.root)
      expect(result.committed).toBe(false)
      expect(result.pushed).toBe(false)
      expect(result.message).toContain('没有需要')
    } finally {
      await cleanup(dirs)
    }
  })

  it('skips update when stats.enabled is false even if runUpdateBefore', async () => {
    const dirs = await setupRepo()
    try {
      await write(dirs.root, 'notes/0001. hello.md', '---\nid: note-1\n---\n\nagain\n')
      const result = await pushKnowledgeBase(dirs.root, { runUpdateBefore: true })
      expect(result.updated).toBe(false)
      expect(result.pushed).toBe(true)
    } finally {
      await cleanup(dirs)
    }
  })
})

describe('pullKnowledgeBase', () => {
  it('fast-forwards when remote is ahead', async () => {
    const dirs = await setupRepo()
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-kb-sync-other-'))
    try {
      await execFileAsync('git', ['clone', dirs.remoteUrl, other])
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: other })
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: other })
      await execFileAsync('git', ['config', 'protocol.file.allow', 'always'], { cwd: other })
      await fs.writeFile(path.join(other, 'extra.txt'), 'from remote\n')
      await execFileAsync('git', ['add', '.'], { cwd: other })
      await execFileAsync('git', ['commit', '-m', 'remote change'], { cwd: other })
      await execFileAsync('git', ['push', 'origin', 'HEAD:main'], { cwd: other })

      const result = await pullKnowledgeBase(dirs.root)
      expect(result.ok).toBe(true)
      expect(result.conflict).toBe(false)
      expect(result.message).toMatch(/快进/)
      await expect(fs.readFile(path.join(dirs.root, 'extra.txt'), 'utf8')).resolves.toContain(
        'from remote'
      )
    } finally {
      await cleanup(dirs, other)
    }
  })

  it('fails clearly when local diverged', async () => {
    const dirs = await setupRepo()
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-kb-sync-diverge-'))
    try {
      await execFileAsync('git', ['clone', dirs.remoteUrl, other])
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: other })
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: other })
      await execFileAsync('git', ['config', 'protocol.file.allow', 'always'], { cwd: other })
      await fs.writeFile(path.join(other, 'clash.txt'), 'remote\n')
      await execFileAsync('git', ['add', '.'], { cwd: other })
      await execFileAsync('git', ['commit', '-m', 'remote clash'], { cwd: other })
      await execFileAsync('git', ['push', 'origin', 'HEAD:main'], { cwd: other })

      await write(dirs.root, 'clash.txt', 'local\n')
      await git(['add', '.'], dirs.root)
      await git(['commit', '-m', 'local clash'], dirs.root)

      const result = await pullKnowledgeBase(dirs.root)
      expect(result.ok).toBe(false)
      expect(result.conflict).toBe(true)
      expect(result.message).toBe(PULL_CONFLICT_USER_MESSAGE)
    } finally {
      await cleanup(dirs, other)
    }
  })
})

describe('buildPullConflictAgentPrompt', () => {
  it('mentions kb name and absolute path', () => {
    const prompt = buildPullConflictAgentPrompt({
      name: 'leetcode',
      rootPath: '/Users/x/TNotes.leetcode'
    })
    expect(prompt).toContain('leetcode')
    expect(prompt).toContain('/Users/x/TNotes.leetcode')
    expect(prompt).toMatch(/冲突|pull/i)
  })
})
