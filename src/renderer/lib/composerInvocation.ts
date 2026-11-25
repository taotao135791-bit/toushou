import { mcpMention, splitMcpMentions } from '@shared/mcpMentions'

export type ComposerInvocation =
  | { kind: 'slash'; command: string }
  | { kind: 'mcp'; name: string }
  | { kind: 'insert'; text: string }
  | { kind: 'skill'; text: string }

const LEADING_COMMAND = /^\s*\/[a-z0-9_][a-z0-9_.:-]*(?:[ \t]+|(?=\s|$))/i

/** RPC slash commands and explicit MCP selection both need the start of the prompt. */
export function planInvocation(
  text: string,
  start: number,
  end: number,
  invocation: ComposerInvocation
): { start: number; end: number; insert: string } | null {
  if (invocation.kind === 'slash') {
    if (splitMcpMentions(text).names.length) return null
    const leadingCommand = LEADING_COMMAND.exec(text)?.[0]
    return { start: 0, end: leadingCommand?.length ?? 0, insert: `${invocation.command} ` }
  }
  if (invocation.kind === 'mcp') {
    if (LEADING_COMMAND.test(text.slice(0, start) + text.slice(end))) return null
    const prefix = start > 0 && !/[\s（(]/.test(text[start - 1]) ? ' ' : ''
    return { start, end, insert: `${prefix}${mcpMention(invocation.name)} ` }
  }
  if (invocation.kind === 'insert') {
    const separator = start > 0 && !/\s/.test(text[start - 1]) ? ' ' : ''
    return { start, end, insert: `${separator}${invocation.text} ` }
  }
  return { start, end, insert: `\n${invocation.text}\n` }
}
