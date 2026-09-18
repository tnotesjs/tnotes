import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { formatIdeCommand, launchIde, type IdeLaunchSpec } from './ide'

/**
 * 启动器结果检测。
 *
 * 原实现只等 `spawn` 事件：那只说明进程被创建。`open -a` 找不到应用、
 * CLI 非零退出都会被当成成功——这些用例正是钉住这个行为。
 */
describe('IDE 启动器', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-ide-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function script(name: string, body: string): string {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8')
    chmodSync(file, 0o755)
    return file
  }

  const spec = (command: string, args: string[]): IdeLaunchSpec => ({
    command,
    args,
    detached: false
  })

  it('启动器退出码 0 → 成功，并带回目标路径与命令', async () => {
    const launcher = script('ok.sh', 'exit 0')
    const target = join(dir, '有 空格的 目录')
    const result = await launchIde(target, undefined, spec(launcher, [target]))

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeNull()
    expect(result.targetPath).toBe(target)
    // 命令行里含空格的路径要加引号，便于用户复制排查
    expect(result.command).toContain('"')
  })

  it('启动器非零退出 → 失败，并保留 stderr 作为原因', async () => {
    const launcher = script('fail.sh', 'echo "应用不存在" 1>&2\nexit 3')
    const result = await launchIde('/tmp/x', undefined, spec(launcher, ['/tmp/x']))

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('应用不存在')
    expect(result.error).toContain('应用不存在')
  })

  it('非零退出但没有 stderr → 原因回落到退出码', async () => {
    const launcher = script('silent.sh', 'exit 7')
    const result = await launchIde('/tmp/x', undefined, spec(launcher, ['/tmp/x']))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(7)
    expect(result.error).toContain('7')
  })

  it('命令不存在（ENOENT）→ 失败且不抛异常', async () => {
    const result = await launchIde('/tmp/x', undefined, spec('/definitely/not/a/launcher', ['x']))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(result.error).toBeTruthy()
  })

  it('stdout / stderr 都实时上报给观察者', async () => {
    const launcher = script('noisy.sh', 'echo 标准输出\necho 标准错误 1>&2\nexit 0')
    const chunks: Array<{ stream: string; text: string }> = []
    await launchIde(
      '/tmp/x',
      (stream, chunk) => chunks.push({ stream, text: chunk }),
      spec(launcher, ['/tmp/x'])
    )

    const merged = chunks.map((item) => `${item.stream}:${item.text}`).join('|')
    expect(merged).toContain('标准输出')
    expect(merged).toContain('标准错误')
    expect(chunks.some((item) => item.stream === 'stderr')).toBe(true)
  })

  it('formatIdeCommand 给含空格的参数加引号', () => {
    const line = formatIdeCommand({
      command: '/usr/bin/open',
      args: ['-a', 'Visual Studio Code', '/Users/me/My Notes'],
      detached: true
    })
    expect(line).toBe('/usr/bin/open -a "Visual Studio Code" "/Users/me/My Notes"')
  })
})
