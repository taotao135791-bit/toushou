import { describe, it, expect } from 'vitest'
import { BoardWidget, KanbanBoard } from '../types'
import {
  BOARD_LIMITS,
  WIDGET_DEFAULT_SIZES,
  WIDGET_TYPES,
  compactWidgets,
  composeBoard,
  createBoard,
  createWidget,
  defaultWidgetConfig,
  detectPreset,
  findFreeSlot,
  migrateBoard,
  overseasAdsPreset,
  reflowWidgets,
  validateBoard
} from '../boards'

function validBoard(): KanbanBoard {
  return {
    id: 'board-1',
    name: 'My board',
    description: 'side project',
    widgets: [
      {
        id: 'w1',
        type: 'counter',
        title: 'Commits',
        layout: { x: 0, y: 0, w: 3, h: 2 },
        config: { value: 42, label: 'this week' }
      },
      {
        id: 'w2',
        type: 'todo',
        title: 'Todo',
        layout: { x: 3, y: 0, w: 4, h: 6 },
        config: { items: [{ id: 'i1', text: 'Ship it', done: true }] }
      }
    ],
    createdAt: 1000,
    updatedAt: 2000
  }
}

/** Board with a single widget of the given type/config/layout, run through validateBoard. */
function withWidget(widget: unknown) {
  return validateBoard({ ...validBoard(), widgets: [widget] })
}

function widgetOf(type: string, config: unknown, layout: unknown = { x: 0, y: 0, w: 2, h: 2 }) {
  return { id: 'w', type, title: 'w', layout, config }
}

