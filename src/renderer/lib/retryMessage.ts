import type { PromptImage } from '@shared/types'
import type { MessageLike, QueuedMessage } from '../store'

/** Retry the original immutable outgoing payload; composer state is never read or written. */
export async function retryFailedMessage(
  sessionId: string,
  message: MessageLike,
  deps: {
    currentSessionId: string | null
    busy: boolean
    enqueue: (sessionId: string, item: QueuedMessage) => void
    send: (text: string, images?: PromptImage[]) => Promise<boolean>
    createId: () => string
  }
): Promise<boolean> {
  if (deps.currentSessionId !== sessionId || message.role !== 'user' || !message.failed || !message.content.trim()) return false
  const images = message.images?.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }))
  if (deps.busy) {
    deps.enqueue(sessionId, { id: deps.createId(), text: message.content, images })
    return true
  }
  return deps.send(message.content, images)
}
