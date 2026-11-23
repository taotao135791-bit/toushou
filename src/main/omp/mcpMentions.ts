import { escapeMcpFileMentions, splitMcpMentions } from '../../shared/mcpMentions'

type Connection = { name: string; enabled: boolean }
const SELECTED_PREFIX = 'Explicitly selected MCP connections for this turn: '
const UNAVAILABLE_PREFIX = 'These requested MCP connections are disabled or unavailable: '
const USER_MESSAGE = '\n\nUser message:\n'
const RAW_USER_PREFIX = 'User message:\n'

/** Keep the visible draft unchanged and prevent OMP from treating MCP names as file paths. */
export function mcpTurnPrompt(input: string, listConnections: () => Connection[]): string {
  const { text, names } = splitMcpMentions(input)
  if (!names.length) {
    // The native reconnect hook must see a reserved header only after Main
    // has resolved real mentions against the enabled connection list.
    return input.trimStart().startsWith(SELECTED_PREFIX) ? RAW_USER_PREFIX + input : input
  }

  let connections: Connection[] = []
  try { connections = listConnections() } catch { /* Report unavailability in the turn. */ }
  const enabled = new Set(connections.filter(connection => connection.enabled).map(connection => connection.name))
  const selected = names.filter(name => enabled.has(name))
  const unavailable = names.filter(name => !enabled.has(name))
  const sections: string[] = []

  if (selected.length) {
    sections.push(`${SELECTED_PREFIX}${selected.join(', ')}.`)
    sections.push('Use the selected MCP connections to carry out the request within the existing account, date range, and permissions. If they were skipped or had a transient failure, retry the necessary tool call. If a connection is unavailable, say which one and share any verified results already available.')
  }
  if (unavailable.length) {
    sections.push(`${UNAVAILABLE_PREFIX}${unavailable.join(', ')}. Tell the user. Do not silently substitute another connection.`)
  }
  if (!text) {
    sections.push('Continue the latest unfinished request in this conversation that needs a selected connection. Retry a read, or a step known not to have been executed. Never repeat a write whose outcome is unknown. Ask for the desired operation if the conversation does not establish it.')
  }
  return sections.join('\n\n') + USER_MESSAGE + escapeMcpFileMentions(input)
}

export function displayMcpTurnPrompt(text: string): string {
  if (text.startsWith(RAW_USER_PREFIX) && text.slice(RAW_USER_PREFIX.length).trimStart().startsWith(SELECTED_PREFIX)) {
    return text.slice(RAW_USER_PREFIX.length)
  }
  if (!text.startsWith(SELECTED_PREFIX) && !text.startsWith(UNAVAILABLE_PREFIX)) return text
  const userMessageIndex = text.indexOf(USER_MESSAGE)
  if (userMessageIndex < 0) return text
  return text.slice(userMessageIndex + USER_MESSAGE.length).replace(/＠(?=mcp:)/gi, '@')
}
