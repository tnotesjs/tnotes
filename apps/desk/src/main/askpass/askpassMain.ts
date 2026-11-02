/**
 * GIT_ASKPASS / SSH_ASKPASS 的执行体（由 askpass.sh 以 ELECTRON_RUN_AS_NODE 启动）。
 *
 * 把提示交给 Desk 主进程，拿到答案写到 stdout 后退出 0；用户取消或连不上就退出 1，
 * git / ssh 会把它当成认证失败。
 */
import net from 'node:net'

const handle = process.env.TNOTES_ASKPASS_HANDLE
const token = process.env.TNOTES_ASKPASS_TOKEN
const runId = process.env.TNOTES_ASKPASS_RUN
const prompt = process.argv.slice(2).join(' ')

if (!handle || !token || !runId) process.exit(1)

const socket = net.connect(handle as string)
let buffer = ''
/** macOS 上写管道是异步的：答案写出之前连接就可能关闭，不能让 close 抢先以 1 退出 */
let answered = false
socket.setEncoding('utf8')
socket.on('connect', () => {
  socket.write(`${JSON.stringify({ token, runId, prompt })}\n`)
})
socket.on('data', (chunk: string) => {
  if (answered) return
  buffer += chunk
  const newline = buffer.indexOf('\n')
  if (newline === -1) return
  try {
    const reply = JSON.parse(buffer.slice(0, newline)) as { ok?: boolean; value?: unknown }
    if (reply.ok && typeof reply.value === 'string') {
      answered = true
      process.stdout.write(`${reply.value}\n`, () => process.exit(0))
      return
    }
  } catch {
    /* 视为取消 */
  }
  process.exit(1)
})
socket.on('error', () => {
  if (!answered) process.exit(1)
})
socket.on('close', () => {
  if (!answered) process.exit(1)
})
