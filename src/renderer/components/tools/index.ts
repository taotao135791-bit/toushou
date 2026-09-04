import { ComponentType } from 'react'
import { ToolCallRecord } from '../../lib/toolCalls'
import BashToolContent from './bash'
import ReadToolContent from './read'
import EditToolContent from './edit'
import TodoToolContent from './todo'
import ScreenshotToolContent from './screenshot'
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
  const name = toolName.toLowerCase()
  if (name === 'bash') return BashToolContent
  if (name === 'read') return ReadToolContent
  if (name === 'edit' || name === 'write') return EditToolContent
  if (name === 'todo' || name === 'todo_write' || name === 'todowrite' || name === 'plan') {
    return TodoToolContent
  }
  if (name.endsWith('screenshot')) return ScreenshotToolContent
  return GenericToolContent
}
