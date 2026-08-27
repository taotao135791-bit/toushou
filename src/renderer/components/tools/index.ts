import { ComponentType } from 'react'
import { ToolCallRecord } from '../../lib/toolCalls'
import BashToolContent from './bash'
import ReadToolContent from './read'
import EditToolContent from './edit'
import GenericToolContent from './generic'

export interface ToolContentProps {
  toolCall: ToolCallRecord
}

/** Tool input as a record ({} when the input isn't an object). */
export function toolInputObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

/** Tool output as display text; null while the call is still running. */
export function toolOutputText(output: unknown): string | null {
  if (output === undefined) return null
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

/**
 * Per-tool renderer for a card's expanded content. Unknown tools fall back to
 * the generic JSON view — registering a new tool here leaves ToolCallCard
 * untouched.
 */
export function getToolRenderer(toolName: string): ComponentType<ToolContentProps> {
  switch (toolName.toLowerCase()) {
    case 'bash':
      return BashToolContent
    case 'read':
      return ReadToolContent
    case 'edit':
    case 'write':
      return EditToolContent
    default:
      return GenericToolContent
  }
}
