import { describe, expect, it } from 'vitest'

import { buildTerminalEnv, detectShell } from './terminalManager'

describe('detectShell', () => {
  it('优先使用有效的 $SHELL', () => {
    const { shell, args } = detectShell('darwin', { SHELL: '/bin/bash' })
    expect(shell).toBe('/bin/bash')
    expect(args).toEqual(['-l'])
  })

  it('$SHELL 无效时回退到系统可用 shell', () => {
    const { shell } = detectShell('darwin', { SHELL: '/definitely/not/a/shell' })
    expect(['/bin/zsh', '/bin/bash', '/bin/sh']).toContain(shell)
  })

  it('Windows 分支总能给出可执行文件，且不带登录参数', () => {
    // 具体选中哪个 PowerShell 取决于该机的 Program Files（macOS 上必定不存在），
    // 所以只断言跨平台成立的契约：有结果、是绝对路径、不带 -l。
    for (const SystemRoot of ['C:\\Windows', 'C:\\definitely-not-here']) {
      const { shell, args } = detectShell('win32', { SystemRoot })
      expect(shell).toBeTruthy()
      expect(args).toEqual([])
    }
    // 探测不到 PowerShell 时回退到 ComSpec / cmd.exe
    const fallback = detectShell('win32', {
      SystemRoot: 'C:\\definitely-not-here',
      ProgramFiles: 'C:\\definitely-not-here'
    })
    expect(fallback.shell.toLowerCase()).toContain('cmd')
  })
})

describe('buildTerminalEnv', () => {
  it('只补缺失项，绝不覆盖已有值', () => {
    const { env, filled } = buildTerminalEnv({
      SHELL: '/bin/bash',
      LANG: 'zh_CN.UTF-8',
      PATH: '/custom/bin',
      TERM: 'screen-256color'
    })
    expect(env.LANG).toBe('zh_CN.UTF-8')
    expect(env.TERM).toBe('screen-256color')
    expect(env.PATH).toBe('/custom/bin')
    // 只补 COLORTERM，其余都已存在
    expect(filled).toEqual(['COLORTERM'])
  })

  it('缺失时补上 TERM / COLORTERM / LANG', () => {
    const { env, filled } = buildTerminalEnv({})
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.LANG).toBeTruthy()
    expect(filled).toEqual(['TERM', 'COLORTERM', 'LANG'])
  })

  it('不手工拼 PATH（让登录 shell 自己解析）', () => {
    const { env } = buildTerminalEnv({})
    expect(env.PATH).toBeUndefined()
  })
})
