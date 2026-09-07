import { BOARD_LIMITS, WIDGET_DEFAULT_SIZES, createWidget, findFreeSlot, isValidWidgetFilePath } from './boards'
import { BoardCardsCard, BoardCardsIssue, BoardCardsParseResult, BoardCardsProposal, BoardWidget } from './types'

/**
 * Board cards proposal (```board-cards fences) — the data-card sibling of the
 * board-design protocol. The agent PROPOSES a bounded JSON document; the chat
 * UI renders it as a preview card, and only an explicit Apply hands the RAW
 * fence text to Main, which re-parses and re-validates everything before any
 * board is touched (the agent can never write boards by itself).
 *
 * The parser mirrors boardDesign.ts: pure, strict about the envelope
 * (version, card count) and lenient per card — an invalid card is skipped
 * with a warning so one malformed entry cannot hide the rest, while a
 * proposal whose cards are ALL invalid fails to parse. Unknown fields are
 * dropped silently; every kept value is bounded, so nothing here can smuggle
 * markup, CSS, or filesystem paths into the app (file paths are relative and
 * re-validated against the workspace grant in Main at read time).
 */

/** Fence language the chat UI renders as an apply-able data-cards proposal. */
export const BOARD_CARDS_FENCE = 'board-cards'

export const BOARD_CARDS_LIMITS = {
  /** Raw fence text cap (the fence is a proposal, not a data export). */
  maxBytes: 64 * 1024,
  /** Schema version; anything else is a hard error. */
  version: 1,
  maxCards: 12,
  maxTitleLength: 60,
  maxUnitLength: 12,
  maxDeltaLabelLength: 20,
  // List cards map onto todo widgets, so they share the todo item bounds.
  maxListItems: BOARD_LIMITS.maxTodoItems,
  maxListItemTextLength: BOARD_LIMITS.maxTodoTextLength,
  maxNoteLength: BOARD_LIMITS.maxNoteLength,
  maxFilePathLength: BOARD_LIMITS.maxFilePathLength
} as const

const CARD_TYPES: readonly BoardCardsCard['type'][] = ['metric', 'list', 'note', 'file']

