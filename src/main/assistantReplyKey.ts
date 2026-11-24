import { createHash } from 'node:crypto'

interface AssistantRecord {
  role?: unknown
  timestamp?: unknown
  stopReason?: unknown
  content?: unknown
}

export function isFinalAssistantMessage(message: AssistantRecord): boolean {
  if (message.stopReason !== undefined && message.stopReason !== 'stop' && message.stopReason !== 'length') return false
  return !Array.isArray(message.content) || !message.content.some(block => block?.type === 'toolCall')
}

/** Both the RPC message_end and its journal entry carry the same completed message. */
export function assistantReplyKey(message: AssistantRecord | null | undefined): string | undefined {
  if (message?.role !== 'assistant' || !isFinalAssistantMessage(message)) return undefined
  const content = message.content
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
    : ''
  if (!text.trim()) return undefined
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null
  return createHash('sha256').update(JSON.stringify([timestamp, text])).digest('hex')
}
