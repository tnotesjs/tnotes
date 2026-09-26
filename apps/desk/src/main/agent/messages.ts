import type { AgentChatMessage } from '../../shared/contracts'
import type { AgentInputMessage } from './chat'

/**
 * 只有最后一条用户消息带图片原图；更早的消息里的图片换成「[图片]」，
 * 免得每一轮都把旧图重发一遍。
 */
export function withImages(
  messages: readonly AgentChatMessage[],
  loadImage: (id: string) => string | null
): AgentInputMessage[] {
  let last = -1
  messages.forEach((message, index) => {
    if (message.role === 'user') last = index
  })
  return messages.map((message, index) => {
    const ids = message.images ?? []
    if (ids.length === 0) return { role: message.role, content: message.content }
    if (index !== last) {
      return { role: message.role, content: `${message.content}\n${ids.map(() => '[图片]').join(' ')}` }
    }
    const imageUrls = ids.map(loadImage).filter((url): url is string => Boolean(url))
    return { role: message.role, content: message.content, imageUrls }
  })
}
