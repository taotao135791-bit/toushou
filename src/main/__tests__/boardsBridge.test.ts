import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// boards.ts / boardDatasets.ts resolve default stores through electron's
// app.getPath; point every default at a fresh temp dir per test.
let userDataDir: string
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import { authorizeAndDispatch, boardConfirmationDetails, dispatch, parseBoardsBridgeRequest, readWorkspaceDataset } from '../boardsBridge'
import { listBoards } from '../boards'
import { saveBoard } from '../boards'
import { saveReadingSnapshot } from '../readingSnapshots'
import { applyBoardHighlights, validateBoardHighlights } from '../boardHighlights'
import type { ReadingSnapshot } from '../../shared/readingSnapshot'
import { createWidget } from '../../shared/boards'
import { createOrUpdateDataset, listDatasets, renameDataset } from '../boardDatasets'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'boards-bridge-'))
  userDataDir = dir
})

describe('parseBoardsBridgeRequest', () => {
  it('accepts every known action and rejects the rest', () => {
    expect(parseBoardsBridgeRequest({ action: 'boards_list' })?.action).toBe('boards_list')
    expect(parseBoardsBridgeRequest({ action: 'board_get', name: 'x' })?.action).toBe('board_get')
    expect(parseBoardsBridgeRequest({ action: 'board_check', name: 'x', mode: 'custom' })?.action).toBe('board_check')
    expect(parseBoardsBridgeRequest({ action: 'board_check', name: 'x', granularity: ['ad', 'creative'], dimensions: ['广告ID'] })).toMatchObject({ granularity: ['ad', 'creative'], dimensions: ['广告ID'] })
    expect(parseBoardsBridgeRequest({ action: 'board_create', template: 'tiktok' })?.action).toBe('board_create')
    expect(parseBoardsBridgeRequest({ action: 'board_customize', version: 1, preview: true })?.action).toBe('board_customize')
    expect(parseBoardsBridgeRequest({ action: 'af_dataset_pull', appId: 'a', eventName: 'b' })?.action).toBe('af_dataset_pull')
    expect(parseBoardsBridgeRequest({ action: 'make_coffee' })).toBeNull()
    expect(parseBoardsBridgeRequest(null)).toBeNull()
    expect(parseBoardsBridgeRequest('x')).toBeNull()
  })
})

