import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
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

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'boards-bridge-'))
  userDataDir = dir
})

describe('parseBoardsBridgeRequest', () => {
  it('accepts every known action and rejects the rest', () => {
    expect(parseBoardsBridgeRequest({ action: 'boards_list' })?.action).toBe('boards_list')
    expect(parseBoardsBridgeRequest({ action: 'board_get', name: 'x' })?.action).toBe('board_get')
    expect(parseBoardsBridgeRequest({ action: 'board_create', template: 'tiktok' })?.action).toBe('board_create')
    expect(parseBoardsBridgeRequest({ action: 'af_dataset_pull', appId: 'a', eventName: 'b' })?.action).toBe('af_dataset_pull')
    expect(parseBoardsBridgeRequest({ action: 'make_coffee' })).toBeNull()
    expect(parseBoardsBridgeRequest(null)).toBeNull()
    expect(parseBoardsBridgeRequest('x')).toBeNull()
  })
})

describe('boards bridge dispatch', () => {
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
    expect(board.widgets.map(w => w.type)).toEqual(['counter', 'counter', 'counter', 'chart-line', 'chart-bar', 'note'])
    expect(board.widgets[0].config.value).toBeNull()
    expect(meta.note).toContain('固定快照')
    const updated = await dispatch({ action: 'board_update_widget', boardId: board.id, widgetId: board.widgets[0].id, config: { source: 'manual', value: 42, label: 'USD · synthetic date' } })
    expect(updated.ok).toBe(true)
    expect(listBoards()[0].widgets[0].config).toMatchObject({ value: 42, label: 'USD · synthetic date' })
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
      return { ok: true, results: [{ name: '安装量', datasetName: 'AF-安装量', ok: true, rowCount: 5 }] }
    })
    const saveQuerySpecMock = vi.fn()
    vi.doMock('../integrations/appsflyer/appsflyerDataset', () => ({
      saveQuerySpec: saveQuerySpecMock,
      pullAppsFlyerDatasets: pull
    }))
    try {
      const { dispatch: freshDispatch } = await import('../boardsBridge')
      const ok = await freshDispatch({ action: 'af_dataset_pull', name: '安装量', appId: 'app-1', eventName: 'af_install', days: 7 })
      expect(ok.ok).toBe(true)
      expect((ok.dataset as { name: string }).name).toBe('AF-安装量')
      expect(pull).toHaveBeenCalledTimes(1)
      const arg = (pullCalls[0] ?? {}) as { window: { start: string; end: string }; specIds: string[] }
      expect(arg.specIds).toEqual(['afq-app-1-安装量'])
      expect(arg.window.end >= arg.window.start).toBe(true)
      expect(saveQuerySpecMock).toHaveBeenCalledTimes(1)
      const saved = saveQuerySpecMock.mock.calls[0][0] as { id: string; query: { in_app_event: string[] } }
      expect(saved.query.in_app_event).toEqual(['af_install'])
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
