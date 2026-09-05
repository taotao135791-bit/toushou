/**
 * Tool-name normalization shared by Main (session mapping, protocol) and the
 * renderer (store streaming path).
 *
 * OMP surfaces extension tool calls as the native `write` tool with a single
 * `path` argument of the form `xd://<extensionToolName>` (verified against
 * 17.2.12 session transcripts — the browser toolkit's browser_navigate /
 * browser_screenshot / browser_snapshot all arrive this way). Remapping them
 * lets the GUI show the real tool name, classify the action correctly, and
 * attach per-tool renderers (e.g. the inline screenshot preview).
 */

const EXTENSION_TOOL_PREFIX = 'xd://'

/** Extension tool names are identifier-like; a path with separators is a real file. */
const EXTENSION_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/

export interface NormalizedToolCall {
  tool: string
  input: unknown
}

function extensionToolName(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const path = (input as Record<string, unknown>).path
  if (typeof path !== 'string' || !path.startsWith(EXTENSION_TOOL_PREFIX)) return null
  const name = path.slice(EXTENSION_TOOL_PREFIX.length)
  return EXTENSION_TOOL_NAME_RE.test(name) ? name : null
}

/**
 * Remap an `xd://` write sentinel to the real extension tool call. Non-matching
 * calls pass through untouched. The synthetic `path` marker is dropped from the
 * input; any other argument fields are preserved.
 */
export function normalizeToolCall(tool: string, input: unknown): NormalizedToolCall {
  if (tool !== 'write') return { tool, input }
  const name = extensionToolName(input)
  if (!name) return { tool, input }
  let rest: unknown = input
  if (input && typeof input === 'object') {
    const { path: _marker, ...others } = input as Record<string, unknown>
    rest = others
  }
  return { tool: name, input: rest }
}

/**
 * Extract the real extension tool name from a runtime approval prompt title
 * (e.g. "Allow tool: write\nPath: xd://browser_click\nContent: …") so the
 * GUI can show `browser_click` instead of raw `write xd://…` plumbing.
 * Display-only: the answered option strings are untouched. Returns null when
 * the title does not reference an xd:// extension call.
 */
export function approvalToolNameFromTitle(title: string): string | null {
  const match = /Path:\s*xd:\/\/(\S{1,200})/.exec(title ?? '')
  const name = match?.[1]
  // Validate the FULL segment: extension names are identifier-like, so
  // "xd://nested/file.txt" (a real file path) is rejected as a whole.
  return name && EXTENSION_TOOL_NAME_RE.test(name) ? name : null
}
