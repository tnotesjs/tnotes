/**
 * 本机 MCP 服务（Streamable HTTP，只读工具 `get_current_selection`）。
 *
 * 三层里的最外层：把 `selectionContext`（与协议无关的读取接口）暴露给外部 MCP 客户端。
 * 用官方 SDK（`@modelcontextprotocol/sdk`）实现协议，不自己写 JSON-RPC。
 *
 * 本机服务的安全措施（按 SDK 对本机 Streamable HTTP 的建议）：
 * 1. **只监听回环地址**（`127.0.0.1`）——不监听所有网卡；
 * 2. **`Host` 头校验**：只接受回环主机名，挡 DNS rebinding；
 * 3. **`Origin` 校验**：带了 Origin 就必须是回环来源（浏览器页面默认会被挡）；
 * 4. **Bearer 令牌**：随机 256 位，放请求头，恒定时间比较；令牌不进日志；
 * 5. 端口固定：占用时**明确报错**，不偷偷换端口（否则客户端会失联）。
 */
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'

import { activeNoteService } from '../context/activeNoteService'
import { pinnedContext } from '../context/pinnedContextService'
import { deskLog } from '../log'
import { selectionContext } from '../selection/selectionService'
import { ensureToken, rotateToken, tokenMatches } from './token'

import { MCP_PATH } from '../../shared/contracts'

import type {
  ActiveNoteContextDto,
  McpServerStatusDto,
  PinnedContextDto,
  SelectionContextSnapshotDto
} from '../../shared/contracts'

export interface McpServerOptions {
  port: number
  /** 工具说明里告诉 Agent 的"先调用"约定 */
  selectionService?: typeof selectionContext
}

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

/** 工具说明：明确草稿与磁盘的区别，避免 Agent 拿草稿坐标去改磁盘文件 */
const TOOL_DESCRIPTION = [
  '读取 TNotes Desk 里用户的选中内容及其上下文。',
  '不需要参数，也不接受文件路径；返回的是用户在 Desk 里的选择。',
  '两种模式：source=live 是**当前实时选区**；source=pinned 是用户用「固定为 Agent 上下文」',
  '临时固定的一份快照（不随后续选择变化，多次调用不会消费掉它）。',
  'status=ok 时给出笔记身份、编辑器视图、内容版本、选中文本与范围/相关块，',
  '并用 source / pinnedAt 标明这份上下文是实时还是固定的。',
  'status 也可能是 no_selection / unsupported_selection / selection_invalidated /',
  'context_too_large / pinned_invalidated：**都不是服务器错误**，而是结构化结果。',
  'pinned_invalidated 表示固定上下文已被解除、来源标签关闭或校验失效 ——',
  '此时不要回退去读用户当前选中的别的内容，如实告知用户并等他们重新选择。',
  '注意：contentSource=draft 表示内容来自编辑器草稿（可能与磁盘不同），',
  '此时不要按返回的行列坐标直接去修改磁盘文件；请以磁盘内容为准重新定位。'
].join('')

/** `get_current_note` 的工具说明：只给定位信息，且磁盘内容可能落后于未保存编辑 */
const NOTE_TOOL_DESCRIPTION = [
  '读取 TNotes Desk 里**当前活动笔记**（活动分组中的活动标签）的定位信息：',
  '知识库、笔记标题、绝对路径、相对路径、当前视图与是否有未保存修改。',
  '不需要参数，也不接受路径参数；只回答"调用时"的当前笔记。',
  '只有笔记标签会返回路径；网页 / 设置 / 资源等标签会返回 status=no_focused_note，',
  '并且不回退到上一次的笔记。',
  '注意：这里不返回正文。按返回的路径读到的是**磁盘内容**，可能不包含尚未保存的编辑',
  '（editor.hasUnsavedChanges 会标出来）；这个工具不会保存、也不会写入任何文件。'
].join('')

function snapshotText(snapshot: SelectionContextSnapshotDto): string {
  return JSON.stringify(snapshot, null, 2)
}