function issue(level: 'error' | 'warning', card: number | null, message: string): BoardCardsIssue {
  return { level, card, message }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate one proposed card. Returns the cleaned card, or null when the card
 * must be skipped (a warning is recorded by the caller in either case).
 */
function parseCard(raw: unknown, index: number, issues: BoardCardsIssue[]): BoardCardsCard | null {
  if (!isPlainObject(raw)) {
    issues.push(issue('warning', index, 'Card is not an object; skipped.'))
    return null
  }
  const type = raw.type
  if (typeof type !== 'string' || !(CARD_TYPES as readonly string[]).includes(type)) {
    issues.push(issue('warning', index, `Unknown card type "${String(type).slice(0, 30)}"; skipped.`))
    return null
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) {
    issues.push(issue('warning', index, 'Card has no title; skipped.'))
    return null
  }
  if (title.length > BOARD_CARDS_LIMITS.maxTitleLength) {
    issues.push(issue('warning', index, `Card title exceeds ${BOARD_CARDS_LIMITS.maxTitleLength} characters; skipped.`))
    return null
  }

  if (type === 'metric') {
    // A metric card without a finite value is meaningless — skip it.
    if (!isFiniteNumber(raw.value)) {
      issues.push(issue('warning', index, 'Metric card has no finite "value"; skipped.'))
      return null
    }
    const card: BoardCardsCard = { type: 'metric', title, value: raw.value }
    if (raw.unit !== undefined) {
      if (typeof raw.unit !== 'string' || raw.unit.trim().length > BOARD_CARDS_LIMITS.maxUnitLength) {
        issues.push(issue('warning', index, `Metric "unit" ignored (must be ≤ ${BOARD_CARDS_LIMITS.maxUnitLength} characters).`))
      } else if (raw.unit.trim()) {
        card.unit = raw.unit.trim()
      }
    }
    if (raw.delta !== undefined && !isFiniteNumber(raw.delta)) {
      issues.push(issue('warning', index, 'Metric "delta" ignored (must be a finite number).'))
    } else if (raw.delta !== undefined) {
      card.delta = raw.delta
    }
    if (raw.deltaLabel !== undefined) {
      if (
        typeof raw.deltaLabel !== 'string' ||
        raw.deltaLabel.trim().length > BOARD_CARDS_LIMITS.maxDeltaLabelLength
      ) {
        issues.push(
          issue('warning', index, `Metric "deltaLabel" ignored (must be ≤ ${BOARD_CARDS_LIMITS.maxDeltaLabelLength} characters).`)
        )
      } else if (raw.deltaLabel.trim()) {
        card.deltaLabel = raw.deltaLabel.trim()
      }
    }
    return card
  }

  if (type === 'list') {
    if (!Array.isArray(raw.items)) {
      issues.push(issue('warning', index, 'List card has no "items" array; skipped.'))
      return null
    }
    const items: string[] = []
    for (const entry of raw.items) {
      if (items.length >= BOARD_CARDS_LIMITS.maxListItems) {
        issues.push(issue('warning', index, `List truncated to the first ${BOARD_CARDS_LIMITS.maxListItems} items.`))
        break
      }
      if (typeof entry !== 'string') {
        issues.push(issue('warning', index, 'A non-string list item was dropped.'))
        continue
      }
      const text = entry.trim()
      if (!text) continue
      if (text.length > BOARD_CARDS_LIMITS.maxListItemTextLength) {
        issues.push(issue('warning', index, `A list item exceeded ${BOARD_CARDS_LIMITS.maxListItemTextLength} characters and was dropped.`))
        continue
      }
      items.push(text)
    }
    if (items.length === 0) {
      issues.push(issue('warning', index, 'List card has no usable items; skipped.'))
      return null
    }
    return { type: 'list', title, items }
  }

  if (type === 'note') {
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (!text) {
      issues.push(issue('warning', index, 'Note card has no text; skipped.'))
      return null
    }
    if (text.length > BOARD_CARDS_LIMITS.maxNoteLength) {
      issues.push(issue('warning', index, `Note text exceeds ${BOARD_CARDS_LIMITS.maxNoteLength} characters; skipped.`))
      return null
    }
    return { type: 'note', title, text }
  }

  // type === 'file'
  const filePath = typeof raw.filePath === 'string' ? raw.filePath.trim() : ''
  if (!isValidWidgetFilePath(filePath)) {
    issues.push(
      issue('warning', index, 'File card needs a workspace-relative .png/.jpg/.html path; skipped.')
    )
    return null
  }
  return { type: 'file', title, filePath }
}

/**
 * Parse a raw ```board-cards fence body into a proposal plus per-card issues.
 * `ok: false` means the whole document is unusable (bad JSON, wrong version,
 * no usable cards at all) and must never be applied.
 */
export function parseBoardCardsProposal(raw: string): BoardCardsParseResult {
  const issues: BoardCardsIssue[] = []
  if (typeof raw !== 'string' || !raw.trim() || raw.length > BOARD_CARDS_LIMITS.maxBytes) {
    return { ok: false, issues: [issue('error', null, 'Proposal is empty or too large.')] }
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    return { ok: false, issues: [issue('error', null, 'Proposal is not valid JSON.')] }
  }
  if (!isPlainObject(document)) {
    return { ok: false, issues: [issue('error', null, 'Proposal must be a JSON object.')] }
  }
  if (document.version !== BOARD_CARDS_LIMITS.version) {
    return {
      ok: false,
      issues: [issue('error', null, `Unsupported proposal version: ${JSON.stringify(document.version ?? null).slice(0, 30)}.`)]
    }
  }
  if (!Array.isArray(document.cards)) {
    return { ok: false, issues: [issue('error', null, 'Proposal has no "cards" array.')] }
  }
  if (document.cards.length === 0) {
    return { ok: false, issues: [issue('error', null, 'Proposal has no cards.')] }
  }
  if (document.cards.length > BOARD_CARDS_LIMITS.maxCards) {
    issues.push(
      issue('warning', null, `Proposal truncated to the first ${BOARD_CARDS_LIMITS.maxCards} cards.`)
    )
  }
  const cards: BoardCardsCard[] = []
  const limit = Math.min(document.cards.length, BOARD_CARDS_LIMITS.maxCards)
  for (let index = 0; index < limit; index++) {
    const card = parseCard(document.cards[index], index, issues)
    if (card) cards.push(card)
  }
  if (cards.length === 0) {
    return {
      ok: false,
      issues: [...issues, issue('error', null, 'No valid cards in this proposal.')]
    }
  }
  const proposal: BoardCardsProposal = { version: BOARD_CARDS_LIMITS.version, cards }
  return { ok: true, proposal, issues }
}

/**
 * Map a validated proposal onto the existing board widget model. Pure: new
 * ids/slots are derived with the same factories the renderer and Main use
 * (createWidget + findFreeSlot), so applied cards land exactly as if the user
 * had added them by hand. Pass `placed` (the target board's widgets) so slots
 * are computed against what is already on the board.
 */
export function cardsToWidgets(proposal: BoardCardsProposal, placed: BoardWidget[] = []): BoardWidget[] {
  const widgets = [...placed]
  const added: BoardWidget[] = []
  for (const card of proposal.cards) {
    if (card.type === 'metric') {
      const widget = createWidget('counter', card.title, findFreeSlot(widgets, WIDGET_DEFAULT_SIZES.counter.w, WIDGET_DEFAULT_SIZES.counter.h))
      widget.config = { value: card.value, label: metricLabel(card) }
      widgets.push(widget)
      added.push(widget)
      continue
    }
    if (card.type === 'list') {
      const widget = createWidget('todo', card.title, findFreeSlot(widgets, WIDGET_DEFAULT_SIZES.todo.w, WIDGET_DEFAULT_SIZES.todo.h))
      widget.config = { items: card.items.map((text) => ({ id: crypto.randomUUID(), text, done: false })) }
      widgets.push(widget)
      added.push(widget)
      continue
    }
    if (card.type === 'note') {
      const widget = createWidget('note', card.title, findFreeSlot(widgets, WIDGET_DEFAULT_SIZES.note.w, WIDGET_DEFAULT_SIZES.note.h))
      widget.config = { text: card.text }
      widgets.push(widget)
      added.push(widget)
      continue
    }
    // card.type === 'file' — Main re-validates filePath against the active
    // workspace grant on every read; the board only stores the relative path.
    const widget = createWidget('file', card.title, findFreeSlot(widgets, WIDGET_DEFAULT_SIZES.file.w, WIDGET_DEFAULT_SIZES.file.h))
    widget.config = { filePath: card.filePath }
    widgets.push(widget)
    added.push(widget)
  }
  return added
}

/** Compact counter label for a metric card: "USD · 环比 +12.5" style. */
function metricLabel(card: Extract<BoardCardsCard, { type: 'metric' }>): string {
  const parts: string[] = []
  if (card.unit) parts.push(card.unit)
  if (card.delta !== undefined) {
    const sign = card.delta > 0 ? '+' : ''
    const delta = `${sign}${card.delta}`
    parts.push(card.deltaLabel ? `${card.deltaLabel} ${delta}` : delta)
  }
  return parts.join(' · ').slice(0, BOARD_LIMITS.maxLabelLength)
}