describe('validateBoard', () => {
  it('accepts a well-formed v2 board unchanged', () => {
    expect(validateBoard(validBoard())).toEqual(validBoard())
  })

  it('rejects non-objects and boards with bad scalar fields', () => {
    expect(validateBoard(null)).toBeNull()
    expect(validateBoard('board')).toBeNull()
    expect(validateBoard([])).toBeNull()
    expect(validateBoard({})).toBeNull()
    expect(validateBoard({ ...validBoard(), widgets: undefined })).toBeNull()
    expect(validateBoard({ ...validBoard(), name: '' })).toBeNull()
    expect(validateBoard({ ...validBoard(), name: '   ' })).toBeNull()
    expect(
      validateBoard({ ...validBoard(), name: 'x'.repeat(BOARD_LIMITS.maxNameLength + 1) })
    ).toBeNull()
    expect(validateBoard({ ...validBoard(), id: 'bad\nid' })).toBeNull()
    expect(validateBoard({ ...validBoard(), createdAt: Number.NaN })).toBeNull()
    expect(validateBoard({ ...validBoard(), updatedAt: -5 })).toBeNull()
  })

  it('rejects oversized or wrongly-typed descriptions and normalizes empty ones away', () => {
    expect(
      validateBoard({ ...validBoard(), description: 'x'.repeat(BOARD_LIMITS.maxDescriptionLength + 1) })
    ).toBeNull()
    expect(validateBoard({ ...validBoard(), description: 42 })).toBeNull()
    const board = validateBoard({ ...validBoard(), description: '' })
    expect(board).not.toBeNull()
    expect(board?.description).toBeUndefined()
  })

  it('accepts an empty widget list (cleared boards stay valid)', () => {
    const board = validateBoard({ ...validBoard(), widgets: [] })
    expect(board).toEqual({ ...validBoard(), widgets: [] })
  })

  it('persists bounded board and widget appearance tokens, dropping malformed cosmetic input only', () => {
    const board = validateBoard({
      ...validBoard(),
      style: { background: '#101112', grid: 'dots' },
      widgets: [
        {
          ...validBoard().widgets[0],
          style: {
            accent: '#D97757',
            surface: '#1d1c1a',
            text: '#ebe7e4',
            border: '#625d57',
            radius: 20,
            padding: 14,
            titleAlign: 'center',
            shadow: 'strong'
          }
        }
      ]
    })
    expect(board?.style).toEqual({ background: '#101112', grid: 'dots' })
    expect(board?.widgets[0].style).toEqual({
      accent: '#d97757',
      surface: '#1d1c1a',
      text: '#ebe7e4',
      border: '#625d57',
      radius: 20,
      padding: 14,
      titleAlign: 'center',
      shadow: 'strong'
    })

    const malformed = validateBoard({
      ...validBoard(),
      style: { background: 'url(javascript:alert(1))', grid: 'everything' },
      widgets: [{ ...validBoard().widgets[0], style: { accent: 'red', radius: 99 } }]
    })
    expect(malformed?.style).toBeUndefined()
    expect(malformed?.widgets[0].style).toBeUndefined()
  })

  it('drops invalid widgets but keeps the board', () => {
    const board = validateBoard({
      ...validBoard(),
      widgets: [
        validBoard().widgets[0],
        null,
        'nope',
        widgetOf('not-a-type', {}),
        { ...widgetOf('note', {}), id: '' },
        { ...widgetOf('note', {}), title: 'x'.repeat(BOARD_LIMITS.maxWidgetTitleLength + 1) },
        { ...widgetOf('note', {}), layout: 'grid' },
        { ...widgetOf('note', {}), config: [] }
      ]
    })
    expect(board?.widgets.map((w) => w.id)).toEqual(['w1'])
  })

  it('drops duplicate widget ids, keeping the first', () => {
    const widget = validBoard().widgets[0]
    const board = validateBoard({ ...validBoard(), widgets: [widget, { ...widget, title: 'copy' }] })
    expect(board?.widgets).toHaveLength(1)
    expect(board?.widgets[0].title).toBe('Commits')
  })

  it('caps the widget count at the limit', () => {
    const widgets: BoardWidget[] = Array.from({ length: BOARD_LIMITS.maxWidgets + 5 }, (_, i) => ({
      id: `w-${i}`,
      type: 'note',
      title: `n${i}`,
      layout: { x: 0, y: i * 2, w: 2, h: 2 },
      config: {}
    }))
    expect(validateBoard({ ...validBoard(), widgets })?.widgets).toHaveLength(BOARD_LIMITS.maxWidgets)
  })

  it('enforces layout ranges and floors fractional values', () => {
    expect(withWidget(widgetOf('note', {}, { x: 0, y: 0, w: 1, h: 1 }))?.widgets).toHaveLength(1)
    expect(withWidget(widgetOf('note', {}, { x: 0, y: 0, w: 12, h: 20 }))?.widgets).toHaveLength(1)
    expect(withWidget(widgetOf('note', {}, { x: -1, y: 0, w: 1, h: 1 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('note', {}, { x: 12, y: 0, w: 1, h: 1 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('note', {}, { x: 0, y: 0, w: 13, h: 1 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('note', {}, { x: 6, y: 0, w: 7, h: 1 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('note', {}, { x: 0, y: -1, w: 1, h: 1 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('note', {}, { x: 0, y: 0, w: 1, h: 0 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('note', {}, { x: 0, y: 0, w: 1, h: 21 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('note', {}, { x: 0, y: 0, w: 1, h: Number.NaN }))?.widgets).toHaveLength(0)
    const floored = withWidget(widgetOf('note', {}, { x: 1.9, y: 0.5, w: 2, h: 2 }))
    expect(floored?.widgets[0].layout).toEqual({ x: 1, y: 0, w: 2, h: 2 })
  })

  it('validates note configs against the text limit', () => {
    expect(withWidget(widgetOf('note', { text: 'hello' }))?.widgets[0].config).toEqual({
      text: 'hello'
    })
    expect(
      withWidget(widgetOf('note', { text: 'x'.repeat(BOARD_LIMITS.maxNoteLength + 1) }))?.widgets
    ).toHaveLength(0)
    expect(withWidget(widgetOf('note', { text: 5 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('note', {}))?.widgets).toHaveLength(1)
  })

  it('validates counter configs and strips unknown keys', () => {
    const board = withWidget(widgetOf('counter', { value: 3, label: 'x', hack: 'y' }))
    expect(board?.widgets[0].config).toEqual({ value: 3, label: 'x' })
    expect(withWidget(widgetOf('counter', { value: 'lots' }))?.widgets).toHaveLength(0)
    expect(
      withWidget(widgetOf('counter', { value: 1, label: 'x'.repeat(BOARD_LIMITS.maxLabelLength + 1) }))
        ?.widgets
    ).toHaveLength(0)
    expect(withWidget(widgetOf('counter', {}))?.widgets).toHaveLength(1)
  })

  it('clamps nothing but enforces the gauge 0-100 range', () => {
    expect(withWidget(widgetOf('gauge', { value: 0 }))?.widgets).toHaveLength(1)
    expect(withWidget(widgetOf('gauge', { value: 100 }))?.widgets).toHaveLength(1)
    expect(withWidget(widgetOf('gauge', { value: 100.5 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('gauge', { value: -1 }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('gauge', { value: '50' }))?.widgets).toHaveLength(0)
  })

  it('validates chart points and labels', () => {
    const ok = withWidget(widgetOf('chart-line', { points: [1, 2.5, -3], labels: ['a', 'b'] }))
    expect(ok?.widgets[0].config).toEqual({ points: [1, 2.5, -3], labels: ['a', 'b'] })
    expect(withWidget(widgetOf('chart-bar', { points: [1, 'x'] }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('chart-line', { points: '1,2,3' }))?.widgets).toHaveLength(0)
    const tooMany = Array.from({ length: BOARD_LIMITS.maxChartPoints + 1 }, () => 1)
    expect(withWidget(widgetOf('chart-line', { points: tooMany }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('chart-line', { points: [1], labels: [5] }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('chart-line', {}))?.widgets).toHaveLength(1)
  })

  it('drops bad todo items but keeps the widget', () => {
    const board = withWidget(
      widgetOf('todo', {
        items: [
          { id: 'a', text: 'keep', done: false },
          { id: 'a', text: 'dupe', done: false },
          { text: 'no id', done: false },
          { id: 'b', text: 'x'.repeat(BOARD_LIMITS.maxTodoTextLength + 1), done: false },
          { id: 'c', text: 'bad done', done: 'yes' },
          'garbage',
          { id: 'd', text: 'also keep' }
        ]
      })
    )
    expect(board?.widgets).toHaveLength(1)
    expect(board?.widgets[0].config.items).toEqual([
      { id: 'a', text: 'keep', done: false },
      { id: 'd', text: 'also keep', done: false }
    ])
  })

  it('enforces the link URL policy', () => {
    expect(withWidget(widgetOf('link', { url: 'https://example.com/page?q=1' }))?.widgets).toHaveLength(1)
    expect(withWidget(widgetOf('link', { url: 'http://localhost:3000/x' }))?.widgets).toHaveLength(1)
    expect(withWidget(widgetOf('link', { url: 'http://127.0.0.1' }))?.widgets).toHaveLength(1)
    expect(withWidget(widgetOf('link', { url: 'http://example.com' }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('link', { url: 'http://localhost.evil.com' }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('link', { url: 'javascript:alert(1)' }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('link', { url: 'file:///etc/passwd' }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('link', { url: 'https://' }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('link', {}))?.widgets).toHaveLength(0)
  })

  it('validates clock configs', () => {
    expect(withWidget(widgetOf('clock', { showSeconds: false }))?.widgets[0].config).toEqual({
      showSeconds: false
    })
    expect(withWidget(widgetOf('clock', { showSeconds: 'yes' }))?.widgets).toHaveLength(0)
    expect(withWidget(widgetOf('clock', {}))?.widgets).toHaveLength(1)
  })

  it('validates the dataset source branch of counter configs', () => {
    const ok = withWidget(
      widgetOf('counter', { source: 'dataset', datasetId: 'ds-1', metric: '消耗', op: 'sum' })
    )
    expect(ok?.widgets[0].config).toEqual({
      source: 'dataset',
      datasetId: 'ds-1',
      metric: '消耗',
      op: 'sum'
    })
    // Binding fields survive alongside manual ones when toggling sources.
    const both = withWidget(
      widgetOf('counter', { value: 5, source: 'manual', datasetId: 'ds-1', metric: '消耗', op: 'avg' })
    )
    expect(both?.widgets[0].config).toEqual({
      value: 5,
      source: 'manual',
      datasetId: 'ds-1',
      metric: '消耗',
      op: 'avg'
    })
  })

  it('rejects bad source enums and incomplete dataset bindings', () => {
    expect(withWidget(widgetOf('counter', { source: 'auto' }))?.widgets).toHaveLength(0)
    // source 'dataset' requires datasetId + metric + op …
    expect(withWidget(widgetOf('counter', { source: 'dataset' }))?.widgets).toHaveLength(0)
    expect(
      withWidget(widgetOf('counter', { source: 'dataset', datasetId: 'd', metric: 'm' }))?.widgets
    ).toHaveLength(0)
    expect(
      withWidget(widgetOf('counter', { source: 'dataset', datasetId: 'd', metric: 'm', op: 'median' }))
        ?.widgets
    ).toHaveLength(0)
    // … and charts additionally require a dimension.
    expect(
      withWidget(widgetOf('chart-line', { source: 'dataset', datasetId: 'd', metric: 'm', op: 'sum' }))
        ?.widgets
    ).toHaveLength(0)
    expect(
      withWidget(
        widgetOf('chart-bar', { source: 'dataset', datasetId: 'd', metric: 'm', op: 'sum', dimension: '渠道' })
      )?.widgets
    ).toHaveLength(1)
  })

  it('enforces field limits and control chars on the dataset binding', () => {
    const longId = 'x'.repeat(101)
    expect(
      withWidget(widgetOf('counter', { source: 'dataset', datasetId: longId, metric: 'm', op: 'sum' }))
        ?.widgets
    ).toHaveLength(0)
    const longColumn = 'x'.repeat(201)
    expect(
      withWidget(widgetOf('counter', { source: 'dataset', datasetId: 'd', metric: longColumn, op: 'sum' }))
        ?.widgets
    ).toHaveLength(0)
    expect(
      withWidget(
        widgetOf('chart-line', { source: 'dataset', datasetId: 'd', metric: 'm', op: 'sum', dimension: longColumn })
      )?.widgets
    ).toHaveLength(0)
    expect(withWidget(widgetOf('counter', { datasetId: 'd\nx' }))?.widgets).toHaveLength(0)
  })

  it('strips dataset keys from types without a source branch (gauge)', () => {
    const board = withWidget(widgetOf('gauge', { value: 10, source: 'dataset', datasetId: 'd' }))
    expect(board?.widgets[0].config).toEqual({ value: 10 })
  })
})

describe('factories', () => {
  it('createBoard makes an empty, valid v2 board', () => {
    const board = createBoard('Fresh', 1234)
    expect(board).toEqual({ id: board.id, name: 'Fresh', widgets: [], createdAt: 1234, updatedAt: 1234 })
    expect(validateBoard(board)).toEqual(board)
  })

  it('createWidget produces a valid widget of every type', () => {
    for (const type of WIDGET_TYPES) {
      const widget = createWidget(type, type, { x: 0, y: 0 })
      expect(widget.layout).toEqual({ x: 0, y: 0, ...WIDGET_DEFAULT_SIZES[type] })
      expect(widget.config).toEqual(defaultWidgetConfig(type))
      const board = { ...createBoard('B', 1), widgets: [widget] }
      expect(validateBoard(board)).not.toBeNull()
      expect(validateBoard(board)?.widgets[0].type).toBe(type)
    }
  })
})

describe('composeBoard + presets', () => {
  // Identity translator: display text is asserted as the i18n keys themselves.
  const t = (key: string) => key

  it('matches every ads keyword variant, case-insensitively', () => {
    const variants = [
      '广告',
      '投放',
      '谷歌',
      '消耗',
      'google trends',
      'Google',
      'fb account',
      'FB',
      'facebook',
      'FACEBOOK pixel',
      'meta',
      'META campaigns',
      'tiktok',
      'TikTok Shop',
      'tt ads',
      'TT',
      'roas',
      'ROAS 目标'
    ]
    for (const text of variants) {
      expect(detectPreset(text), text).toBe('ads')
      expect(composeBoard(text, t).name).toBe('boards.preset.ads')
    }
  })

  it('does not match short tokens inside other words', () => {
    expect(detectPreset('a little button collection')).toBe('daily')
    expect(detectPreset('my fbbbbb board')).toBe('daily')
  })

  it('matches finance keywords', () => {
    for (const text of ['财经', '股票', 'stock market', 'Stock', 'clock', 'a CLOCK widget']) {
      expect(detectPreset(text), text).toBe('finance')
      expect(composeBoard(text, t).name).toBe('boards.preset.finance')
    }
  })

  it('falls back to the daily preset for unknown or empty descriptions', () => {
    expect(composeBoard('一个记录生活的看板', t).name).toBe('boards.preset.daily')
    expect(composeBoard('', t).name).toBe('boards.preset.daily')
    expect(composeBoard('   ', t).name).toBe('boards.preset.daily')
  })

  it('lets a chip-selected preset bypass keyword detection', () => {
    expect(composeBoard('股票行情', t, 'ads').name).toBe('boards.preset.ads')
    expect(composeBoard('广告投放', t, 'finance').name).toBe('boards.preset.finance')
    expect(composeBoard('google ads', t, 'daily').name).toBe('boards.preset.daily')
    const blank = composeBoard('广告', t, 'blank')
    expect(blank.name).toBe('boards.preset.blank')
    expect(blank.widgets).toEqual([])
  })

  it('composes boards that survive validateBoard intact', () => {
    for (const description of ['广告投放', '股票', 'anything else', '']) {
      const composed = composeBoard(description, t)
      const board = { ...createBoard(composed.name, 1), widgets: composed.widgets }
      const validated = validateBoard(board)
      expect(validated).not.toBeNull()
      expect(validated?.widgets).toHaveLength(composed.widgets.length)
    }
  })
})

describe('overseasAdsPreset', () => {
  const t = (key: string) => key

  it('builds nine widgets of the expected types and passes validation', () => {
    const widgets = overseasAdsPreset(t)
    expect(widgets.map((w) => w.type)).toEqual([
      'counter',
      'counter',
      'counter',
      'counter',
      'chart-line',
      'chart-bar',
      'gauge',
      'todo',
      'note'
    ])
    const board = { ...createBoard('Ads', 1), widgets }
    expect(validateBoard(board)?.widgets).toHaveLength(9)
  })

  it('lays out four zeroed KPI counters across the top row', () => {
    const counters = overseasAdsPreset(t).filter((w) => w.type === 'counter')
    expect(counters).toHaveLength(4)
    expect(counters.map((w) => w.layout)).toEqual([
      { x: 0, y: 0, w: 3, h: 3 },
      { x: 3, y: 0, w: 3, h: 3 },
      { x: 6, y: 0, w: 3, h: 3 },
      { x: 9, y: 0, w: 3, h: 3 }
    ])
    for (const counter of counters) {
      expect(counter.config).toEqual({ value: 0 })
    }
    expect(counters.map((w) => w.title)).toEqual([
      'boards.preset.ads.kpiSpend',
      'boards.preset.ads.kpiImpressions',
      'boards.preset.ads.kpiClicks',
      'boards.preset.ads.kpiConversions'
    ])
  })

  it('seeds the line chart with seven placeholder points', () => {
    const line = overseasAdsPreset(t).find((w) => w.type === 'chart-line')
    expect(line?.title).toBe('boards.preset.ads.trend')
    expect(line?.config.points).toHaveLength(7)
    expect(line?.layout).toEqual({ x: 0, y: 3, w: 6, h: 6 })
  })

  it('compares the three ad channels in the bar chart', () => {
    const bar = overseasAdsPreset(t).find((w) => w.type === 'chart-bar')
    expect(bar?.title).toBe('boards.preset.ads.channels')
    expect(bar?.config.labels).toEqual(['Google', 'Meta', 'TikTok'])
    expect(bar?.config.points).toHaveLength(3)
    expect(bar?.layout).toEqual({ x: 6, y: 3, w: 6, h: 6 })
  })

  it('zeroes the budget gauge with an i18n label', () => {
    const gauge = overseasAdsPreset(t).find((w) => w.type === 'gauge')
    expect(gauge?.title).toBe('boards.preset.ads.budget')
    expect(gauge?.config).toEqual({ value: 0, label: 'boards.preset.ads.budgetLabel' })
    expect(gauge?.layout).toEqual({ x: 0, y: 9, w: 4, h: 5 })
  })

  it('seeds the optimization checklist and an empty note', () => {
    const widgets = overseasAdsPreset(t)
    const todo = widgets.find((w) => w.type === 'todo')
    expect(todo?.title).toBe('boards.preset.ads.todo')
    expect(todo?.layout).toEqual({ x: 4, y: 9, w: 4, h: 6 })
    const items = todo?.config.items as { id: string; text: string; done: boolean }[]
    expect(items.map((i) => i.text)).toEqual([
      'boards.preset.ads.todoSearchTerms',
      'boards.preset.ads.todoCreatives',
      'boards.preset.ads.todoBudget',
      'boards.preset.ads.todoTracking'
    ])
    expect(items.every((i) => i.done === false && i.id.length > 0)).toBe(true)
    const note = widgets.find((w) => w.type === 'note')
    expect(note?.title).toBe('boards.preset.ads.note')
    expect(note?.config).toEqual({ text: '' })
    expect(note?.layout).toEqual({ x: 8, y: 9, w: 4, h: 5 })
  })
})

describe('layout helpers', () => {
  const widgetAt = (x: number, y: number, w: number, h: number, id = `${x},${y}`): BoardWidget => ({
    id,
    type: 'note',
    title: id,
    layout: { x, y, w, h },
    config: {}
  })

  it('findFreeSlot returns the first gap scanning rows top to bottom', () => {
    expect(findFreeSlot([], 4, 2)).toEqual({ x: 0, y: 0 })
    expect(findFreeSlot([widgetAt(0, 0, 4, 2), widgetAt(8, 0, 4, 2)], 4, 2)).toEqual({ x: 4, y: 0 })
    expect(findFreeSlot([widgetAt(0, 0, 12, 2)], 4, 2)).toEqual({ x: 0, y: 2 })
  })

  it('compactWidgets slides widgets up until they rest on something', () => {
    const a = widgetAt(0, 0, 4, 2, 'a')
    const b = widgetAt(0, 5, 4, 2, 'b')
    const c = widgetAt(4, 3, 4, 2, 'c')
    const compacted = compactWidgets([a, b, c])
    expect(compacted.find((w) => w.id === 'a')?.layout.y).toBe(0)
    expect(compacted.find((w) => w.id === 'b')?.layout.y).toBe(2)
    expect(compacted.find((w) => w.id === 'c')?.layout.y).toBe(0)
    // Original array order is preserved.
    expect(compacted.map((w) => w.id)).toEqual(['a', 'b', 'c'])
  })

  it('reflowWidgets re-packs widgets row by row, keeping sizes', () => {
    const widgets = [widgetAt(9, 9, 6, 2, 'a'), widgetAt(0, 0, 6, 3, 'b'), widgetAt(3, 3, 6, 2, 'c')]
    const reflowed = reflowWidgets(widgets)
    expect(reflowed.map((w) => w.layout)).toEqual([
      { x: 0, y: 0, w: 6, h: 2 },
      { x: 6, y: 0, w: 6, h: 3 },
      { x: 0, y: 3, w: 6, h: 2 }
    ])
  })
})

describe('migrateBoard', () => {
  function v1Board() {
    return {
      id: 'legacy',
      name: 'Legacy board',
      template: 'task',
      columns: [
        {
          id: 'c1',
          title: 'boards.col.todo',
          cards: [{ id: 'k1', title: 'Write tests', note: 'unit first', createdAt: 1000 }]
        },
        { id: 'c2', title: 'Done', cards: [] }
      ],
      createdAt: 1000,
      updatedAt: 2000
    }
  }

  it('passes v2 boards through plain validation', () => {
    expect(migrateBoard(validBoard())).toEqual(validBoard())
    expect(migrateBoard({ ...validBoard(), widgets: 'nope' })).toBeNull()
  })

  it('returns null for unrecognized shapes', () => {
    expect(migrateBoard(null)).toBeNull()
    expect(migrateBoard('board')).toBeNull()
    expect(migrateBoard({ id: 'x', name: 'y' })).toBeNull()
  })

  it('converts v1 columns into todo widgets, preserving data', () => {
    const migrated = migrateBoard(v1Board())
    expect(migrated).not.toBeNull()
    expect(migrated?.id).toBe('legacy')
    expect(migrated?.name).toBe('Legacy board')
    expect(migrated?.createdAt).toBe(1000)
    expect(migrated?.updatedAt).toBe(2000)
    expect(migrated?.widgets).toEqual([
      {
        id: 'c1',
        type: 'todo',
        title: 'Todo',
        layout: { x: 0, y: 0, w: 4, h: 6 },
        config: { items: [{ id: 'k1', text: 'Write tests', done: false }] }
      },
      {
        id: 'c2',
        type: 'todo',
        title: 'Done',
        layout: { x: 4, y: 0, w: 4, h: 6 },
        config: { items: [] }
      }
    ])
  })

  it('maps every legacy template column key to plain text', () => {
    const columns = [
      'boards.col.todo',
      'boards.col.doing',
      'boards.col.done',
      'boards.col.reported',
      'boards.col.confirmed',
      'boards.col.fixing',
      'boards.col.closed',
      'boards.col.backlog',
      'boards.col.thisWeek',
      'boards.col.nextWeek',
      'boards.col.shipped'
    ].map((title, i) => ({ id: `c-${i}`, title, cards: [] }))
    const migrated = migrateBoard({ ...v1Board(), columns })
    for (const widget of migrated?.widgets ?? []) {
      expect(widget.title.startsWith('boards.col.')).toBe(false)
      expect(widget.title.length).toBeGreaterThan(0)
    }
  })

  it('wraps v1 columns onto a new row after three per row', () => {
    const columns = Array.from({ length: 4 }, (_, i) => ({ id: `c-${i}`, title: `Col ${i}`, cards: [] }))
    const migrated = migrateBoard({ ...v1Board(), columns })
    expect(migrated?.widgets.map((w) => w.layout)).toEqual([
      { x: 0, y: 0, w: 4, h: 6 },
      { x: 4, y: 0, w: 4, h: 6 },
      { x: 8, y: 0, w: 4, h: 6 },
      { x: 0, y: 6, w: 4, h: 6 }
    ])
  })

  it('skips shapeless cards and columns instead of failing', () => {
    const migrated = migrateBoard({
      ...v1Board(),
      columns: [
        'garbage',
        {
          id: 'c1',
          title: 'boards.col.doing',
          cards: [{ id: 'k1', title: '' }, { title: 'No id' }, 42, { id: 'k2', title: 'Real card' }]
        }
      ]
    })
    expect(migrated?.widgets).toHaveLength(1)
    expect(migrated?.widgets[0].title).toBe('In progress')
    const items = migrated?.widgets[0].config.items as { id: string; text: string }[]
    expect(items).toHaveLength(2)
    expect(items[1]).toEqual({ id: 'k2', text: 'Real card', done: false })
  })

  it('mints fresh ids when v1 column or card ids collide', () => {
    const migrated = migrateBoard({
      ...v1Board(),
      columns: [
        { id: 'dup', title: 'A', cards: [] },
        { id: 'dup', title: 'B', cards: [] }
      ]
    })
    const ids = migrated?.widgets.map((w) => w.id) ?? []
    expect(new Set(ids).size).toBe(2)
  })
})