/** 固定上下文 → MCP 返回：有效时给不可变快照，失效时只给状态与原因（不给旧正文） */
function pinnedSnapshot(pinned: PinnedContextDto): SelectionContextSnapshotDto {
  const limits = { ...pinned.limits }
  if (pinned.state === 'invalidated') {
    return {
      status: 'pinned_invalidated',
      snapshotId: null,
      capturedAt: null,
      source: 'pinned',
      ...(pinned.pinnedAt ? { pinnedAt: pinned.pinnedAt } : {}),
      ...(pinned.knowledgeBase ? { knowledgeBase: { ...pinned.knowledgeBase } } : {}),
      ...(pinned.note ? { note: { ...pinned.note } } : {}),
      message: `${pinned.reason ?? '固定上下文已失效'}。固定内容已不再返回，也不会改读当前选中的其它内容；请让用户重新固定或重新选择。`,
      limits
    }
  }
  return {
    status: 'ok',
    snapshotId: pinned.pinId,
    capturedAt: pinned.pinnedAt,
    source: 'pinned',
    ...(pinned.pinnedAt ? { pinnedAt: pinned.pinnedAt } : {}),
    ...(pinned.knowledgeBase ? { knowledgeBase: { ...pinned.knowledgeBase } } : {}),
    ...(pinned.note ? { note: { ...pinned.note } } : {}),
    ...(pinned.editor
      ? {
          editor: {
            viewMode: pinned.editor.viewMode,
            collector: pinned.editor.viewMode === 'source' ? 'source' : 'visual',
            contentSource: pinned.editor.contentSource,
            hasUnsavedChanges: pinned.editor.hasUnsavedChanges,
            revision: pinned.editor.revision
          }
        }
      : {}),
    selection: {
      selectedText: pinned.selection?.selectedText ?? '',
      mapping: pinned.selection?.mapping ?? 'block',
      ...(pinned.selection?.sourceRange
        ? { sourceRange: { ...pinned.selection.sourceRange } }
        : {}),
      blocks: (pinned.selection?.blocks ?? []).map((block) => ({ ...block }))
    },
    limits
  }
}

function noteText(context: ActiveNoteContextDto): string {
  return JSON.stringify(context, null, 2)
}

/**
 * 本机 MCP 服务：监听 / 停止 / 状态。
 *
 * 生命周期由主进程持有：开关关闭或应用退出时 `stop()`（释放端口、关闭会话）。
 */
export class McpSelectionServer {
  private http: HttpServer | null = null
  private readonly sessions = new Map<string, Session>()
  private token = ''
  private lastError: string | null = null
  private lastCallAt: string | null = null
  private enabled = false
  private readonly port: number

  constructor(options: McpServerOptions) {
    this.port = options.port
  }

  /** 当前地址（未运行时给出"将要使用"的地址，便于设置界面展示与排查） */
  get url(): string {
    return `http://127.0.0.1:${this.port}${MCP_PATH}`
  }

  status(): McpServerStatusDto {
    return {
      enabled: this.enabled,
      running: this.http !== null,
      url: this.http ? this.url : null,
      token: this.token,
      error: this.lastError,
      sessions: this.sessions.size,
      lastCallAt: this.lastCallAt
    }
  }

  get isRunning(): boolean {
    return this.http !== null
  }

