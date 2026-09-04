/**
 * Defensive parser for plan/todo tool inputs. The runtime's todo tool has no
 * contract this GUI can rely on (docs/protocol-facts.md), so everything here
 * is best-effort: any shape that does not look like a checklist falls back to
 * the generic tool card. Pure functions — unit-testable in isolation.
 */

export interface TodoItem {
  label: string
  /** done | in_progress | pending — unknown markers map to pending. */
  state: 'done' | 'in_progress' | 'pending'
}

function itemState(raw: unknown): TodoItem['state'] {
  if (typeof raw !== 'string') return 'pending'
  const value = raw.toLowerCase()
  if (value === 'done' || value === 'completed' || value === 'complete' || value === 'finished') {
    return 'done'
  }
  if (value === 'in_progress' || value === 'in-progress' || value === 'active' || value === 'current' || value === 'doing') {
    return 'in_progress'
  }
  return 'pending'
}

function parseItem(raw: unknown): TodoItem | null {
  if (typeof raw === 'string') {
    const label = raw.trim()
    return label ? { label, state: 'pending' } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const label =
    (typeof obj.content === 'string' && obj.content) ||
    (typeof obj.text === 'string' && obj.text) ||
    (typeof obj.title === 'string' && obj.title) ||
    (typeof obj.subject === 'string' && obj.subject) ||
    (typeof obj.label === 'string' && obj.label) ||
    (typeof obj.task === 'string' && obj.task) ||
    ''
  const trimmed = label.trim()
  if (!trimmed) return null
  const state = itemState(
    obj.status ?? obj.state ?? (obj.completed === true ? 'done' : undefined)
  )
  return { label: trimmed.slice(0, 300), state }
}

function parseList(raw: unknown): TodoItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const items = raw.slice(0, 100).map(parseItem)
  if (items.some((item) => item === null)) return null
  return items as TodoItem[]
}

/**
 * Extract a checklist from a todo tool call input. Recognized containers, in
 * order: `todos`, `items`, `list`, `plan`, or the input itself being an
 * array. Returns null when nothing checklist-shaped is found.
 */
export function parseTodoInput(input: unknown): TodoItem[] | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  for (const key of ['todos', 'items', 'list', 'plan']) {
    if (key in obj) {
      const parsed = parseList(obj[key])
      if (parsed) return parsed
    }
  }
  return parseList(input)
}