describe('boards bridge dispatch', () => {
  it('keeps conversational date scope authoritative while visual-only edits preserve it', async () => {
    const created = await dispatch({ action: 'board_create', name: 'Scoped synthetic', template: 'blank', advertiserIds: '7300000000000000001', masterScope: { range: 'yesterday', metrics: ['spend'] } })
    expect(created.ok).toBe(true)
    let board = listBoards()[0]
    expect(board.masterScope).toEqual({ range: 'yesterday', metrics: ['spend'] })
    expect(board.widgets[0].config).toMatchObject({ advertiserIds: '7300000000000000001', range: 'yd' })
    const source = structuredClone(board.widgets[0].config)
    const styleResult = await dispatch({ action: 'board_customize', version: 1, boardId: board.id, expectedUpdatedAt: board.updatedAt, preview: false, style: { background: '#F4F4F4' } })
    expect(styleResult.ok).toBe(true)
    board = listBoards()[0]
    expect(board.masterScope?.range).toBe('yesterday')
    expect(board.widgets[0].config).toEqual(source)
    expect((await dispatch({ action: 'board_customize', version: 1, boardId: board.id, expectedUpdatedAt: board.updatedAt, preview: false, masterScope: { range: 'last3', metrics: ['spend'] } })).ok).toBe(true)
    board = listBoards()[0]
    expect(board.masterScope?.range).toBe('last3')
    expect(board.widgets[0].config).toMatchObject({ advertiserIds: source.advertiserIds, range: '3' })
    expect((await dispatch({ action: 'board_create', name: 'Invalid scope', masterScope: { range: 'custom', metrics: ['spend'] } })).ok).toBe(false)
    expect((await dispatch({ action: 'board_customize', version: 1, boardId: board.id, expectedUpdatedAt: board.updatedAt, preview: false, masterScope: { range: 'today', metrics: ['invented'] } })).ok).toBe(false)
    expect(listBoards()[0]).toEqual(board)
  })

  it('supports exact conversational layout and safe style patches while retaining data bindings', async () => {
    expect((await dispatch({ action: 'board_create', name: 'Custom synthetic', template: 'blank', style: { background: '#F4F4F4', grid: 'none' } })).ok).toBe(true)
    expect((await dispatch({ action: 'board_add_widget', name: 'Custom synthetic', type: 'counter', title: 'Metric', config: { source: 'dataset', datasetId: 'synthetic-live', metric: 'Count', op: 'sum' }, layout: { x: 0, y: 0, w: 6, h: 3 }, style: { accent: '#123456', radius: 12 } })).ok).toBe(true)
    const addedNote = await dispatch({ action: 'board_add_widget', name: 'Custom synthetic', type: 'note', title: 'Highlight', config: { text: 'Synthetic observation' }, layout: { x: 6, y: 0, w: 6, h: 3 } })
    expect(addedNote.ok).toBe(true)
    const before = listBoards()[0]
    expect((addedNote.board as { updatedAt: number }).updatedAt).toBe(before.updatedAt)
    const [metric, note] = before.widgets
    const request = { action: 'board_customize' as const, version: 1, boardId: before.id, expectedUpdatedAt: before.updatedAt, style: { background: '#FFFFFF' }, widgets: [
      { widgetId: metric.id, layout: note.layout, style: { padding: 16 }, title: 'Orders' },
      { widgetId: note.id, layout: metric.layout }
    ] }
    const preview = await dispatch(request)
    expect(preview).toMatchObject({ ok: true, preview: true, expectedUpdatedAt: before.updatedAt })
    expect(listBoards()[0]).toEqual(before)
    const applied = await dispatch({ ...request, preview: false })
    expect(applied).toMatchObject({ ok: true, applied: true })
    const after = listBoards()[0]
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(after.style).toEqual({ background: '#ffffff', grid: 'none' })
    expect(after.widgets[0]).toMatchObject({ id: metric.id, title: 'Orders', layout: note.layout, style: { accent: '#123456', radius: 12, padding: 16 }, config: metric.config })
    expect(after.widgets[1]).toMatchObject({ id: note.id, layout: metric.layout, config: note.config })
    const read = await dispatch({ action: 'board_get', boardId: after.id })
    expect(read.board).toMatchObject({ style: after.style, updatedAt: after.updatedAt, widgets: [{ style: after.widgets[0].style }, {}] })
    expect(await dispatch({ ...request, expectedUpdatedAt: after.updatedAt, preview: false })).toMatchObject({ ok: true, applied: false, changes: [] })
  })

  it('rejects invalid or stale customization atomically and never rewrites widget data', async () => {
    await dispatch({ action: 'board_create', name: 'Atomic synthetic', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Atomic synthetic', type: 'counter', config: { source: 'manual', value: 17 }, layout: { x: 0, y: 0, w: 6, h: 3 } })
    await dispatch({ action: 'board_add_widget', name: 'Atomic synthetic', type: 'note', layout: { x: 6, y: 0, w: 6, h: 3 }, config: { text: 'Unchanged' } })
    const before = listBoards()[0]
    const base = { action: 'board_customize' as const, version: 1, boardId: before.id, expectedUpdatedAt: before.updatedAt, preview: false }
    const id = before.widgets[0].id
    for (const patch of [
      { widgets: [{ widgetId: id, title: 'Would change' }, { widgetId: before.widgets[1].id, style: { css: 'url(secret)' } }] },
      { widgets: [{ widgetId: id, config: { value: 999 } }] },
      { widgets: [{ widgetId: id, layout: { x: 6, y: 0, w: 6, h: 3 } }] },
      { widgets: [{ widgetId: id, layout: { x: 11, y: 0, w: 2, h: 3 } }] },
      { widgets: [{ widgetId: id }, { widgetId: id }] },
      { style: { background: 'red' } },
      { expectedUpdatedAt: before.updatedAt - 1, widgets: [{ widgetId: id, title: 'Stale' }] }
    ]) {
      expect((await dispatch({ ...base, ...patch })).ok).toBe(false)
      expect(listBoards()[0]).toEqual(before)
    }
    expect((await dispatch({ action: 'board_update_widget', boardId: before.id, widgetId: id, layout: { x: 0, y: 3, w: 4, h: 4 }, style: { surface: '#FAFAFA' } })).ok).toBe(true)
    const changed = listBoards()[0]
    expect(changed.widgets[0].config).toEqual(before.widgets[0].config)
    expect(changed.widgets[1]).toEqual(before.widgets[1])
    expect((await dispatch({ action: 'board_update_widget', boardId: before.id, widgetId: id, style: null })).ok).toBe(true)
    expect(listBoards()[0].widgets[0]).not.toHaveProperty('style')
    expect((await dispatch({ action: 'board_add_widget', boardId: before.id, type: 'note', layout: { x: 1, w: 2, h: 2 } })).ok).toBe(false)
  })

  it('creates an empty board by default without adding a live platform reader or requesting a report', async () => {
    const created = await dispatch({ action: 'board_create', name: 'Synthetic' })
    expect(created.ok).toBe(true)
    expect(created.board).toMatchObject({ name: 'Synthetic', widgets: [] })
    expect(created.note).toBe('看板已创建。')
    expect(created).not.toHaveProperty('datasetReady')
    expect(listBoards()[0].widgets).toEqual([])
  })
  it('defaults named platform boards to local modules and persists unknown Meta values', async () => {
    const meta = await dispatch({ action: 'board_create', name: 'Synthetic Meta 报告' })
    expect(meta.ok).toBe(true)
    const board = listBoards()[0]
    expect(board.widgets.map(w => w.type)).toEqual(['meta-reading', 'counter', 'counter', 'counter', 'chart-line', 'chart-bar', 'note'])
    expect(board.widgets[0].config).toMatchObject({ accountId: '', range: 'last7' })
    expect(meta.note).toContain('原生读数')
    const updated = await dispatch({ action: 'board_update_widget', boardId: board.id, widgetId: board.widgets[1].id, config: { source: 'manual', value: 42, label: 'USD · synthetic date' } })
    expect(updated.ok).toBe(true)
    expect(listBoards()[0].widgets[1].config).toMatchObject({ value: 42, label: 'USD · synthetic date' })
    const tt = await dispatch({ action: 'board_create', name: 'Synthetic TT 投放日报' })
    expect(tt.ok).toBe(true)
    expect(listBoards().find(b => b.name === 'Synthetic TT 投放日报')?.widgets.filter(w => w.type === 'tt-reading')).toHaveLength(1)
  })
  it('creates immutable reading modules only from an existing saved source and validates layout', async () => {
    const snapshot: ReadingSnapshot = { kind: 'reading-snapshot', version: 1, rangeLabel: 'Synthetic', window: { start: '2026-01-01', end: '2026-01-01' }, capturedAt: 100,
      accounts: [{ platform: 'tiktok', accountId: 'synthetic', name: 'Synthetic', status: 'ok', statusDetail: null, window: { start: '2026-01-01', end: '2026-01-01' }, previousWindow: null, sourceAt: 90, timezone: 'UTC', currency: 'USD', spend: 42, previousSpend: null, impressions: 10, clicks: 1, conversions: 1 }] }
    const saved = saveReadingSnapshot({ name: 'Synthetic', snapshot, includeChart: false })
    if (!saved.ok) throw new Error(saved.error)
    const original = saved.board.widgets.find(widget => widget.type === 'reading-snapshot')!
    const request = { action: 'board_add_widget' as const, boardId: saved.board.id, type: 'reading-module', source: { boardId: saved.board.id, widgetId: original.id }, config: { module: { kind: 'metric', metric: 'spend', accountIndex: 0 } }, layout: { w: 4, h: 5 } }
    expect(await dispatch({ ...request, source: { ...request.source, widgetId: 'missing' } })).toMatchObject({ ok: false })
    expect(await dispatch({ ...request, config: { ...request.config, snapshot } })).toMatchObject({ ok: false })
    expect(await dispatch({ ...request, layout: { w: 13, h: 5 } })).toMatchObject({ ok: false, error: 'invalid-layout' })
    const added = await dispatch(request)
    expect(added.ok).toBe(true)
    const id = added.createdWidgetId as string
    const board = listBoards().find(item => item.id === saved.board.id)!
    const module = board.widgets.find(widget => widget.id === id)!
    expect(module.layout).toMatchObject({ w: 4, h: 5 })
    const read = await dispatch({ action: 'board_get', boardId: board.id })
    const returned = (read.board as { widgets: Array<{ id: string; layout: unknown }> }).widgets.find(widget => widget.id === id)
    expect(returned?.layout).toEqual(module.layout)
    expect(module.config.snapshot).toEqual(snapshot)
    expect(await dispatch({ action: 'board_update_widget', boardId: board.id, widgetId: id, config: { module: { kind: 'coverage' } } })).toMatchObject({ ok: false })
    const tampered = structuredClone(board)
    tampered.widgets.find(widget => widget.id === id)!.config.module = { kind: 'coverage' }
    expect(saveBoard(tampered)).toMatchObject({ ok: false, error: 'snapshot-immutable' })
    expect(await dispatch({ ...request, source: { boardId: board.id, widgetId: id }, config: { module: { kind: 'coverage' } } })).toMatchObject({ ok: true })
  })
  it('makes saved account evidence available to a conversation without auto-applying a highlight', async () => {
    const snapshot: ReadingSnapshot = { kind: 'reading-snapshot', version: 1, rangeLabel: 'PRIVATE_RANGE', window: { start: '2026-01-01', end: '2026-01-07' }, capturedAt: 100,
      accounts: [{ platform: 'tiktok', accountId: '7300000000000999999', name: 'PRIVATE_NAME', status: 'ok', statusDetail: null, window: { start: '2026-01-01', end: '2026-01-07' }, previousWindow: null, sourceAt: 90, timezone: 'UTC', currency: 'USD', spend: 42, previousSpend: null, impressions: 10, clicks: 1, conversions: 1 }] }
    const created = saveReadingSnapshot({ name: 'PRIVATE_BOARD', snapshot, includeChart: false })
    if (!created.ok) throw new Error(created.error)
    const read = await dispatch({ action: 'board_get', boardId: created.board.id })
    const output = JSON.stringify(read)
    for (const value of ['PRIVATE_NAME', 'PRIVATE_BOARD', '7300000000000999999']) expect(output).toContain(value)
    expect(output).not.toContain('PRIVATE_RANGE')
    const config = (read.board as { widgets: Array<{ type: string; config: { evidence: { boardId: string; widgetId: string; revision: string } } }> }).widgets.find(widget => widget.type === 'reading-snapshot')!.config
    const proposal = { version: 1, boardId: config.evidence.boardId, widgetId: config.evidence.widgetId, revision: config.evidence.revision, highlights: [{ text: 'Review this spending', evidence: [{ accountIndex: 1, metric: 'spend', value: 42 }] }] }
    const raw = JSON.stringify(proposal)
    expect(validateBoardHighlights({ raw })).toMatchObject({ ok: true })
    expect(listBoards()[0].widgets).toHaveLength(created.board.widgets.length)
    expect(applyBoardHighlights({ raw })).toMatchObject({ ok: true, boardId: created.board.id })
    expect(listBoards()[0].widgets).toHaveLength(created.board.widgets.length + 1)
  })
  it('exposes a bounded account projection of reading snapshots to model board operations', async () => {
    const snapshot: ReadingSnapshot = {
      kind: 'reading-snapshot', version: 1, rangeLabel: 'PRIVATE_RANGE', window: { start: '2026-01-01', end: '2026-01-07' }, capturedAt: 10,
      accounts: Array.from({ length: 51 }, (_, index) => ({
        platform: 'tiktok' as const, accountId: `PRIVATE_ID_${index}`, name: `PRIVATE_NAME_${index}`, status: 'ok' as const,
        statusDetail: 'PRIVATE_DETAIL', window: { start: '2026-01-01', end: '2026-01-07' }, previousWindow: null,
        sourceAt: 10, timezone: 'PRIVATE_TIMEZONE', currency: 'USD', spend: 1, previousSpend: null,
        impressions: 10, clicks: 1, conversions: 1, resultType: 'PRIVATE_RESULT'
      }))
    }
    const saved = saveReadingSnapshot({ name: 'PRIVATE_BOARD_NAME', snapshot, includeChart: true })
    if (!saved.ok) throw new Error(saved.error)
    const board = saved.board
    const snapshotWidget = board.widgets.find(widget => widget.type === 'reading-snapshot')!
    snapshotWidget.title = 'PRIVATE_WIDGET_TITLE'
    board.widgets.push(createWidget('note', 'PRIVATE_OTHER_TITLE', { x: 0, y: 12 }, { text: 'PRIVATE_OTHER_BODY' }))
    expect(saveBoard(board)).toEqual({ ok: true })
    const raw = listBoards()[0].widgets.find(widget => widget.type === 'reading-snapshot')!.config.snapshot as ReadingSnapshot
    expect(raw.accounts[0].name).toBe('PRIVATE_NAME_0')
    const projected = await dispatch({ action: 'board_get', boardId: board.id })
    expect(projected.board).toMatchObject({ id: board.id, name: 'PRIVATE_BOARD_NAME' })
    const output = JSON.stringify(projected)
    for (const field of ['PRIVATE_ID_0','PRIVATE_NAME_0','PRIVATE_RESULT','PRIVATE_WIDGET_TITLE','PRIVATE_OTHER_BODY']) expect(output).toContain(field)
    for (const omitted of ['PRIVATE_ID_50','PRIVATE_NAME_50','PRIVATE_DETAIL','PRIVATE_RANGE','PRIVATE_TIMEZONE']) expect(output).not.toContain(omitted)
    const config = (projected.board as { widgets: Array<{ type: string; config: { accountCount: number; evidence: { boardId: string; widgetId: string; revision: string; omittedCount: number; accounts: unknown[] } } }> }).widgets.find(widget => widget.type === 'reading-snapshot')!.config
    expect(config).toMatchObject({ accountCount: 51, evidence: { boardId: board.id, widgetId: snapshotWidget.id, omittedCount: 1 } })
    expect(config.evidence.revision).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(config.evidence.accounts).toHaveLength(50)
    expect(config.evidence.accounts[0]).toMatchObject({ index: 1, platform: 'tiktok', status: 'ok', currency: 'USD', metrics: { spend: 1 } })
  })
  it('creates a standard TikTok board with a bound reading module', async () => {
    const created = await dispatch({
      action: 'board_create',
      name: 'miclip',
      template: 'tiktok',
      advertiserIds: '7300000000001, 7300000000002'
    })
    expect(created.ok).toBe(true)
    const board = (created.board as { id: string; widgets: Array<{ type: string; config: Record<string, unknown> }> })
    expect(board.widgets.some((w) => w.type === 'counter')).toBe(true)
    expect(board.widgets.some((w) => w.type === 'chart-line')).toBe(true)
    const readings = board.widgets.filter((w) => w.type === 'tt-reading')
    expect(readings).toHaveLength(1)
    const reading = readings[0]
    expect(reading?.config.advertiserIds).toBe('7300000000001, 7300000000002')
    expect(reading?.config.range).toBe('7')
    expect(listBoards()[0].masterScope).toMatchObject({ range: 'last7' })
    expect(existsSync(path.join(dir, 'kanban-boards-v2.json'))).toBe(true)
  })

  it('rejects duplicate board names and reports existing names', async () => {
    await dispatch({ action: 'board_create', name: 'miclip', template: 'tiktok' })
    const dup = await dispatch({ action: 'board_create', name: 'miclip', template: 'tiktok' })
    expect(dup.ok).toBe(false)
    expect(dup.error).toBe('name-exists')
  })

  it('lists boards and returns one by name (case-insensitive)', async () => {
    await dispatch({ action: 'board_create', name: 'miclip', template: 'tiktok' })
    const list = await dispatch({ action: 'boards_list' })
    expect(list.ok).toBe(true)
    expect((list.boards as Array<{ name: string }>).some((b) => b.name === 'miclip')).toBe(true)
    const got = await dispatch({ action: 'board_get', name: ' MICLIP ' })
    expect(got.ok).toBe(true)
    const missing = await dispatch({ action: 'board_get', name: 'nope' })
    expect(missing.error).toBe('board-not-found')
  })

  it('adds, updates and removes widgets with atomic validation', async () => {
    await dispatch({ action: 'board_create', name: '看板A', template: 'blank' })
    const added = await dispatch({
      action: 'board_add_widget',
      name: '看板A',
      type: 'tt-reading',
      config: { advertiserIds: '7300000000001', range: '28' }
    })
    expect(added.ok).toBe(true)
    const widgets = (added.board as { widgets: Array<{ id: string; type: string; config: Record<string, unknown> }> }).widgets
    const widget = widgets.find((w) => w.type === 'tt-reading')
    expect(widget?.config.range).toBe('28')

    const updated = await dispatch({
      action: 'board_update_widget',
      name: '看板A',
      widgetId: widget!.id,
      config: { range: '7' }
    })
    expect(updated.ok).toBe(true)
    const after = (updated.board as { widgets: Array<{ config: Record<string, unknown> }> }).widgets.find((w) => w.config.range !== undefined)
    expect(after?.config.range).toBe('7')

    const removed = await dispatch({ action: 'board_remove_widget', name: '看板A', widgetId: widget!.id })
    expect(removed.ok).toBe(true)
    expect((removed.board as { widgets: unknown[] }).widgets).toHaveLength(0)
  })

  it('does not let model board tools fabricate reading snapshot widgets', async () => {
    const created = await dispatch({ action: 'board_create', name: 'Fixture', template: 'blank' })
    expect(created.ok).toBe(true)
    const boardId = (created.board as { id: string }).id
    const snapshot: ReadingSnapshot = { kind: 'reading-snapshot', version: 1, rangeLabel: 'Test', window: { start: '2026-01-01', end: '2026-01-02' }, capturedAt: 1,
      accounts: [{ platform: 'tiktok', accountId: '123', name: 'Fixture', status: 'ok', statusDetail: null, window: { start: '2026-01-01', end: '2026-01-02' }, previousWindow: null, sourceAt: 1, timezone: 'UTC', currency: 'USD', spend: 12, previousSpend: null, impressions: 1, clicks: 1, conversions: 0 }] }
    const result = await dispatch({ action: 'board_add_widget', boardId, type: 'reading-snapshot', config: { snapshot, includeChart: false } })
    expect(result).toEqual({ ok: false, error: 'snapshot-requires-reading' })
    expect(listBoards().find(board => board.id === boardId)?.widgets).toHaveLength(0)
    const unsupported = await dispatch({ action: 'board_add_widget', boardId, type: 'bad-type' })
    expect(unsupported.supported).not.toContain('reading-snapshot')
  })

  it('rejects an out-of-domain widget config without corrupting the board', async () => {
    await dispatch({ action: 'board_create', name: '看板B', template: 'blank' })
    const bad = await dispatch({
      action: 'board_add_widget',
      name: '看板B',
      type: 'tt-reading',
      config: { advertiserIds: '<script>', range: '7' }
    })
    expect(bad.ok).toBe(false)
    const still = await dispatch({ action: 'board_get', name: '看板B' })
    expect((still.board as { widgets: unknown[] }).widgets).toHaveLength(0)
  })

  it('renames a board and refuses collisions', async () => {
    await dispatch({ action: 'board_create', name: '旧名', template: 'blank' })
    await dispatch({ action: 'board_create', name: '已有', template: 'blank' })
    const renamed = await dispatch({ action: 'board_rename', name: '旧名', newName: '新名' })
    expect(renamed.ok).toBe(true)
    const collision = await dispatch({ action: 'board_rename', name: '新名', newName: '已有' })
    expect(collision.error).toBe('name-exists')
  })

  it('af_dataset_pull validates input and pulls through the AF dataset module', async () => {
    // Missing fields are rejected before any pull.
    const bad = await dispatch({ action: 'af_dataset_pull', appId: '', eventName: '' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe('invalid-input')

    // A happy path: the dataset module is stubbed at its boundary.
    const pullCalls: unknown[] = []
    const pull = vi.fn(async (input?: unknown) => {
      pullCalls.push(input)
      const created = createOrUpdateDataset('AF-安装量', { columns: [{ name: '事件次数', type: 'number' }], rows: [[5]], truncated: false })
      if (!created.ok) throw new Error(created.error)
      return { ok: true, results: [{ name: '安装量', datasetName: 'AF-安装量', datasetId: created.dataset.id, ok: true, rowCount: 1 }] }
    })
    const saveQuerySpecMock = vi.fn()
    vi.doMock('../integrations/appsflyer/appsflyerDataset', () => ({
      saveQuerySpec: saveQuerySpecMock,
      listQuerySpecs: () => [],
      pullAppsFlyerDatasets: pull
    }))
    try {
      const { dispatch: freshDispatch } = await import('../boardsBridge')
      const ok = await freshDispatch({ action: 'af_dataset_pull', name: '安装量', appId: 'app-1', eventName: 'custom_checkout', startDate: '2026-10-01', endDate: '2026-10-07', geo: true, countries: ['SG'] })
      expect(ok.ok).toBe(true)
      expect((ok.dataset as { name: string }).name).toBe('AF-安装量')
      expect(pull).toHaveBeenCalledTimes(1)
      const arg = (pullCalls[0] ?? {}) as { window: { start: string; end: string }; specIds: string[] }
      expect(arg.specIds).toEqual([expect.stringMatching(/^afq-[a-f0-9]{64}$/)])
      expect(arg.window).toEqual({ start: '2026-10-01', end: '2026-10-07' })
      expect(ok).toMatchObject({ spec: { id: arg.specIds[0] }, window: arg.window })
      expect(saveQuerySpecMock).toHaveBeenCalledTimes(1)
      const saved = saveQuerySpecMock.mock.calls[0][0] as { id: string; query: { in_app_event: string[]; groupings: string[]; filters: Record<string, string[]> } }
      expect(saved.query.in_app_event).toEqual(['custom_checkout'])
      expect(saved.query.groupings).toContain('Geo')
      expect(saved.query.groupings).toHaveLength(4)
      expect(saved.query.filters).toEqual({ 'Media source': ['tiktokglobal_int'], Geo: ['SG'] })

      for (const input of [
        { startDate: '2026-02-30', endDate: '2026-03-01' },
        { startDate: '2026-10-01' },
        { startDate: '2025-01-01', endDate: '2026-10-01' },
        { geo: true, groupings: ['Campaign ID', 'Campaign', 'Media source', 'Date'] },
        { countries: ['all', 'SG'] }
      ]) expect((await freshDispatch({ action: 'af_dataset_pull', name: 'invalid', appId: 'app-1', ...input })).ok).toBe(false)
      expect(pull).toHaveBeenCalledTimes(1)

      const priorDay = new Date(); priorDay.setDate(priorDay.getDate() - 1)
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      await freshDispatch({ action: 'af_dataset_pull', name: '全部地区', appId: 'app-1', days: 1, geo: true, countries: ['all'] })
      expect(pullCalls[1]).toMatchObject({ window: { start: iso(priorDay), end: iso(priorDay) } })
      const allRegions = saveQuerySpecMock.mock.calls[1][0] as typeof saved
      expect(allRegions.query.filters).not.toHaveProperty('Geo')
      await freshDispatch({ action: 'af_dataset_pull', name: 'Selected source', appId: 'app-1', mediaSources: ['facebook_ads', ' facebook_ads '] })
      expect((saveQuerySpecMock.mock.calls[2][0] as typeof saved).query.filters['Media source']).toEqual(['facebook_ads'])
      await freshDispatch({ action: 'af_dataset_pull', name: 'All sources', appId: 'app-1', mediaSources: [] })
      expect((saveQuerySpecMock.mock.calls[3][0] as typeof saved).query.filters).not.toHaveProperty('Media source')
      for (const mediaSources of [['all'], [''], ['bad\nsource'], Array.from({ length: 33 }, () => 'source')]) {
        expect(await freshDispatch({ action: 'af_dataset_pull', name: 'Invalid source', appId: 'app-1', mediaSources })).toMatchObject({ ok: false, error: 'invalid-media-sources' })
      }
      expect(pullCalls).toHaveLength(4)
    } finally {
      vi.doUnmock('../integrations/appsflyer/appsflyerDataset')
      vi.resetModules()
    }
  })

  it('keeps an AF recipe and card bound after dataset rename and a repeated pull', async () => {
    const raw = vi.fn(async () => '## Data: Count days activity appsflyer,Date\n2,2026-10-01\n## Metadata: {"timezone":"UTC","currency":"USD","Count_days_activity_appsflyer":{"partial-data?":false}}')
    vi.doMock('../integrations/appsflyer/appsflyerDataset', async () => {
      const actual = await vi.importActual<typeof import('../integrations/appsflyer/appsflyerDataset')>('../integrations/appsflyer/appsflyerDataset')
      actual.setAppsFlyerDatasetTokenSourceForTest(() => 'synthetic-token')
      return { ...actual, pullAppsFlyerDatasets: (options: Parameters<typeof actual.pullAppsFlyerDatasets>[0]) => actual.pullAppsFlyerDatasets({ ...options, clientFactory: () => ({ initialize: async () => {}, queryRaw: raw }) }) }
    })
    try {
      const { dispatch: freshDispatch } = await import('../boardsBridge')
      const request = { action: 'af_dataset_pull' as const, name: '注册', appId: 'app.synthetic', eventName: 'custom_register', metrics: ['Count'], startDate: '2026-10-01', endDate: '2026-10-01' }
      const first = await freshDispatch(request)
      expect(first.ok).toBe(true)
      const dataset = first.dataset as { id: string; name: string }
      expect(dataset.id).toBeTruthy()
      expect(renameDataset(dataset.id, '重命名后的注册').ok).toBe(true)
      await freshDispatch({ action: 'board_create', template: 'blank', name: 'live' })
      const added = await freshDispatch({ action: 'board_add_widget', name: 'live', type: 'counter', config: { source: 'dataset', datasetId: dataset.id, metric: '事件次数', op: 'sum' } })
      expect(added.ok).toBe(true)

      const second = await freshDispatch({ ...request, metrics: ['Count', 'Unique users'] })
      expect(second).toMatchObject({ ok: true, dataset: { id: dataset.id, name: '重命名后的注册' } })
      expect(listDatasets()).toHaveLength(1)
      const actual = await vi.importActual<typeof import('../integrations/appsflyer/appsflyerDataset')>('../integrations/appsflyer/appsflyerDataset')
      expect(actual.listQuerySpecs()).toMatchObject([{ datasetId: dataset.id, datasetName: '重命名后的注册', query: { metrics: [{ metric_name: 'Count' }, { metric_name: 'Unique users' }] } }])
      expect(listDatasets()[0].appsflyer).toMatchObject({ status: 'updated', specId: (first.spec as { id: string }).id })
      expect(listBoards().find(board => board.name === 'live')?.widgets[0].config.datasetId).toBe(dataset.id)
    } finally {
      vi.doUnmock('../integrations/appsflyer/appsflyerDataset')
      vi.resetModules()
    }
  })

  it('isolates long AF recipe identities while preserving an exact legacy binding', async () => {
    const raw = vi.fn(async () => '## Data: Count days activity appsflyer,Date\n2,2026-10-01\n## Metadata: {"timezone":"UTC","currency":"USD"}')
    vi.doMock('../integrations/appsflyer/appsflyerDataset', async () => {
      const actual = await vi.importActual<typeof import('../integrations/appsflyer/appsflyerDataset')>('../integrations/appsflyer/appsflyerDataset')
      actual.setAppsFlyerDatasetTokenSourceForTest(() => 'synthetic-token')
      return { ...actual, pullAppsFlyerDatasets: (options: Parameters<typeof actual.pullAppsFlyerDatasets>[0]) => actual.pullAppsFlyerDatasets({ ...options, clientFactory: () => ({ initialize: async () => {}, queryRaw: raw }) }) }
    })
    try {
      const { dispatch: freshDispatch } = await import('../boardsBridge')
      const actual = await vi.importActual<typeof import('../integrations/appsflyer/appsflyerDataset')>('../integrations/appsflyer/appsflyerDataset')
      const appId = `app.${'a'.repeat(180)}`
      const otherAppId = `${appId.slice(0, -1)}b`
      const names = ['A', 'B', 'C'].map(suffix => `Synthetic ${'x'.repeat(49)}${suffix}`)
      const legacyId = `afq-${appId}-Legacy`.slice(0, 80)
      const legacyDataset = createOrUpdateDataset('Renamed legacy data', { columns: [{ name: '事件次数', type: 'number' }], rows: [[3]], truncated: false })
      if (!legacyDataset.ok) throw new Error(legacyDataset.error)
      actual.saveQuerySpec({ id: legacyId, name: 'Legacy', datasetId: legacyDataset.dataset.id, datasetName: 'Old display name', query: { app_ids: [appId] } })
      const requests = [
        { appId, name: names[0] },
        { appId, name: names[1] },
        { appId: otherAppId, name: names[2] }
      ]
      // All of these would have silently reused the same old truncated ID.
      expect(new Set(requests.map(request => `afq-${request.appId}-${request.name}`.slice(0, 80)))).toEqual(new Set([legacyId]))
      const results = []
      for (const request of requests) results.push(await freshDispatch({ action: 'af_dataset_pull', ...request, eventName: 'custom_checkout', metrics: ['Count'], startDate: '2026-10-01', endDate: '2026-10-01' }))
      expect(results.every(result => result.ok === true)).toBe(true)
      const ids = results.map(result => (result.spec as { id: string }).id)
      expect(ids).toEqual(ids.map(() => expect.stringMatching(/^afq-[a-f0-9]{64}$/)))
      expect(new Set(ids).size).toBe(3)
      expect(ids).not.toContain(legacyId)
      expect(new Set(results.map(result => (result.dataset as { id: string }).id)).size).toBe(3)
      const repeated = await freshDispatch({ action: 'af_dataset_pull', ...requests[0], eventName: 'custom_checkout', metrics: ['Count'] })
      expect(repeated).toMatchObject({ ok: true, spec: { id: ids[0] }, dataset: { id: (results[0].dataset as { id: string }).id } })

      const legacy = await freshDispatch({ action: 'af_dataset_pull', appId, name: 'Legacy', eventName: 'custom_checkout', metrics: ['Count'] })
      expect(legacy).toMatchObject({ ok: true, spec: { id: legacyId }, dataset: { id: legacyDataset.dataset.id, name: 'Renamed legacy data' } })
      expect(actual.listQuerySpecs()).toHaveLength(4)
      expect(actual.listQuerySpecs().find(spec => spec.id === legacyId)).toMatchObject({ datasetId: legacyDataset.dataset.id, datasetName: 'Renamed legacy data', query: { app_ids: [appId] } })
      expect(actual.listQuerySpecs().find(spec => spec.id === ids[2])?.query.app_ids).toEqual([otherAppId])
      expect(listDatasets()).toHaveLength(4)
    } finally {
      vi.doUnmock('../integrations/appsflyer/appsflyerDataset')
      vi.resetModules()
    }
  })

  it('rejects an AF recipe beyond capacity without pulling or detaching existing cards', async () => {
    const raw = vi.fn(async () => '## Data: Count days activity appsflyer,Date\n9,2026-10-01\n## Metadata: {"timezone":"UTC","currency":"USD"}')
    vi.doMock('../integrations/appsflyer/appsflyerDataset', async () => {
      const actual = await vi.importActual<typeof import('../integrations/appsflyer/appsflyerDataset')>('../integrations/appsflyer/appsflyerDataset')
      actual.setAppsFlyerDatasetTokenSourceForTest(() => 'synthetic-token')
      return { ...actual, pullAppsFlyerDatasets: (options: Parameters<typeof actual.pullAppsFlyerDatasets>[0]) => actual.pullAppsFlyerDatasets({ ...options, clientFactory: () => ({ initialize: async () => {}, queryRaw: raw }) }) }
    })
    try {
      const { dispatch: freshDispatch } = await import('../boardsBridge')
      const actual = await vi.importActual<typeof import('../integrations/appsflyer/appsflyerDataset')>('../integrations/appsflyer/appsflyerDataset')
      const existing = createOrUpdateDataset('Renamed live metric', { columns: [{ name: '事件次数', type: 'number' }], rows: [[5]], truncated: false })
      if (!existing.ok) throw new Error(existing.error)
      for (let index = 0; index < 20; index++) actual.saveQuerySpec({
        id: `existing-${index}`, name: `Synthetic ${index}`, datasetName: index === 0 ? existing.dataset.name : `AF-Synthetic ${index}`,
        ...(index === 0 ? { datasetId: existing.dataset.id } : {}), query: { app_ids: [`app.synthetic-${index}`] }
      })
      await freshDispatch({ action: 'board_create', name: 'Existing live board', template: 'blank' })
      await freshDispatch({ action: 'board_add_widget', name: 'Existing live board', type: 'counter', config: { source: 'dataset', datasetId: existing.dataset.id, metric: '事件次数', op: 'sum' } })
      const boardsBefore = listBoards()
      const dataBefore = listDatasets()
      const specsFile = path.join(dir, 'appsflyer-dataset-specs.json')
      const specsBefore = readFileSync(specsFile, 'utf8')
      expect(await freshDispatch({ action: 'af_dataset_pull', appId: 'app.new', name: 'New metric' })).toMatchObject({ ok: false, error: 'query-limit' })
      expect(raw).not.toHaveBeenCalled()
      expect(readFileSync(specsFile, 'utf8')).toBe(specsBefore)
      expect(listDatasets()).toEqual(dataBefore)
      expect(listBoards()).toEqual(boardsBefore)

      // Updating an existing full identity is allowed at the limit and retains
      // its recipe ID, renamed dataset, and every other saved query.
      expect(await freshDispatch({ action: 'af_dataset_pull', appId: 'app.synthetic-0', name: 'Synthetic 0', eventName: 'custom_checkout', metrics: ['Count'] })).toMatchObject({ ok: true, spec: { id: 'existing-0' }, dataset: { id: existing.dataset.id, name: existing.dataset.name } })
      expect(raw).toHaveBeenCalledTimes(1)
      expect(actual.listQuerySpecs()).toHaveLength(20)
      expect(actual.listQuerySpecs().filter(spec => spec.id !== 'existing-0')).toEqual(JSON.parse(specsBefore).specs.slice(1))
      expect(listBoards()).toEqual(boardsBefore)
      expect(listDatasets()).toHaveLength(1)
    } finally {
      vi.doUnmock('../integrations/appsflyer/appsflyerDataset')
      vi.resetModules()
    }
  })

  it('imports a CSV as a replace-by-name dataset that template bindings resolve', async () => {
    const csv = path.join(dir, 'TikTok报表_miclip_近7天.csv')
    writeFileSync(csv, '日期,活动名称,消耗,点击\n2026-10-28,Camp A,120.5,34\n2026-10-29,Camp A,98.2,29\n', 'utf8')
    const imported = await dispatch({ action: 'dataset_import', filePath: csv, name: 'TikTok 报表' }, dir)
    expect(imported.ok).toBe(true)
    expect((imported.dataset as { name: string; rowCount: number }).name).toBe('TikTok 报表')
    expect((imported.dataset as { rowCount: number }).rowCount).toBe(2)

    // Replace-by-name: a second import keeps ONE dataset with the new rows.
    const csv2 = path.join(dir, 'refresh.csv')
    writeFileSync(csv2, '日期,活动名称,消耗,点击\n2026-10-30,Camp B,10.0,3\n', 'utf8')
    await dispatch({ action: 'dataset_import', filePath: csv2, name: 'TikTok 报表' }, dir)
    const list = await dispatch({ action: 'boards_list' })
    const datasets = list.datasets as Array<{ name: string; rowCount: number }>
    expect(datasets.filter((d) => d.name === 'TikTok 报表')).toHaveLength(1)
    expect(datasets.find((d) => d.name === 'TikTok 报表')?.rowCount).toBe(1)

    const bad = await dispatch({ action: 'dataset_import', filePath: 'C:\\nope\\missing.csv', name: 'x' })
    expect(bad.ok).toBe(false)
  })
})

afterEach(() => {
  try {
    if (dir) rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows file locks — temp dirs are GC'd by the OS.
  }
})

describe('dispatch board_create cross-account', () => {
  it('scopes template cards to a multi-advertiser OR-set', async () => {
    const created = await dispatch({
      action: 'board_create',
      name: 'go photo 合并',
      template: 'tiktok',
      advertiserNames: ['Go Photo US', 'Go Photo MX'],
      advertiserIds: '7300000000001, 7300000000002'
    })
    expect(created.ok).toBe(true)
    const board = (created.board as { widgets: Array<{ type: string; config: Record<string, unknown> }> })
    const counter = board.widgets.find((w) => w.type === 'counter')!
    expect(counter.config.filterColumn).toBe('广告主ID')
    expect(counter.config.filterValues).toEqual(['7300000000001', '7300000000002'])
    const reading = board.widgets.find((w) => w.type === 'tt-reading')!
    expect(reading.config.advertiserIds).toBe('7300000000001, 7300000000002')
    expect(String(created.note)).toContain('2 个广告主 ID')
  })

  it('rejects names without IDs rather than reading unrelated authorized advertisers', async () => {
    for (const advertiserNames of ['Go Photo US, Go Photo MX', 'Go Photo US', ['x'.repeat(121)], [123], { unknown: true }]) {
      expect(await dispatch({ action: 'board_create', name: 'name-only', template: 'tiktok', advertiserNames })).toMatchObject({ ok: false, error: 'advertiser-ids-required', message: expect.stringContaining('数字广告主 ID') })
    }
    expect((await dispatch({ action: 'boards_list' })).boards).toEqual([])
  })

  it('rejects malformed account scopes instead of silently reading all accounts', async () => {
    for (const advertiserIds of ['bad', '7300000000001,invalid', ',,,', '1'.repeat(14001), ['7300000000001']]) {
      expect(await dispatch({ action: 'board_create', name: 'bad-scope', template: 'tiktok', advertiserIds })).toMatchObject({ ok: false, error: 'invalid-advertiser-ids', message: expect.stringContaining('数字广告主 ID') })
    }
    expect((await dispatch({ action: 'boards_list' })).boards).toEqual([])
  })

  it('adds exactly one scoped module to a template without a TikTok module', async () => {
    const created = await dispatch({ action: 'board_create', name: 'custom', template: 'blank', advertiserIds: '7300000000001\n7300000000002' })
    expect(created.ok).toBe(true)
    const board = created.board as { widgets: Array<{ type: string; config: Record<string, unknown> }> }
    const readings = board.widgets.filter(w => w.type === 'tt-reading')
    expect(readings).toHaveLength(1)
    expect(readings[0].config.advertiserIds).toBe('7300000000001, 7300000000002')
  })
  it('persists a 500-account reading and ID filter without truncation', async () => {
    const ids = Array.from({ length: 500 }, (_, index) => String(7300000000 + index))
    const result = await dispatch({ action: 'board_create', name: 'large-scope', template: 'tiktok', advertiserIds: ids.join(', ') })
    expect(result.ok).toBe(true)
    const board = listBoards().find(item => item.name === 'large-scope')!
    const reading = board.widgets.filter(widget => widget.type === 'tt-reading')
    expect(reading).toHaveLength(1)
    expect(reading[0].config.advertiserIds).toBe(ids.join(', '))
    expect(board.widgets.find(widget => widget.type === 'counter')?.config.filterValues).toEqual(ids)
  })
  it('keeps unscoped TikTok boards readable using the connection selection or grant', async () => {
    const created = await dispatch({ action: 'board_create', name: 'unscoped', template: 'tiktok' })
    expect(created.ok).toBe(true)
    const board = created.board as { widgets: Array<{ type: string; config: Record<string, unknown> }> }
    const readings = board.widgets.filter(w => w.type === 'tt-reading')
    expect(readings).toHaveLength(1)
    expect(readings[0].config.advertiserIds).toBe('')
    expect(String(created.note)).toContain('读取连接页所选账户')
    expect(String(created.note)).toContain('未选择时读取授权下的广告主')
    expect(String(created.note)).toContain('无需再次询问是否取数')
    expect(String(created.note)).toContain('不修改广告')
  })
})


describe('native board approval details', () => {
  it('resolves the target name without changing or replacing the board ID', async () => {
    const created = await dispatch({action:'board_create',name:'合成看板',template:'blank'})
    const board = created.board as {id:string}
    const request = {action:'board_add_widget' as const,boardId:board.id,name:'其他名称',type:'file',title:'合成文件'}
    const details=boardConfirmationDetails(request)
    expect(details).toContain('看板: 合成看板')
    expect(details).toContain(`boardId: ${board.id}`)
    expect(details).toContain('name: 其他名称')
    expect(request).toEqual({action:'board_add_widget',boardId:board.id,name:'其他名称',type:'file',title:'合成文件'})
  })
  it('does not create or migrate a board store merely to display a prompt', () => {
    writeFileSync(path.join(dir,'kanban-boards.json'),'[]')
    const details=boardConfirmationDetails({action:'board_add_widget',boardId:'missing',type:'note'})
    expect(details).not.toContain('看板:')
    expect(existsSync(path.join(dir,'kanban-boards-v2.json'))).toBe(false)
    expect(existsSync(path.join(dir,'kanban-boards-pre-v2-backup.json'))).toBe(false)
  })
  it('does not guess a board name for missing IDs, read failures, or unrelated actions', () => {
    const missing={action:'board_add_widget' as const,boardId:'missing',type:'note'}
    expect(boardConfirmationDetails(missing,()=>[])).not.toContain('看板:')
    expect(boardConfirmationDetails(missing,()=>{throw Error('unreadable')})).not.toContain('看板:')
    const read=vi.fn(()=>[])
    expect(boardConfirmationDetails({action:'board_create',name:'新看板',template:'blank'},read)).toContain('name: 新看板')
    expect(read).not.toHaveBeenCalled()
  })
})

describe('bridge access and workspace file authority', () => {
  it('accepts explicit grain requirements only when real visible fields satisfy them', async () => {
    const imported = createOrUpdateDataset('Synthetic ad report', { columns: [{ name: '广告ID', type: 'text' }, { name: '消耗', type: 'number' }], rows: [['ad-synthetic', 12]], truncated: false })
    if (!imported.ok) throw new Error(imported.error)
    await dispatch({ action: 'board_create', name: 'Custom ad report', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Custom ad report', type: 'table', title: 'Ad and creative detail', config: { source: 'dataset', datasetId: imported.dataset.id, columns: ['消耗'] } })
    const board = listBoards()[0]
    const deps = { getAccess: () => ({ cwd: dir, mode: 'readonly' as const, remoteReadonly: false }), confirm: vi.fn(async () => true) }
    const check = { action: 'board_check' as const, boardId: board.id, mode: 'custom', required: ['table'] }
    expect(await authorizeAndDispatch('s', check, deps)).toMatchObject({ ok: true, passed: true, status: 'ready' })
    expect(await authorizeAndDispatch('s', { ...check, granularity: 'ad' }, deps)).toMatchObject({ ok: false, passed: false, error: 'board-needs-attention', status: 'needs-attention' })
    expect(await authorizeAndDispatch('s', { ...check, dimensions: ['广告ID'] }, deps)).toMatchObject({ ok: false, passed: false, error: 'board-needs-attention' })
    expect(listBoards()[0]).toEqual(board)

    expect((await dispatch({ action: 'board_update_widget', boardId: board.id, widgetId: board.widgets[0].id, config: { columns: ['广告ID', '消耗'] } })).ok).toBe(true)
    const visible = listBoards()[0]
    expect(await authorizeAndDispatch('s', { ...check, granularity: ['creative', 'ad'], dimensions: ['广告ID'] }, deps)).toMatchObject({ ok: true, passed: true, status: 'ready' })
    expect(await authorizeAndDispatch('s', { ...check, dimensions: ['Campaign ID'] }, deps)).toMatchObject({ ok: false, passed: false, status: 'needs-attention' })
    for (const invalid of [{ granularity: 'unknown' }, { granularity: ['ad', 'unknown'] }, { dimensions: [''] }, { dimensions: Array.from({ length: 13 }, (_, index) => `Field ${index}`) }]) expect(await authorizeAndDispatch('s', { ...check, ...invalid }, deps)).toMatchObject({ ok: false, error: 'invalid-check-options' })
    expect(listBoards()[0]).toEqual(visible)
    expect(listDatasets()).toEqual([imported.dataset])
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('checks explicit custom requirements in readonly mode without migrating saved recipes', async () => {
    await dispatch({ action: 'board_create', name: 'Checked synthetic', template: 'blank' })
    const board = listBoards()[0]
    const specsFile = path.join(dir, 'appsflyer-dataset-specs.json')
    const legacy = JSON.stringify([{ appId: 'app.synthetic', eventName: 'custom_checkout' }])
    writeFileSync(specsFile, legacy)
    const deps = { getAccess: () => ({ cwd: dir, mode: 'readonly' as const, remoteReadonly: false }), confirm: vi.fn(async () => true) }
    const custom = await authorizeAndDispatch('s', { action: 'board_check', boardId: board.id, mode: 'custom' }, deps)
    expect(custom).toMatchObject({ ok: true, passed: true, status: 'ready', missing: [] })
    const standard = await authorizeAndDispatch('s', { action: 'board_check', boardId: board.id, mode: 'default', daily: true }, deps)
    expect(standard).toMatchObject({ ok: false, passed: false, error: 'board-incomplete', status: 'incomplete' })
    expect(standard.missing).toEqual(expect.arrayContaining(['data', 'trend', 'funnel', 'analysis', 'third-party', 'table']))
    expect(await authorizeAndDispatch('s', { action: 'board_check', boardId: board.id, mode: 'other' }, deps)).toMatchObject({ ok: false, error: 'invalid-check-options' })
    expect(await authorizeAndDispatch('s', { action: 'board_check', boardId: board.id, required: ['invented'] }, deps)).toMatchObject({ ok: false, error: 'invalid-check-options' })
    expect(readFileSync(specsFile, 'utf8')).toBe(legacy)
    expect(listBoards()[0]).toEqual(board)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('reports a completed audit with unresolved data evidence as a failed acceptance check', async () => {
    await dispatch({ action: 'board_create', name: 'Unverified synthetic', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Unverified synthetic', type: 'tt-reading' })
    const before = listBoards()[0]
    expect(await dispatch({ action: 'board_check', boardId: before.id, mode: 'custom', required: ['data'] })).toMatchObject({
      ok: false,
      passed: false,
      error: 'board-incomplete',
      status: 'incomplete',
      missing: ['data'],
      issues: [{ code: 'native-data-unverified' }]
    })
    expect(listBoards()[0]).toEqual(before)
  })

  it('allows a readonly customization preview but requires write authority to apply it', async () => {
    await dispatch({ action: 'board_create', name: 'Preview synthetic', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Preview synthetic', type: 'counter', config: { value: 17 } })
    const before = listBoards()[0]
    const request = { action: 'board_customize' as const, version: 1, boardId: before.id, expectedUpdatedAt: before.updatedAt, widgets: [{ widgetId: before.widgets[0].id, title: 'Updated label' }] }
    const deps = { getAccess: () => ({ cwd: dir, mode: 'readonly' as const, remoteReadonly: false }), confirm: vi.fn(async () => true) }
    expect(await authorizeAndDispatch('s', request, deps)).toMatchObject({ ok: true, preview: true })
    expect(listBoards()[0]).toEqual(before)
    expect(await authorizeAndDispatch('s', { ...request, preview: false }, deps)).toMatchObject({ ok: false, error: 'permission-denied' })
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(await dispatch({ ...request, preview: false }, dir, () => false)).toMatchObject({ ok: false, error: 'permission-denied' })
    expect(listBoards()[0]).toEqual(before)
  })

  it('allows readonly sessions to list, but denies all board writes and dataset imports', async () => {
    const deps = { getAccess: () => ({ cwd: dir, mode: 'readonly' as const, remoteReadonly: false }), confirm: vi.fn(async () => true) }
    expect((await authorizeAndDispatch('s', { action: 'boards_list' }, deps)).ok).toBe(true)
    for (const action of ['board_create', 'board_rename', 'board_add_widget', 'board_update_widget', 'board_remove_widget', 'dataset_import'] as const) {
      expect(await authorizeAndDispatch('s', { action }, deps)).toEqual({ ok: false, error: 'permission-denied' })
    }
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(existsSync(path.join(dir, 'kanban-boards-v2.json'))).toBe(false)
  })

  it('denies remote sessions even if their mode claims full', async () => {
    const deps = { getAccess: () => ({ cwd: dir, mode: 'full' as const, remoteReadonly: true }), confirm: vi.fn(async () => true) }
    expect(await authorizeAndDispatch('s', { action: 'board_create', name: 'blocked' }, deps)).toEqual({ ok: false, error: 'permission-denied' })
  })

  it('requires ask confirmation and checks that the session remains authorized after approval', async () => {
    let active = true
    const deps = { getAccess: () => active ? ({ cwd: dir, mode: 'ask' as const, remoteReadonly: false }) : null, confirm: vi.fn(async () => false) }
    expect(await authorizeAndDispatch('s', { action: 'board_create', name: 'denied' }, deps)).toEqual({ ok: false, error: 'permission-denied' })
    deps.confirm.mockImplementationOnce(async () => { active = false; return true })
    expect(await authorizeAndDispatch('s', { action: 'board_create', name: 'revoked' }, deps)).toEqual({ ok: false, error: 'permission-denied' })
    active = true
    deps.confirm.mockResolvedValueOnce(true)
    expect((await authorizeAndDispatch('s', { action: 'board_create', name: 'allowed', template: 'blank' }, deps)).ok).toBe(true)
  })

  it('imports only a pinned workspace file, rejecting external paths and escaping symlinks', async () => {
    const external = mkdtempSync(path.join(tmpdir(), 'boards-outside-'))
    try {
      const inside = path.join(dir, 'inside.csv'), outside = path.join(external, 'outside.csv')
      writeFileSync(inside, 'date,spend\n2026-01-01,12\n')
      writeFileSync(outside, 'secret,spend\nx,99\n')
      const deps = { getAccess: () => ({ cwd: dir, mode: 'full' as const, remoteReadonly: false }), confirm: vi.fn(async () => false) }
      expect((await authorizeAndDispatch('s', { action: 'dataset_import', filePath: inside }, deps)).ok).toBe(true)
      expect(await authorizeAndDispatch('s', { action: 'dataset_import', filePath: outside }, deps)).toEqual({ ok: false, error: 'path-not-authorized' })
      expect(await authorizeAndDispatch('s', { action: 'dataset_import', filePath: '../outside.csv' }, deps)).toEqual({ ok: false, error: 'path-not-authorized' })
      try { symlinkSync(outside, path.join(dir, 'escape.csv')) } catch (error) {
        // Windows CI can lack symlink privileges; all other platforms must run the assertion.
        if (process.platform !== 'win32') throw error
        return
      }
      expect(readWorkspaceDataset(path.join(dir, 'escape.csv'), dir)).toBeNull()
    } finally { rmSync(external, { recursive: true, force: true }) }
  })
})