  /**
   * 启动监听。
   *
   * 失败（端口占用等）时**不**改端口重试：返回带 `error` 的状态，由设置界面如实展示，
   * 避免客户端配置被悄悄改掉而失联。
   */
  async start(enabled = true): Promise<McpServerStatusDto> {
    this.enabled = enabled
    this.token = ensureToken()
    if (this.http) return this.status()
    const http = createHttpServer((request, response) => {
      void this.handle(request, response)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          http.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          http.removeListener('error', onError)
          resolve()
        }
        http.once('error', onError)
        http.once('listening', onListening)
        http.listen(this.port, '127.0.0.1')
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError =
        (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
          ? `端口 ${this.port} 已被占用，MCP 服务未启动（不会自动改端口）`
          : `MCP 服务启动失败：${message}`
      deskLog('mcp', '启动失败', { port: this.port, message })
      http.close()
      return this.status()
    }
    this.http = http
    this.lastError = null
    deskLog('mcp', '已启动', { url: this.url })
    return this.status()
  }

  /** 停止：关闭所有会话与 HTTP 服务，释放端口 */
  async stop(): Promise<McpServerStatusDto> {
    this.enabled = false
    for (const [id, session] of [...this.sessions.entries()]) {
      this.sessions.delete(id)
      await session.transport.close().catch(() => undefined)
      await session.server.close().catch(() => undefined)
    }
    const http = this.http
    this.http = null
    if (http) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
        // 已建立的长连接（SSE）会挡住 close：强制断开，确保端口真的释放
        http.closeAllConnections?.()
      })
      deskLog('mcp', '已停止')
    }
    return this.status()
  }

  /**
   * 轮换令牌：换新值并**立刻关闭所有会话** —— 旧连接不能再用旧凭据读上下文。
   */
  async rotate(): Promise<McpServerStatusDto> {
    this.token = rotateToken()
    for (const [id, session] of [...this.sessions.entries()]) {
      this.sessions.delete(id)
      await session.transport.close().catch(() => undefined)
      await session.server.close().catch(() => undefined)
    }
    deskLog('mcp', '已重置连接令牌（旧会话已断开）', { sessions: 0 })
    return this.status()
  }

  /* ---------------------------------------------------------------- */
  /* HTTP 入口：安全校验 → 交给 SDK 传输层                             */
  /* ---------------------------------------------------------------- */

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.url)
    if (url.pathname !== MCP_PATH) {
      this.reject(response, 404, '未知路径')
      return
    }
    if (!this.hostAllowed(request)) {
      this.reject(response, 403, 'Host 头不是回环地址（疑似 DNS rebinding）')
      return
    }
    if (!this.originAllowed(request)) {
      this.reject(response, 403, 'Origin 不是本机来源')
      return
    }
    if (!this.authorized(request)) {
      response.writeHead(401, {
        'content-type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="tnotes-desk-mcp"'
      })
      response.end(JSON.stringify({ error: 'invalid_token' }))
      return
    }
    try {
      await this.dispatch(request, response)
    } catch (error) {
      deskLog('mcp', '处理请求失败', {
        message: error instanceof Error ? error.message : String(error)
      })
      if (!response.headersSent) this.reject(response, 500, '内部错误')
    }
  }

  /** 把请求交给对应会话的传输；没有会话 id 时只接受 initialize */
  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const sessionId = request.headers['mcp-session-id']
    const id = typeof sessionId === 'string' ? sessionId : undefined
    if (id) {
      const session = this.sessions.get(id)
      if (!session) {
        this.reject(response, 404, '会话不存在或已失效（请重新初始化）')
        return
      }
      await session.transport.handleRequest(request, response)
      return
    }
    const body = await readJsonBody(request)
    if (!isInitializeRequest(body)) {
      this.reject(response, 400, '缺少 mcp-session-id：只有 initialize 请求可以不带会话')
      return
    }
    const session = this.createSession()
    await session.transport.handleRequest(request, response, body)
  }

  private createSession(): Session {
    const server = this.createMcpServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // 本机服务：不需要浏览器跨域
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        this.sessions.set(sessionId, { transport, server })
      }
    })
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId)
    }
    void server.connect(transport)
    return { transport, server }
  }

  /** 组装 MCP 服务与工具（每次会话一份，工具回调读的是全局选区服务） */
  createMcpServer(service: typeof selectionContext = selectionContext): McpServer {
    const server = new McpServer(
      { name: 'tnotes-desk-selection', version: '0.1.0' },
      {
        instructions:
          'TNotes Desk 的只读上下文服务。用户提到"Desk 当前选区 / 我选中的内容"时，' +
          '先调用 get_current_selection；没有有效选区就如实告知用户（status 不是 ok），不要臆测内容。' +
          '用户提到"当前笔记 / 这篇笔记"时调用 get_current_note 取路径；' +
          '按路径读到的是磁盘内容，可能不含未保存编辑。'
      }
    )
    server.registerTool(
      'get_current_selection',
      { title: '读取 Desk 当前选区', description: TOOL_DESCRIPTION, inputSchema: {} },
      () => {
        const pinned = pinnedContext.read()
        const snapshot: SelectionContextSnapshotDto =
          pinned.state === 'none' ? { ...service.read(), source: 'live' } : pinnedSnapshot(pinned)
        this.lastCallAt = new Date().toISOString()
        return {
          content: [{ type: 'text' as const, text: snapshotText(snapshot) }],
          structuredContent: snapshot as unknown as Record<string, unknown>,
          isError: false
        }
      }
    )
    server.registerTool(
      'get_current_note',
      { title: '读取 Desk 当前笔记', description: NOTE_TOOL_DESCRIPTION, inputSchema: {} },
      () => {
        const context = activeNoteService.read()
        return {
          content: [{ type: 'text' as const, text: noteText(context) }],
          structuredContent: context as unknown as Record<string, unknown>,
          isError: false
        }
      }
    )
    return server
  }

  private hostAllowed(request: IncomingMessage): boolean {
    const host = request.headers.host
    if (!host) return false
    const [name] = host.split(':')
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
  }

  private originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    if (!origin) return true // 非浏览器客户端（curl / MCP 客户端）没有 Origin
    try {
      const parsed = new URL(origin)
      return (
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '[::1]' ||
        parsed.hostname === '::1'
      )
    } catch {
      return false
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization
    const prefix = 'Bearer '
    const provided = header?.startsWith(prefix) ? header.slice(prefix.length) : null
    return tokenMatches(this.token, provided)
  }

  private reject(response: ServerResponse, status: number, message: string): void {
    if (response.headersSent) return
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: message }))
  }
}

/** 读取并解析请求体（SDK 的 handleRequest 需要已解析的 body 时由我们提供） */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer))
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
