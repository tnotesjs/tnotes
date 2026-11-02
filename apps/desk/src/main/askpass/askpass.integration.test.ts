import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../settings', () => ({ loadSettings: () => ({ gitPath: '' }) }))

import { runGit } from '../gitManager'
import { AskpassServer } from './askpassServer'

/**
 * 真实链路：git → askpass.sh → askpassMain（以 node 剥类型直接跑 .ts）→ socket → AskpassServer。
 * 本地 http 服务要求 Basic 认证，验证 git 拿到的就是界面给出的用户名和密码。
 */
describe('askpass 端到端', () => {
  let dir: string
  let server: AskpassServer
  let httpServer: http.Server
  let port = 0
  const authorizations: string[] = []

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tn-askpass-e2e-'))
    server = new AskpassServer({
      scriptDir: dir,
      mainPath: path.join(__dirname, 'askpassMain.ts'),
      nodePath: process.execPath,
      socketPath: path.join(dir, 's.sock')
    })
    await server.start()
    authorizations.length = 0
    httpServer = http.createServer((request, response) => {
      const authorization = request.headers.authorization
      if (!authorization) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="tn"' })
        response.end()
        return
      }
      authorizations.push(authorization)
      response.writeHead(403)
      response.end()
    })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    port = (httpServer.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.dispose()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  it('git 的用户名、密码询问经界面作答后送达远端', async () => {
    const seen: string[] = []
    server.onRequest((prompt) => {
      seen.push(prompt.prompt)
      server.answer(prompt.id, prompt.secret ? 's3cret' : 'alice')
    })
    const bridge = server.bridgeFor('task:1')!
    await runGit(
      dir,
      ['-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${port}/repo.git`],
      20_000,
      {
        askpass: {
          ...bridge,
          env: { ...bridge.env, NODE_OPTIONS: '--experimental-strip-types --no-warnings' }
        }
      }
    )
    expect(seen.some((text) => /username/i.test(text))).toBe(true)
    expect(seen.some((text) => /password/i.test(text))).toBe(true)
    expect(authorizations).toContain(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`)
  })

  it('用户取消时 git 以认证失败结束，不会挂住', async () => {
    server.onRequest((prompt) => server.answer(prompt.id, null))
    const bridge = server.bridgeFor('task:2')!
    const result = await runGit(
      dir,
      ['-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${port}/repo.git`],
      20_000,
      {
        askpass: {
          ...bridge,
          env: { ...bridge.env, NODE_OPTIONS: '--experimental-strip-types --no-warnings' }
        }
      }
    )
    expect(result.code).not.toBe(0)
    expect(authorizations).toEqual([])
  })
})
