import { BoardDesignIssue, BoardDesignSpec } from './types'
import { validateBoardStyle, validateBoardWidgetStyle } from './boards'

/**
 * Board design file (board-design.md) — the single source of truth for board
 * appearance defaults. The format is deliberately line-based and strict:
 * `## board` / `## widget` sections with one `key: value` token per line.
 * Value domains are exactly the existing BoardStyle / BoardWidgetStyle bounds
 * (reused via their validators), so a design file can never smuggle arbitrary
 * CSS into the renderer — same policy as board JSON itself.
 */

export const BOARD_DESIGN_MAX_BYTES = 100 * 1024

/** Fence language the chat UI renders as an apply-able board design card. */
export const BOARD_DESIGN_FENCE = 'board-design'

type Section = 'board' | 'widget'

const BOARD_KEYS = ['background', 'grid'] as const
const WIDGET_KEYS = ['accent', 'surface', 'text', 'border', 'radius', 'padding', 'titleAlign', 'shadow'] as const

function issue(level: 'error' | 'warning', line: number, message: string): BoardDesignIssue {
  return { level, line, message }
}

/**
 * Parse a design document into a spec plus per-line issues. Unknown keys and
 * unrecognized lines are warnings; a value outside the BoardStyle /
 * BoardWidgetStyle domain is an error and that field is dropped from the spec.
 */
export function parseBoardDesign(markdown: string): { spec: BoardDesignSpec; issues: BoardDesignIssue[] } {
  const spec: BoardDesignSpec = { board: {}, widget: {} }
  const issues: BoardDesignIssue[] = []
  let section: Section | null = null

  const lines = markdown.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    const line = lines[index].trim()
    if (!line || line.startsWith('>')) continue
    if (line.startsWith('#')) {
      const words = line.replace(/^#+\s*/, '').trim().split(/\s+/)
      const name = (words[words.length - 1] ?? '').toLowerCase()
      section = name === 'board' || name === 'widget' ? name : null
      continue
    }
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*)$/.exec(line)
    if (!match) {
      issues.push(issue('warning', lineNumber, `Unrecognized line: "${line.slice(0, 60)}"`))
      continue
    }
    if (!section) continue
    const [, key, rawValue] = match
    const value = rawValue.trim()
    if (section === 'board') {
      if (!(BOARD_KEYS as readonly string[]).includes(key)) {
        issues.push(issue('warning', lineNumber, `Unknown board key "${key}".`))
        continue
      }
      const parsed = validateBoardStyle({ [key]: value })
      if (!parsed) {
        issues.push(issue('error', lineNumber, `Invalid value for "${key}": "${value.slice(0, 60)}".`))
        continue
      }
      Object.assign(spec.board, parsed)
      continue
    }
    if (!(WIDGET_KEYS as readonly string[]).includes(key)) {
      issues.push(issue('warning', lineNumber, `Unknown widget key "${key}".`))
      continue
    }
    // radius/padding are integers in the model; parse strictly so "0x10" or
    // "12px" cannot become a number by accident.
    let parsedValue: string | number = value
    if (key === 'radius' || key === 'padding') {
      if (!/^-?\d+$/.test(value)) {
        issues.push(issue('error', lineNumber, `Invalid value for "${key}": "${value.slice(0, 60)}".`))
        continue
      }
      parsedValue = Number(value)
    }
    const parsed = validateBoardWidgetStyle({ [key]: parsedValue })
    if (!parsed) {
      issues.push(issue('error', lineNumber, `Invalid value for "${key}": "${value.slice(0, 60)}".`))
      continue
    }
    Object.assign(spec.widget, parsed)
  }
  return { spec, issues }
}

/** Canonical, round-trippable rendering of a spec (used by tests/templates). */
export function formatBoardDesign(spec: BoardDesignSpec): string {
  const lines: string[] = ['# Board Design', '']
  const board = spec.board
  if (Object.keys(board).length > 0) {
    lines.push('## board', '')
    if (board.background !== undefined) lines.push(`background: ${board.background}`)
    if (board.grid !== undefined) lines.push(`grid: ${board.grid}`)
    lines.push('')
  }
  const widget = spec.widget
  if (Object.keys(widget).length > 0) {
    lines.push('## widget', '')
    for (const key of ['accent', 'surface', 'text', 'border'] as const) {
      if (widget[key] !== undefined) lines.push(`${key}: ${widget[key]}`)
    }
    if (widget.radius !== undefined) lines.push(`radius: ${widget.radius}`)
    if (widget.padding !== undefined) lines.push(`padding: ${widget.padding}`)
    if (widget.titleAlign !== undefined) lines.push(`titleAlign: ${widget.titleAlign}`)
    if (widget.shadow !== undefined) lines.push(`shadow: ${widget.shadow}`)
    lines.push('')
  }
  return lines.join('\n').replace(/\n+$/, '\n')
}

/**
 * Template returned (never written) when no design file exists yet. Every
 * field line is a comment so the template parses to an empty spec — an absent
 * design must leave the built-in defaults untouched.
 */
export const DEFAULT_BOARD_DESIGN_MARKDOWN = `# Board Design

> This file customizes how your boards look. It is the single source of truth
> for board appearance defaults; a widget's own appearance settings and a
> board's own canvas settings override it.
>
> Lines starting with "> " are comments. One "key: value" token per line.
> Save the file to apply — the app watches it and updates boards automatically.

## board

> background: six-digit hex color, e.g. #101014
> grid: none | dots | lines

## widget

> accent / surface / text / border: six-digit hex color, e.g. #7aa2f7
> radius: integer 0-32 (corner pixels)
> padding: integer 6-32 (pixels)
> titleAlign: left | center | right
> shadow: none | soft | strong
`
