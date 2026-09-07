import { describe, expect, it } from 'vitest'
import {
  PALETTE_RECENT_SESSIONS_LIMIT,
  buildPaletteItems,
  filterPaletteItems,
  scorePaletteItem,
  type PaletteBuildDeps,
  type PaletteItem,
  type PaletteSessionSource
} from './commandPalette'

const pages = [
  { id: 'chat', path: '/', title: '对话' },
  { id: 'boards', path: '/boards', title: '看板' },
  { id: 'settings', path: '/settings', title: '设置' }
]

const live = (overrides: Partial<PaletteSessionSource> & { id: string }): PaletteSessionSource => ({
  origin: 'live',
  uuid: `uuid-${overrides.id}`,
  title: `会话 ${overrides.id}`,
  timestamp: 1_000,
  cwd: '/work/demo',
  archived: false,
  ...overrides
})

const baseDeps = (): PaletteBuildDeps => ({
  pages,
  actions: [{ id: 'newChat', title: '新建对话' }],
  sessions: [],
  tasks: [],
  untitledLabel: '未命名会话'
})

const titles = (items: PaletteItem[]) => items.map((item) => item.title)

describe('buildPaletteItems', () => {
  it('assembles pages, actions, sessions, tasks in group order', () => {
    const items = buildPaletteItems({
      ...baseDeps(),
      sessions: [live({ id: 'a' })],
      tasks: [{ id: 't1', name: '日报', cwd: '/work/demo' }],
      actions: [
        { id: 'newChat', title: '新建对话' },
        { id: 'exportHtml', title: '导出会话为 HTML', sessionId: 'a' }
      ]
    })
    expect(items.map((item) => item.kind)).toEqual(['page', 'page', 'page', 'action', 'action', 'session', 'task'])
  })

  it('carries how each item executes', () => {
    const items = buildPaletteItems({
      ...baseDeps(),
      sessions: [
        live({ id: 'a' }),
        { origin: 'history', id: 'cap-1', uuid: 'uuid-h', title: '历史', timestamp: 900, cwd: '/work/demo', archived: false },
        { origin: 'global', id: 'uuid-g', uuid: 'uuid-g', title: '跨项目', timestamp: 800, cwd: '/other/proj', archived: false }
      ],
      actions: [{ id: 'exportHtml', title: '导出', sessionId: 'a' }]
    })
    const byTitle = new Map(items.map((item) => [item.title, item.exec]))
    expect(byTitle.get('看板')).toEqual({ type: 'navigate', path: '/boards' })
    expect(byTitle.get('导出')).toEqual({ type: 'exportHtml', sessionId: 'a' })
    expect(byTitle.get('会话 a')).toEqual({ type: 'openSession', sessionId: 'a' })
    expect(byTitle.get('历史')).toEqual({ type: 'openHistory', uuid: 'uuid-h', cwd: '/work/demo' })
    expect(byTitle.get('跨项目')).toEqual({ type: 'openHistory', uuid: 'uuid-g', cwd: '/other/proj' })
  })

  it('hides archived rows and durable rows already owned by a live session', () => {
    const items = buildPaletteItems({
      ...baseDeps(),
      sessions: [
        live({ id: 'a' }),
        live({ id: 'dead', archived: true }),
        // Same durable uuid as live 'a' — the live row wins.
        { origin: 'global', id: 'uuid-a', uuid: 'uuid-a', title: '会话 a 旧记录', timestamp: 500, cwd: '/work/demo', archived: false },
        { origin: 'global', id: 'uuid-x', uuid: 'uuid-x', title: '独立记录', timestamp: 400, cwd: '/work/demo', archived: false }
      ]
    })
    expect(titles(items.filter((item) => item.kind === 'session'))).toEqual(['会话 a', '独立记录'])
  })

  it('hides global rows duplicated by a workspace history row', () => {
    const items = buildPaletteItems({
      ...baseDeps(),
      sessions: [
        { origin: 'history', id: 'cap-1', uuid: 'uuid-h', title: '能力行', timestamp: 900, cwd: '/work/demo', archived: false },
        { origin: 'global', id: 'uuid-h', uuid: 'uuid-h', title: '能力行', timestamp: 900, cwd: '/work/demo', archived: false },
        { origin: 'global', id: 'uuid-y', uuid: 'uuid-y', title: '仅全局', timestamp: 800, cwd: '/work/demo', archived: false }
      ]
    })
    expect(titles(items.filter((item) => item.kind === 'session'))).toEqual(['能力行', '仅全局'])
  })

  it('collapses resume-fork twins to the row that opens in place', () => {
    const forked = (origin: PaletteSessionSource['origin'], id: string): PaletteSessionSource => ({
      origin,
      id,
      uuid: `uuid-${id}`,
      title: '同一段对话',
      timestamp: 5_000,
      cwd: '/work/demo',
      archived: false
    })
    const items = buildPaletteItems({
      ...baseDeps(),
      sessions: [forked('global', 'g'), forked('history', 'h'), forked('live', 'l')]
    })
    expect(titles(items.filter((item) => item.kind === 'session'))).toEqual(['同一段对话'])
    // Global rows 61s apart are not twins — both stay.
    const spread = buildPaletteItems({
      ...baseDeps(),
      sessions: [
        forked('global', 'g1'),
        { ...forked('global', 'g2'), timestamp: 5_000 - 61_000 }
      ]
    })
    expect(spread.filter((item) => item.kind === 'session')).toHaveLength(2)
  })

  it('orders sessions by recency and localizes the Untitled fallback', () => {
    const items = buildPaletteItems({
      ...baseDeps(),
      sessions: [
        live({ id: 'old', timestamp: 100 }),
        live({ id: 'new', timestamp: 200 }),
        { origin: 'global', id: 'u', uuid: 'u', title: 'Untitled', timestamp: 50, cwd: '/work/demo', archived: false }
      ]
    })
    expect(titles(items.filter((item) => item.kind === 'session'))).toEqual(['会话 new', '会话 old', '未命名会话'])
  })
})

