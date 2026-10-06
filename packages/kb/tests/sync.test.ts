import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_PUSH_COMMIT_MESSAGE,
  PULL_CONFLICT_USER_MESSAGE,
  buildPullConflictAgentPrompt,
  pullKnowledgeBase,
  pushKnowledgeBase,
  shouldRunUpdateBeforePush
} from '../src/sync'

const execFileAsync = promisify(execFile)

let root: string
let remote: string

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

async function git(args: string[], cwd = root): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-kb-sync-'))
  remote = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-kb-sync-remote-'))
  await execFileAsync('git', ['init', '--bare'], { cwd: remote })

  await git(['init'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  await write(
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
  await write('TOC.md', '- [ ] 0001. hello\n')
  await write('notes/0001. hello.md', '---\nid: note-1\n---\n\nbody\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'init'])
  await git(['branch', '-M', 'main'])
  await git(['remote', 'add', 'origin', remote])
  await git(['push', '-u', 'origin', 'main'])
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(remote, { recursive: true, force: true })
})

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
    await write('notes/0001. hello.md', '---\nid: note-1\n---\n\nchanged\n')
    const result = await pushKnowledgeBase(root)
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)
    expect(result.commitMessage).toBe(DEFAULT_PUSH_COMMIT_MESSAGE)
    const log = await git(['log', '-1', '--pretty=%s'])
    expect(log).toBe(DEFAULT_PUSH_COMMIT_MESSAGE)
  })

  it('reports nothing to do when clean', async () => {
    const result = await pushKnowledgeBase(root)
    expect(result.committed).toBe(false)
    expect(result.pushed).toBe(false)
    expect(result.message).toContain('没有需要')
  })

  it('skips update when stats.enabled is false even if runUpdateBefore', async () => {
    await write('notes/0001. hello.md', '---\nid: note-1\n---\n\nagain\n')
    const result = await pushKnowledgeBase(root, { runUpdateBefore: true })
    expect(result.updated).toBe(false)
    expect(result.pushed).toBe(true)
  })
})

describe('pullKnowledgeBase', () => {
  it('fast-forwards when remote is ahead', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-kb-sync-other-'))
    try {
      await execFileAsync('git', ['clone', remote, other])
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: other })
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: other })
      await fs.writeFile(path.join(other, 'extra.txt'), 'from remote\n')
      await execFileAsync('git', ['add', '.'], { cwd: other })
      await execFileAsync('git', ['commit', '-m', 'remote change'], { cwd: other })
      await execFileAsync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: other })

      const result = await pullKnowledgeBase(root)
      expect(result.ok).toBe(true)
      expect(result.conflict).toBe(false)
      expect(result.message).toContain('快进')
      await expect(fs.readFile(path.join(root, 'extra.txt'), 'utf8')).resolves.toContain(
        'from remote'
      )
    } finally {
      await fs.rm(other, { recursive: true, force: true })
    }
  })

  it('fails clearly when local diverged', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'tnotes-kb-sync-diverge-'))
    try {
      await execFileAsync('git', ['clone', remote, other])
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: other })
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: other })
      await fs.writeFile(path.join(other, 'clash.txt'), 'remote\n')
      await execFileAsync('git', ['add', '.'], { cwd: other })
      await execFileAsync('git', ['commit', '-m', 'remote clash'], { cwd: other })
      await execFileAsync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: other })

      await write('clash.txt', 'local\n')
      await git(['add', '.'])
      await git(['commit', '-m', 'local clash'])

      const result = await pullKnowledgeBase(root)
      expect(result.ok).toBe(false)
      expect(result.conflict).toBe(true)
      expect(result.message).toBe(PULL_CONFLICT_USER_MESSAGE)
    } finally {
      await fs.rm(other, { recursive: true, force: true })
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
