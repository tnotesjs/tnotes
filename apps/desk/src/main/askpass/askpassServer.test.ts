import { mkdtemp, rm, stat } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AskpassServer, isSecretPrompt, type AskpassPrompt } from './askpassServer'

/** 模拟 askpassMain：发一行请求，读一行回复 */
function ask(
  socketPath: string,
  request: Record<string, unknown>
): { reply: Promise<{ ok: boolean; value?: string }>; socket: net.Socket } {
  const socket = net.connect(socketPath)
  socket.setEncoding('utf8')
  const reply = new Promise<{ ok: boolean; value?: string }>((resolve, reject) => {
    let buffer = ''
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline !== -1) resolve(JSON.parse(buffer.slice(0, newline)))
    })
    socket.on('error', reject)
  })
  return { reply, socket }
}

describe('AskpassServer', () => {
  let dir: string
  let server: AskpassServer
  let prompts: AskpassPrompt[]
  let dismissed: string[]

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tn-askpass-'))
    server = new AskpassServer({
      scriptDir: dir,
      mainPath: '/fake/askpassMain.js',
      socketPath: path.join(dir, 's.sock'),
      token: 'secret-token'
    })
    prompts = []
    dismissed = []
    server.onRequest((prompt) => prompts.push(prompt))
    server.onDismiss((id) => dismissed.push(id))
    await server.start()
  })

  afterEach(async () => {
    await server.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('写出可执行的 askpass.sh，并给出完整环境变量', async () => {
    const info = await stat(path.join(dir, 'askpass.sh'))
    expect(info.mode & 0o111).not.toBe(0)
    const bridge = server.bridgeFor('task:1')
    expect(bridge?.env).toMatchObject({
      GIT_ASKPASS: path.join(dir, 'askpass.sh'),
      TNOTES_ASKPASS_MAIN: '/fake/askpassMain.js',
      TNOTES_ASKPASS_HANDLE: path.join(dir, 's.sock'),
      TNOTES_ASKPASS_TOKEN: 'secret-token',
      TNOTES_ASKPASS_RUN: 'task:1'
    })
  })

  it('作答后把答案回给 askpass，并通知等待结束', async () => {
    const waiting: boolean[] = []
    server.bridgeFor('task:1')?.onWaiting((value) => waiting.push(value))
    const { reply } = ask(path.join(dir, 's.sock'), {
      token: 'secret-token',
      runId: 'task:1',
      prompt: "Password for 'https://u@example.com': "
    })
    await expect.poll(() => prompts.length).toBe(1)
    expect(prompts[0].secret).toBe(true)
    expect(waiting).toEqual([true])
    server.answer(prompts[0].id, 'hunter2')
    await expect(reply).resolves.toEqual({ ok: true, value: 'hunter2' })
    expect(waiting).toEqual([true, false])
    expect(dismissed).toEqual([])
  })

  it('token 不对直接拒绝，不弹框', async () => {
    const { reply } = ask(path.join(dir, 's.sock'), {
      token: 'wrong',
      runId: 'task:1',
      prompt: 'Username: '
    })
    await expect(reply).resolves.toEqual({ ok: false })
    expect(prompts).toEqual([])
  })

  it('取消这一轮：未答的询问回 ok:false 并通知界面关框', async () => {
    const { reply } = ask(path.join(dir, 's.sock'), {
      token: 'secret-token',
      runId: 'task:2',
      prompt: 'Username: '
    })
    await expect.poll(() => prompts.length).toBe(1)
    server.bridgeFor('task:2')?.cancel()
    await expect(reply).resolves.toEqual({ ok: false })
    expect(dismissed).toEqual([prompts[0].id])
  })

  it('askpass 进程被杀（连接断开）时询问随之失效', async () => {
    const { socket } = ask(path.join(dir, 's.sock'), {
      token: 'secret-token',
      runId: 'task:3',
      prompt: 'Username: '
    })
    await expect.poll(() => prompts.length).toBe(1)
    socket.destroy()
    await expect.poll(() => dismissed).toEqual([prompts[0].id])
  })

  it('按提示判断是否用密码框', () => {
    expect(isSecretPrompt("Username for 'https://github.com': ")).toBe(false)
    expect(isSecretPrompt("Password for 'https://u@github.com': ")).toBe(true)
    expect(isSecretPrompt("Enter passphrase for key '/Users/u/.ssh/id_ed25519': ")).toBe(true)
  })
})
