import { createServer } from 'node:http'

const port = Number(process.env.PORT || 9777)

function sse(delta, finishReason = null) {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`
}

function done() {
  return 'data: [DONE]\n\n'
}

function toolCall(name, args) {
  return sse(
    {
      tool_calls: [
        {
          index: 0,
          id: `call_${name}`,
          function: { name, arguments: JSON.stringify(args) }
        }
      ]
    },
    'tool_calls'
  )
}

function textOf(content) {
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }
  return String(content ?? '')
}

function imageCount(content) {
  return Array.isArray(content) ? content.filter((part) => part.type === 'image_url').length : 0
}

function replyFor(body) {
  const messages = body.messages ?? []
  if (messages.some((message) => message.role === 'tool')) {
    return [sse({ content: '模拟回答' }), done()]
  }
  const user = [...messages].reverse().find((message) => message.role === 'user')
  const text = textOf(user?.content)
  const images = imageCount(user?.content)
  if (images > 0) return [sse({ content: `收到 ${images} 张图片` }), done()]
  const tools = body.tools ?? []
  if (text.includes('跨库修改')) {
    return [toolCall('edit_note', { kb: 'test', note: '0002', position: 'end', new_string: '跨库追加的一行' }), done()]
  }
  const canWrite = tools.some((tool) => tool.function?.name === 'edit_note' || tool.function?.name === 'create_note')
  if (text.includes('截断')) {
    return [sse({ content: '写到一半' }), sse({}, 'length'), done()]
  }
  if (text.includes('挂起') || text.includes('不要结束')) return null
  if (text.includes('列目录')) return [toolCall('list_notes', { offset: 0, limit: 200 }), done()]
  if (!canWrite || text.includes('只读')) return [sse({ content: '只读回答' }), done()]
  if (text.includes('搜索')) return [toolCall('search_notes', { query: 'ALEX' }), done()]
  if (text.includes('新建')) {
    return [toolCall('create_note', { title: 'agent-smoke-temp', content: '临时笔记' }), done()]
  }
  if (text.includes('追加')) {
    return [toolCall('edit_note', { position: 'end', new_string: '追加的一行' }), done()]
  }
  const swap = text.match(/把「([\s\S]+?)」换成「([\s\S]+?)」/)
  if (swap && canWrite) {
    const args = { old_string: swap[1], new_string: swap[2] }
    const note = text.match(/笔记\s*([0-9a-f-]{8,}|agent-smoke-temp|\d{4})/i)
    if (note) args.note = note[1]
    return [toolCall('edit_note', args), done()]
  }
  if (text.includes('改') || text.includes('修改')) {
    return [toolCall('edit_note', { old_string: 'EDITME', new_string: 'DONE' }), done()]
  }
  return [sse({ content: '**模拟回答**\n\n- 第一项\n- 第二项' }), done()]
}

const server = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(404)
    response.end()
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user')
  const system = (body.messages ?? []).find((message) => message.role === 'system')?.content ?? ''
  const selectionMark = system.includes('选区过长，已截断')
  console.log(
    'REQ',
    'model',
    body.model,
    'effort',
    body.reasoning_effort ?? '-',
    'messages',
    (body.messages ?? []).length,
    'images',
    imageCount(lastUser?.content),
    'selectionMark',
    selectionMark,
    'system',
    system.length,
    'user',
    JSON.stringify(textOf(lastUser?.content).slice(0, 24))
  )
  const pieces = replyFor(body)
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache'
  })
  if (!pieces) {
    response.write(sse({ content: '已输出' }))
    request.on('close', () => response.end())
    return
  }
  for (const piece of pieces) response.write(piece)
  response.end()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`agent mock listening on http://127.0.0.1:${port}/v1`)
})