describe('filterPaletteItems with an empty query', () => {
  const items = buildPaletteItems({
    ...baseDeps(),
    sessions: Array.from({ length: 8 }, (_, i) => live({ id: String(i), timestamp: (i + 1) * 100 })),
    tasks: [{ id: 't1', name: '日报' }]
  })

  it('shows pages + actions + only recent sessions, never tasks', () => {
    const landing = filterPaletteItems(items, '')
    expect(landing.every((item) => item.kind !== 'task')).toBe(true)
    expect(landing.filter((item) => item.kind === 'page')).toHaveLength(pages.length)
    expect(landing.filter((item) => item.kind === 'action')).toHaveLength(1)
    const sessions = landing.filter((item) => item.kind === 'session')
    expect(sessions).toHaveLength(PALETTE_RECENT_SESSIONS_LIMIT)
    expect(titles(sessions)).toEqual(['会话 7', '会话 6', '会话 5', '会话 4', '会话 3'])
  })
})

describe('scorePaletteItem', () => {
  const item = (title: string, keywords?: string): PaletteItem => ({
    id: title,
    kind: 'page',
    title,
    keywords,
    exec: { type: 'navigate', path: '/' }
  })

  it('ranks exact match above word-prefix above substring above keywords', () => {
    const scores = [
      scorePaletteItem(item('设置'), '设置'),
      scorePaletteItem(item('打开设置面板'), '设置'), // no word starts with 设置 → substring
      scorePaletteItem(item('新建 设置'), '设置'), // second word prefix
      scorePaletteItem(item('导出会话', '导出会话为 html'), 'html')
    ]
    expect(scores[0]).toBeGreaterThan(scores[2])
    expect(scores[2]).toBeGreaterThan(scores[1])
    expect(scores[1]).toBeGreaterThan(scores[3])
  })

  it('matches case-insensitively and treats title prefix above inner word prefix', () => {
    expect(scorePaletteItem(item('Boards'), 'bo')).toBe(scorePaletteItem(item('boards'), 'BO'))
    expect(scorePaletteItem(item('Board view'), 'boa')).toBeGreaterThan(
      scorePaletteItem(item('My board'), 'boa')
    )
  })

  it('returns -1 when nothing matches and 0 for an empty query', () => {
    expect(scorePaletteItem(item('看板'), 'zzz')).toBe(-1)
    expect(scorePaletteItem(item('看板'), '   ')).toBe(0)
  })
})

describe('filterPaletteItems with a query', () => {
  const items = buildPaletteItems({
    ...baseDeps(),
    sessions: [
      live({ id: 'new', title: '投放数据整理', timestamp: 200 }),
      live({ id: 'old', title: '投放复盘', timestamp: 100 })
    ],
    tasks: [{ id: 't1', name: '日报任务', cwd: '/work/demo' }]
  })

  it('ranks by score then recency for equal scores', () => {
    // Both session titles substring-match 投放; pages/actions do not match at all.
    const result = filterPaletteItems(items, '投放')
    expect(titles(result)).toEqual(['投放数据整理', '投放复盘'])
  })

  it('surfaces keyword (path) matches and includes tasks only on a query', () => {
    const result = filterPaletteItems(items, '/work')
    expect(titles(result)).toEqual(['投放数据整理', '投放复盘', '日报任务'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterPaletteItems(items, 'zzz')).toEqual([])
  })

  it('exact title match beats a page substring match', () => {
    const withPage = buildPaletteItems({
      ...baseDeps(),
      pages: [...pages, { id: 'export', path: '/export', title: '导出中心' }],
      actions: [{ id: 'exportHtml', title: '导出' }]
    })
    const result = filterPaletteItems(withPage, '导出')
    expect(titles(result)).toEqual(['导出', '导出中心'])
  })
})
