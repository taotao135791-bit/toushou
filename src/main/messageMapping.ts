import { ChatMessage } from '../shared/types'

/**
 * Mapping from pi-agent-core's AgentMessage (as returned by the RPC
 * get_messages command and stored in session jsonl files) to the GUI's
 * ChatMessage shape — the same shape the streaming path (tool_call /
 * tool_result events merged in the renderer store) produces.
 *
 * - user text blocks            → one user message (blocks joined)
 * - assistant text blocks       → assistant messages; consecutive runs merge
 *   into the last assistant text message, exactly like streamed deltas do
 * - assistant toolCall blocks   → assistant message with a toolCall card
 *   ({ tool, input }); a matching toolResult fills output/isError later
 * - toolResult                  → merged into its toolCall card by toolCallId;
 *   an orphan result becomes a card without input (mirrors the store fallback)
 * - thinking blocks             → joined into the assistant message's
 *   `thinking` field (same message the surrounding text blocks merge into)
 * Pure functions so they can be unit-tested without Electron.
 */

export interface AgentTextBlock {
  type: 'text'
  text: string
}

export interface AgentToolCallBlock {
  type: 'toolCall'
  id: string
  name: string
  arguments: unknown
}

export type AgentContentBlock =
  | AgentTextBlock
  | AgentToolCallBlock
  | { type: string; [key: string]: unknown }

export interface AgentMessage {
  role: string
  content?: AgentContentBlock[] | string
  /** toolResult messages: id of the toolCall they answer. */
  toolCallId?: string
  toolName?: string
  isError?: boolean
  [key: string]: unknown
}

/** Join the text blocks of a content array (or pass a plain string through). */
function joinText(content: AgentMessage['content'], separator: string): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof (block as AgentTextBlock).text === 'string') {
      parts.push((block as AgentTextBlock).text)
    }
  }
  return parts.join(separator)
}

/** The last message if it is an assistant text run that deltas can append to. */
function appendableAssistantText(out: ChatMessage[]): ChatMessage | null {
  const last = out[out.length - 1]
  return last && last.role === 'assistant' && !last.toolCall ? last : null
}

export function mapAgentMessages(messages: AgentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  /** toolCallId → index in out, for merging toolResult into its card. */
  const pendingTools = new Map<string, number>()

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue

    if (msg.role === 'user') {
      const text = joinText(msg.content, '\n').trim()
      if (!text) continue
      out.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        // OMP records steered messages with `steering: true` on the user message.
        kind: msg.steering === true ? 'steer' : 'prompt'
      })
      continue
    }

    if (msg.role === 'assistant') {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block?.type === 'text' && typeof (block as AgentTextBlock).text === 'string') {
          const text = (block as AgentTextBlock).text
          if (!text.trim()) continue
          const current = appendableAssistantText(out)
          if (current) {
            current.content = current.content ? `${current.content}\n\n${text}` : text
          } else {
            out.push({ id: crypto.randomUUID(), role: 'assistant', content: text })
          }
        } else if (block?.type === 'thinking') {
          const text = (block as { thinking?: unknown }).thinking
          if (typeof text !== 'string' || !text.trim()) continue
          // Fold into the same assistant message the text blocks merge into,
          // so the thinking block renders above its reply.
          let current = appendableAssistantText(out)
          if (!current) {
            current = { id: crypto.randomUUID(), role: 'assistant', content: '' }
            out.push(current)
          }
          current.thinking = current.thinking ? `${current.thinking}\n${text}` : text
        } else if (block?.type === 'toolCall') {
          const call = block as AgentToolCallBlock
          out.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            toolCall: { tool: String(call.name ?? 'tool'), input: call.arguments }
          })
          if (typeof call.id === 'string' && call.id) {
            pendingTools.set(call.id, out.length - 1)
          }
        }
        // unknown blocks are skipped
      }
      continue
    }

    if (msg.role === 'toolResult') {
      const output = joinText(msg.content, '\n')
      const isError = msg.isError === true
      const idx = typeof msg.toolCallId === 'string' ? pendingTools.get(msg.toolCallId) : undefined
      if (idx !== undefined && out[idx]?.toolCall) {
        out[idx] = {
          ...out[idx],
          toolCall: { ...out[idx].toolCall!, output, isError }
        }
        pendingTools.delete(msg.toolCallId as string)
      } else {
        // Result without its call in range — same fallback the store uses.
        out.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          toolCall: {
            tool: typeof msg.toolName === 'string' ? msg.toolName : 'tool',
            input: undefined,
            output,
            isError
          }
        })
      }
      continue
    }
    // Other roles (system prompts, custom messages) are not surfaced.
  }

  return out
}
