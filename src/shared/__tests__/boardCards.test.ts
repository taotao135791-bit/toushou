import { describe, expect, it } from 'vitest'
import { BOARD_CARDS_LIMITS, cardsToWidgets, parseBoardCardsProposal } from '../boardCards'

const VALID = JSON.stringify({
  version: 1,
  cards: [
    { type: 'metric', title: '本周花费', value: 1234, unit: 'USD', delta: -12.5, deltaLabel: '环比' },
    { type: 'list', title: '待办清单', items: ['暂停低效广告组', '补充否定关键词'] },
    { type: 'note', title: '结论', text: 'ROI 连续三周上升。' },
    { type: 'file', title: '周报图表', filePath: 'reports/weekly.html' }
  ]
})

function parse(raw: string | unknown) {
  return parseBoardCardsProposal(typeof raw === 'string' ? raw : JSON.stringify(raw))
}

describe('parseBoardCardsProposal — valid documents', () => {
  it('parses a full valid proposal with no issues', () => {
    const result = parse(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.issues).toEqual([])
    expect(result.proposal.version).toBe(1)
    expect(result.proposal.cards.map((card) => card.type)).toEqual(['metric', 'list', 'note', 'file'])
    expect(result.proposal.cards[0]).toEqual({
      type: 'metric',
      title: '本周花费',
      value: 1234,
      unit: 'USD',
      delta: -12.5,
      deltaLabel: '环比'
    })
  })

  it('keeps optional metric fields absent when omitted', () => {
    const result = parse({ version: 1, cards: [{ type: 'metric', title: 'Spend', value: 0 }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.cards[0]).toEqual({ type: 'metric', title: 'Spend', value: 0 })
  })

  it('accepts nested file paths and title lengths at the exact limits', () => {
    const longTitle = 'a'.repeat(BOARD_CARDS_LIMITS.maxTitleLength)
    const result = parse({ version: 1, cards: [{ type: 'file', title: longTitle, filePath: 'a/b/c.PNG' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.cards[0]).toEqual({ type: 'file', title: longTitle, filePath: 'a/b/c.PNG' })
  })
})

describe('parseBoardCardsProposal — envelope strictness', () => {
  it('rejects invalid JSON', () => {
    const result = parseBoardCardsProposal('{not json')
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.level).toBe('error')
  })

  it('rejects non-object documents (arrays, numbers, null)', () => {
    for (const raw of ['[]', '42', 'null', '"x"']) {
      const result = parseBoardCardsProposal(raw)
      expect(result.ok).toBe(false)
    }
  })

  it('rejects a missing or wrong version', () => {
    for (const version of [undefined, 2, '1', null]) {
      const result = parse({ version, cards: [{ type: 'note', title: 't', text: 'x' }] })
      expect(result.ok).toBe(false)
    }
  })

  it('rejects a missing or empty cards array', () => {
    for (const cards of [undefined, 'nope', []]) {
      const result = parse({ version: 1, cards })
      expect(result.ok).toBe(false)
    }
  })

  it('truncates to the first 12 cards with a warning', () => {
    const card = { type: 'note', title: 'n', text: 'x' }
    const cards = Array.from({ length: BOARD_CARDS_LIMITS.maxCards + 3 }, () => card)
    const result = parse({ version: 1, cards })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.cards).toHaveLength(BOARD_CARDS_LIMITS.maxCards)
    expect(result.issues).toEqual([
      { level: 'warning', card: null, message: expect.stringContaining('12') }
    ])
  })

  it('fails when the raw text is empty or over the byte cap', () => {
    expect(parseBoardCardsProposal('').ok).toBe(false)
    expect(parseBoardCardsProposal('   \n  ').ok).toBe(false)
    const huge = `{ "version": 1, "cards": [] }${' '.repeat(BOARD_CARDS_LIMITS.maxBytes + 1)}`
    expect(parseBoardCardsProposal(huge).ok).toBe(false)
  })
})

describe('parseBoardCardsProposal — per-card leniency', () => {
  it('drops unknown fields silently', () => {
    const result = parse({
      version: 1,
      cards: [{ type: 'note', title: 't', text: 'x', onclick: 'evil()', style: 'color: red' }]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.cards[0]).toEqual({ type: 'note', title: 't', text: 'x' })
    expect(result.issues).toEqual([])
  })

  it('skips invalid cards with warnings and keeps the valid ones', () => {
    const result = parse({
      version: 1,
      cards: [
        'not-an-object',
        { type: 'spreadsheet', title: 'unknown type' },
        { type: 'note', title: '   ', text: 'no title' },
        { type: 'note', title: 'x'.repeat(61), text: 'title too long' },
        { type: 'metric', title: 'no value' },
        { type: 'list', title: 'no items' },
        { type: 'note', title: 'no text' },
        { type: 'file', title: 'abs path', filePath: '/etc/passwd' },
        { type: 'file', title: 'escape', filePath: '../../.ssh/id_rsa.png' },
        { type: 'file', title: 'bad ext', filePath: 'notes.txt' },
        { type: 'note', title: 'keeper', text: 'still here' }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.cards).toHaveLength(1)
    expect(result.proposal.cards[0]).toEqual({ type: 'note', title: 'keeper', text: 'still here' })
    expect(result.issues.filter((issue) => issue.level === 'warning')).toHaveLength(10)
  })

  it('fails when every card is invalid', () => {
    const result = parse({ version: 1, cards: [{ type: 'metric', title: 'no value' }] })
    expect(result.ok).toBe(false)
    const errors = result.issues.filter((issue) => issue.level === 'error')
    expect(errors.some((issue) => issue.message.includes('No valid cards'))).toBe(true)
  })

  it('reports the 0-based card index on warnings', () => {
    const result = parse({ version: 1, cards: [{ type: 'note', title: 'ok', text: 'x' }, { type: 'note', title: 'missing text' }] })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([
      { level: 'warning', card: 1, message: expect.stringContaining('text') }
    ])
  })

  it('trims string fields and drops empty-but-present optional fields', () => {
    const result = parse({
      version: 1,
      cards: [{ type: 'metric', title: '  Padded  ', value: 5, unit: '  ', deltaLabel: '  ' }]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.cards[0]).toEqual({ type: 'metric', title: 'Padded', value: 5 })
  })
})

describe('parseBoardCardsProposal — field bounds', () => {
  it('enforces metric unit/deltaLabel length caps (field dropped, card kept)', () => {
    const result = parse({
      version: 1,
      cards: [
        {
          type: 'metric',
          title: 'm',
          value: 1,
          unit: 'u'.repeat(BOARD_CARDS_LIMITS.maxUnitLength + 1),
          deltaLabel: 'd'.repeat(BOARD_CARDS_LIMITS.maxDeltaLabelLength + 1)
        }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.cards[0]).toEqual({ type: 'metric', title: 'm', value: 1 })
    expect(result.issues.filter((issue) => issue.level === 'warning')).toHaveLength(2)
  })

  it('drops non-finite or wrongly typed metric deltas with a warning', () => {
    const result = parse({ version: 1, cards: [{ type: 'metric', title: 'm', value: 1, delta: 'up' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.cards[0]).toEqual({ type: 'metric', title: 'm', value: 1 })
    expect(result.issues[0]?.level).toBe('warning')
  })

  it('drops null/NaN-style metric values (card skipped)', () => {
    const result = parse({ version: 1, cards: [{ type: 'metric', title: 'm', value: null }] })
    expect(result.ok).toBe(false)
  })

  it('enforces list item bounds: non-strings and over-long items dropped, list truncated', () => {
    const items = [
      42,
      '   ',
      'x'.repeat(BOARD_CARDS_LIMITS.maxListItemTextLength + 1),
      ...Array.from({ length: BOARD_CARDS_LIMITS.maxListItems + 1 }, (_, index) => `item-${index}`)
    ]
    const result = parse({ version: 1, cards: [{ type: 'list', title: 'big', items }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const card = result.proposal.cards[0]
    expect(card.type).toBe('list')
    if (card.type !== 'list') return
    expect(card.items).toHaveLength(BOARD_CARDS_LIMITS.maxListItems)
    expect(card.items[0]).toBe('item-0')
    expect(result.issues.some((issue) => issue.message.includes('truncated'))).toBe(true)
    expect(result.issues.some((issue) => issue.message.includes('dropped'))).toBe(true)
  })

  it('skips a list whose items are all unusable', () => {
    const result = parse({ version: 1, cards: [{ type: 'list', title: 'empty', items: [1, '', '   '] }] })
    expect(result.ok).toBe(false)
  })

  it('skips a note over the text cap', () => {
    const result = parse({
      version: 1,
      cards: [{ type: 'note', title: 'n', text: 'x'.repeat(BOARD_CARDS_LIMITS.maxNoteLength + 1) }]
    })
    expect(result.ok).toBe(false)
  })

  it('rejects file cards with dot segments, home shortcuts, drive letters and control chars', () => {
    for (const filePath of ['./a.png', 'a/../b.png', '~x/a.png', 'C:\\x\\a.png', 'a\u0000b.png', 'a\u0010b.png']) {
      const result = parse({ version: 1, cards: [{ type: 'file', title: 'f', filePath }] })
      expect(result.ok).toBe(false)
    }
  })})

describe('cardsToWidgets — proposal → widget mapping', () => {
  it('maps metric/list/note/file cards onto the existing widget types', () => {
    const result = parse(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const widgets = cardsToWidgets(result.proposal)
    expect(widgets.map((widget) => widget.type)).toEqual(['counter', 'todo', 'note', 'file'])
    expect(widgets.map((widget) => widget.title)).toEqual(['本周花费', '待办清单', '结论', '周报图表'])
    expect(widgets[0].config).toMatchObject({ value: 1234, label: 'USD · 环比 -12.5' })
    expect(widgets[1].config.items).toHaveLength(2)
    expect(widgets[1].config.items).toEqual([
      expect.objectContaining({ text: '暂停低效广告组', done: false }),
      expect.objectContaining({ text: '补充否定关键词', done: false })
    ])
    expect(widgets[2].config).toEqual({ text: 'ROI 连续三周上升。' })
    expect(widgets[3].config).toEqual({ filePath: 'reports/weekly.html' })
    // Layouts are grid-safe and pairwise distinct.
    const keys = new Set(widgets.map((widget) => `${widget.layout.x},${widget.layout.y}`))
    expect(keys.size).toBe(widgets.length)
    for (const widget of widgets) {
      expect(widget.layout.x + widget.layout.w).toBeLessThanOrEqual(12)
      expect(widget.layout.h).toBeLessThanOrEqual(20)
    }
  })

  it('computes slots against widgets already on the board', () => {
    const result = parse({ version: 1, cards: [{ type: 'note', title: 'n', text: 'x' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const placed = [
      {
        id: 'existing',
        type: 'note' as const,
        title: 'Existing',
        layout: { x: 0, y: 0, w: 12, h: 5 },
        config: { text: '' }
      }
    ]
    const [widget] = cardsToWidgets(result.proposal, placed)
    expect(widget.layout.y).toBeGreaterThanOrEqual(5)
  })

  it('formats positive deltas with an explicit plus sign', () => {
    const result = parse({ version: 1, cards: [{ type: 'metric', title: 'm', value: 7, delta: 3.5, deltaLabel: 'wow' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [widget] = cardsToWidgets(result.proposal)
    expect(widget.config.label).toBe('wow +3.5')
  })
})
