import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveInitialCwd } from './terminal'

/**
 * 初始工作目录的校验：规范化 + 真实路径 + 必须是目录。
 * 纯字符串前缀比较会放过 `<根>/../别处`，也会被软链绕过。
 */
describe('resolveInitialCwd', () => {
  let root = ''
  let realRoot = ''
  let outside = ''

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'desk-cwd-'))
    root = join(base, 'TNotes.kb')
    outside = join(base, 'outside')
    mkdirSync(join(root, 'notes'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    // macOS 的 /var 本身是软链（→ /private/var）：期望值必须按真实路径算，
    // 否则断言的是「未解析的写法」，而不是被测函数该返回的东西。
    realRoot = realpathSync(root)
    writeFileSync(join(root, 'notes', '0001. n.md'), '# n\n')
    // 库内一个指向库外的软链：真实路径校验必须拦住它
    symlinkSync(outside, join(root, 'escape'))
    // 同前缀的兄弟目录：`startsWith` 的经典漏洞
    mkdirSync(`${root}-backup`, { recursive: true })
  })

  afterAll(() => {
    rmSync(join(root, '..'), { recursive: true, force: true })
  })

  it('接受知识库根目录本身与库内子目录', () => {
    expect(resolveInitialCwd(root, root)).toBe(realRoot)
    expect(resolveInitialCwd(root, join(root, 'notes'))).toBe(join(realRoot, 'notes'))
  })

  it('接受库内带 .. 但最终仍在库内的路径', () => {
    expect(resolveInitialCwd(root, join(root, 'notes', '..'))).toBe(realRoot)
  })

  it('拒绝用 .. 逃逸到库外', () => {
    expect(() => resolveInitialCwd(root, join(root, '..'))).toThrow(/必须在知识库根目录内/)
    expect(() => resolveInitialCwd(root, join(root, 'notes', '..', '..'))).toThrow()
  })

  it('拒绝同前缀的兄弟目录（不能只用 startsWith）', () => {
    expect(() => resolveInitialCwd(root, `${root}-backup`)).toThrow(/必须在知识库根目录内/)
  })

  it('拒绝不存在的路径', () => {
    expect(() => resolveInitialCwd(root, join(root, 'no-such-dir'))).toThrow(/不存在或无法访问/)
  })

  it('拒绝普通文件（工作目录必须是目录）', () => {
    expect(() => resolveInitialCwd(root, join(root, 'notes', '0001. n.md'))).toThrow(
      /必须是一个目录/
    )
  })

  it('按真实路径处理软链：指向库外的软链被拒', () => {
    expect(() => resolveInitialCwd(root, join(root, 'escape'))).toThrow(/必须在知识库根目录内/)
  })

  it('软链解析后仍在库内则放行，并返回真实路径', () => {
    symlinkSync(join(root, 'notes'), join(root, 'notes-link'))
    expect(resolveInitialCwd(root, join(root, 'notes-link'))).toBe(join(realRoot, 'notes'))
  })
})
