export const MCP_MENTION_PREFIX = 'mcp:'

const NAME_PATTERN = '[a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9_-])?'
const MCP_NAME = new RegExp(`^${NAME_PATTERN}$`, 'i')
const MENTION = new RegExp(`(^|[\\s（(])@${MCP_MENTION_PREFIX}(${NAME_PATTERN})(?=$|[\\s，。；、！？,.;!?）)])`, 'gi')

export function isMcpMentionName(name: string): boolean {
  return MCP_NAME.test(name)
}

export function mcpMention(name: string): string {
  return `@${MCP_MENTION_PREFIX}${name}`
}

export function splitMcpMentions(text: string): { text: string; names: string[] } {
  const names = new Set<string>()
  const request = text.replace(MENTION, (_match, before: string, name: string) => {
    names.add(name)
    return before
  })
  return names.size ? { text: request.trim(), names: [...names] } : { text, names: [] }
}

/** A full-width at sign keeps the literal connector reference out of OMP's file parser. */
export function escapeMcpFileMentions(text: string): string {
  return text.replace(MENTION, match => match.replace('@', '＠'))
}
