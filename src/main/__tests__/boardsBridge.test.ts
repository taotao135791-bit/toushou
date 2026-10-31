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

import { authorizeAndDispatch, dispatch, parseBoardsBridgeRequest, readWorkspaceDataset } from '../boardsBridge'

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
    expect(parseBoardsBridgeRequest({ action: 'make_coffee' })).toBeNull()
    expect(parseBoardsBridgeRequest(null)).toBeNull()
    expect(parseBoardsBridgeRequest('x')).toBeNull()
  })
})

describe('boards bridge dispatch', () => {
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
    const reading = board.widgets.find((w) => w.type === 'tt-reading')
    expect(reading?.config.advertiserIds).toBe('7300000000001, 7300000000002')
    expect(reading?.config.range).toBe('7')
    expect(existsSync(path.join(dir, 'kanban-boards.json'))).toBe(true)
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
    expect(String(created.note)).toContain('2 个广告主合并')
  })

  it('accepts a comma-separated names string and falls back to a scalar for one name', async () => {
    const created = await dispatch({
      action: 'board_create',
      name: 'go photo 逗号',
      template: 'tiktok',
      advertiserNames: 'Go Photo US, Go Photo MX'
    })
    const board = (created.board as { widgets: Array<{ type: string; config: Record<string, unknown> }> })
    expect(board.widgets.find((w) => w.type === 'counter')!.config.filterValues).toEqual(['Go Photo US', 'Go Photo MX'])
    const single = await dispatch({ action: 'board_create', name: '单账户', template: 'tiktok', advertiserNames: 'Go Photo US' })
    const singleBoard = (single.board as { widgets: Array<{ type: string; config: Record<string, unknown> }> })
    expect(singleBoard.widgets.find((w) => w.type === 'counter')!.config.filterValue).toBe('Go Photo US')
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
    expect(existsSync(path.join(dir, 'kanban-boards.json'))).toBe(false)
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
