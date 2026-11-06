import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
let profile: string
vi.mock('electron', () => ({ app: { getPath: () => profile } }))
import { authorizeAndDispatch, dispatch } from '../boardsBridge'
import { createOrUpdateDataset, listDatasets } from '../boardDatasets'
import { listBoards } from '../boards'
import { saveQuerySpec, listQuerySpecs } from '../integrations/appsflyer/appsflyerDataset'
import { recordBoardBuildSourceEvidence, registerBoardBuildTurn, revokeBoardBuildSession, withCurrentBoardBuild } from '../boardBuilds'
import { atomicBoardFile, BOARD_STORE_FILES, boardBuildRoot, boardProfileRoot, readBoardStoreBytes, recoverBoardBuild } from '../boardBuildStorage'
import { freezeBoardBuildIntent } from '../../shared/boardBuild'

const session = 'synthetic-build-session'
const deps = { getAccess: () => ({ cwd: '/synthetic-workspace', mode: 'full' as const, remoteReadonly: false }), confirm: vi.fn(async () => true) }
const call = (request: Parameters<typeof authorizeAndDispatch>[1]) => authorizeAndDispatch(session, request, deps)
beforeEach(() => { profile = mkdtempSync(path.join(tmpdir(), 'board-build-test-')); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 6, 12)) })
afterEach(() => { revokeBoardBuildSession(session); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(profile, { recursive: true, force: true }) })

async function begin(text: string, targetBoardId?: string): Promise<string> {
  registerBoardBuildTurn(session, '/synthetic-workspace', text)
  const result = await call({ action: 'board_build_begin', targetBoardId })
  expect(result.ok).toBe(true)
  return result.buildId as string
}
async function seedNative(buildId: string, proven = true): Promise<string> {
  return withCurrentBoardBuild(session, async () => {
    const window = { start: '2026-10-30', end: '2026-11-05' }
    const result = createOrUpdateDataset('AF-Synthetic', { columns: [{ name: '事件次数', type: 'number' }, { name: '活动ID', type: 'text' }], rows: [[12, 'campaign-synthetic']], truncated: false }, undefined, { appsflyer: { specId: 'synthetic-spec', status: 'updated', window, dataWindow: window, attemptedAt: Date.now() } })
    if (!result.ok) throw new Error(result.error)
    saveQuerySpec({ id: 'synthetic-spec', name: 'Synthetic', datasetName: result.dataset.name, datasetId: result.dataset.id, query: { app_ids: ['app.synthetic'], in_app_event: ['custom_checkout'], filters: {} } })
    if (proven) recordBoardBuildSourceEvidence(session, 'appsflyer', [result.dataset.id])
    return result.dataset.id
  }, buildId)
}

describe('trusted request extraction', () => {
  it('keeps defaults for unspecified commerce, subscriptions and daily reports', () => {
    for (const text of ['做一个电商投放看板，你安排', '做订阅产品的获客看板', '做昨天的投放日报看板，你安排']) {
      const intent = freezeBoardBuildIntent(text, 'trusted', 1)
      expect(intent.mode).toBe('default')
      expect(intent.options.mode).toBe('default')
    }
    expect(freezeBoardBuildIntent('做昨天的投放日报看板，你安排', 'trusted', 1)).toMatchObject({ range: 'yesterday', options: { daily: true, required: ['data', 'table'] } })
  })
  it('honors negative lists, explicit visual structures, snapshots and genuine grain alternatives', () => {
    const table = freezeBoardBuildIntent('只要蓝白表格看板，不要指标卡、趋势、漏斗和分析', 'trusted', 1)
    expect(table).toMatchObject({ mode: 'custom', options: { required: ['data', 'table'] } })
    expect(freezeBoardBuildIntent('A dark dashboard, only trend, no cards, funnel or analysis', 'trusted', 1)).toMatchObject({ mode: 'custom', options: { required: ['data', 'trend'] } })
    expect(freezeBoardBuildIntent('只要 AF 趋势看板，不要漏斗和表格', 'trusted', 1)).toMatchObject({ mode: 'custom', options: { required: ['data', 'trend', 'third-party'] } })
    expect(freezeBoardBuildIntent('做固定快照看板，只有一个数字', 'trusted', 1)).toMatchObject({ mode: 'snapshot', options: { required: [] } })
    expect(freezeBoardBuildIntent('素材或广告ID明细看板，不能用活动级代替素材', 'trusted', 1)).toMatchObject({ mode: 'custom', options: { granularity: ['creative', 'ad'] } })
    expect(freezeBoardBuildIntent('做一个看板，固定数字12和8', 'trusted', 1)).toMatchObject({ mode: 'snapshot', fixedValues: [12, 8] })
  })
  it('treats reconnecting an old snapshot as a live request while preserving explicit fixed-only requests', () => {
    for (const text of ['把这张固定快照接通刷新', '把这张固定快照改成可刷新的看板', '将固定数值看板接入实时取数', 'Convert this snapshot to a live dashboard']) {
      const intent = freezeBoardBuildIntent(text, 'trusted', 1)
      expect(intent.mode).not.toBe('snapshot')
      expect(intent).toMatchObject({ requireLiveBindings: true, options: { required: expect.arrayContaining(['data']) } })
      expect(intent.fixedValues).toBeUndefined()
    }
    for (const text of ['只做固定快照，不要连接或刷新', '只做固定快照，不要改成可刷新的看板']) expect(freezeBoardBuildIntent(text, 'trusted', 1)).toMatchObject({ mode: 'snapshot', options: { required: [] } })
    expect(freezeBoardBuildIntent('做一个投放看板\n来源类型：reading-snapshot', 'trusted', 1).mode).toBe('default')
  })
})

describe('Main-owned generation transactions', () => {
  it('can begin an explicit single-chart task without requiring the literal board keyword', async () => {
    const buildId = await begin('只做第三方付费事件按天趋势，不要媒体读数卡、漏斗或说明墙。')
    expect(await call({ action: 'board_build_status', buildId })).toMatchObject({ intent: { mode: 'custom', options: { required: ['data', 'trend', 'third-party'] } } })
    expect(await call({ action: 'board_create', name: 'Single trend', template: 'blank' })).toMatchObject({ ok: false, error: 'board-build-conflict' })
    expect(listBoards()).toEqual([])
  })
  it('requires begin for old board writers and rejects missing or stale build identifiers', async () => {
    registerBoardBuildTurn(session, '/synthetic-workspace', '创建可刷新的看板')
    expect(await call({ action: 'board_create', name: 'Synthetic' })).toMatchObject({ ok: false, error: 'board-build-required' })
    const buildId = (await call({ action: 'board_build_begin' })).buildId as string
    expect(await call({ action: 'board_create', name: 'Synthetic' })).toMatchObject({ ok: false, error: 'board-build-conflict' })
    expect(await call({ action: 'board_create', name: 'Synthetic', template: 'blank', buildId })).toMatchObject({ ok: true, draft: true, published: false, buildId })
    expect(listBoards()).toEqual([])
    registerBoardBuildTurn(session, '/synthetic-workspace', '继续')
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: false, error: 'board-build-conflict' })
    const next = (await call({ action: 'board_build_begin' })).buildId as string
    expect(next).not.toBe(buildId)
    expect(await call({ action: 'board_create', name: 'Late write', buildId })).toMatchObject({ ok: false, error: 'board-build-conflict' })
    expect(listBoards()).toEqual([])
  })
  it('keeps readonly board discovery available without a draft even when the question mentions boards', async () => {
    await dispatch({ action: 'board_create', name: 'Readable', template: 'blank' })
    const id = listBoards()[0].id
    registerBoardBuildTurn(session, '/synthetic-workspace', '我有哪些看板？')
    const readonly = { ...deps, getAccess: () => ({ cwd: '/synthetic-workspace', mode: 'readonly' as const, remoteReadonly: false }) }
    expect(await authorizeAndDispatch(session, { action: 'boards_list' }, readonly)).toMatchObject({ ok: true, boards: [{ id }] })
    expect(await authorizeAndDispatch(session, { action: 'board_get', boardId: id }, readonly)).toMatchObject({ ok: true, board: { id } })
    expect(await authorizeAndDispatch(session, { action: 'board_check', boardId: id, mode: 'custom' }, readonly)).toMatchObject({ ok: true, passed: true })
    expect(await authorizeAndDispatch(session, { action: 'board_build_begin' }, readonly)).toMatchObject({ ok: false, error: 'permission-denied' })
    expect(await call({ action: 'board_build_begin' })).toMatchObject({ ok: false, error: 'board-build-request-required' })
  })
  it('preserves a utility-only custom board without forcing advertising modules or fake numeric values', async () => {
    const buildId = await begin('做一个时钟和待办看板')
    expect(await call({ action: 'board_build_status', buildId })).toMatchObject({ intent: { mode: 'custom', options: { required: [] } } })
    await call({ action: 'board_create', name: 'Utility', template: 'blank', buildId })
    await call({ action: 'board_add_widget', name: 'Utility', type: 'clock', buildId })
    await call({ action: 'board_add_widget', name: 'Utility', type: 'todo', buildId })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: true, published: true })
    expect(listBoards()[0].widgets.map(widget => widget.type)).toEqual(['clock', 'todo'])
  })
  it('creates a travel notes and todo board without imposing advertising data', async () => {
    const buildId = await begin('新建旅行待办看板，只要便签和待办')
    await call({ action: 'board_create', name: 'Travel', template: 'blank', buildId })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: false })
    await call({ action: 'board_add_widget', name: 'Travel', type: 'note', buildId })
    await call({ action: 'board_add_widget', name: 'Travel', type: 'todo', buildId })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: true, published: true })
  })
  it('cannot omit frozen creative requirements or publish a campaign replacement', async () => {
    const buildId = await begin('素材或广告ID明细看板，不能用活动级代替素材')
    const datasetId = await seedNative(buildId)
    await call({ action: 'board_create', name: 'Synthetic creative', template: 'blank', buildId })
    await call({ action: 'board_add_widget', name: 'Synthetic creative', type: 'table', config: { source: 'dataset', datasetId }, buildId })
    const result = await call({ action: 'board_check', name: 'Synthetic creative', mode: 'custom', required: [], buildId })
    expect(result).toMatchObject({ ok: false, passed: false, granularity: { requested: ['creative', 'ad'] } })
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'granularity-unverified' })]))
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: false, published: false })
    expect(listBoards()).toEqual([]); expect(listDatasets()).toEqual([]); expect(listQuerySpecs()).toEqual([])
  })
  it('requires each explicit measure at the requested visible grain instead of trusting titles', async () => {
    const buildId = await begin('必须按素材或广告ID展示花费和转化的看板，不能用活动级代替素材')
    const datasetId = await seedNative(buildId)
    await withCurrentBoardBuild(session, async () => {
      const state = listDatasets()[0].appsflyer!
      const result = createOrUpdateDataset('AF-Synthetic', { columns: [{ name: '广告ID', type: 'text' }, { name: '花费', type: 'number' }, { name: '转化', type: 'number' }, { name: '币种', type: 'text' }], rows: [['ad-synthetic', 12, 3, 'USD']], truncated: false }, undefined, { appsflyer: state })
      if (!result.ok) throw new Error(result.error)
      recordBoardBuildSourceEvidence(session, 'appsflyer', [datasetId])
    }, buildId)
    await call({ action: 'board_create', name: 'Creative measures', template: 'blank', buildId })
    await call({ action: 'board_add_widget', name: 'Creative measures', type: 'table', title: '广告花费和转化', config: { source: 'dataset', datasetId, columns: ['广告ID', '花费'] }, buildId })
    const missing = await call({ action: 'board_build_commit', buildId })
    expect(missing.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'intent-measure-missing:conversion' })]))
    expect(listBoards()).toEqual([])
    const board = (await call({ action: 'board_get', name: 'Creative measures', buildId })).board as { id: string; widgets: Array<{ id: string }> }
    await call({ action: 'board_update_widget', boardId: board.id, widgetId: board.widgets[0].id, config: { columns: ['广告ID', '花费', '转化'] }, buildId })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: true, published: true })
    expect(await call({ action: 'board_get', boardId: board.id, buildId })).toMatchObject({ ok: true })
    expect(await call({ action: 'board_check', boardId: board.id, buildId, mode: 'custom', required: [] })).toMatchObject({ ok: true, published: true, passed: true })
  })
  it('requires native query evidence and publishes all three stores only after frozen acceptance', async () => {
    const buildId = await begin('只要可刷新的表格看板')
    const datasetId = await seedNative(buildId, false)
    await call({ action: 'board_create', name: 'Synthetic live', template: 'blank', buildId })
    await call({ action: 'board_add_widget', name: 'Synthetic live', type: 'table', config: { source: 'dataset', datasetId }, buildId })
    const failed = await call({ action: 'board_build_commit', buildId })
    expect(failed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'source-query-evidence-required' })]))
    expect(listBoards()).toEqual([]); expect(listDatasets()).toEqual([])
    await withCurrentBoardBuild(session, async () => recordBoardBuildSourceEvidence(session, 'appsflyer', [datasetId]), buildId)
    const saved = await call({ action: 'board_build_commit', buildId })
    expect(saved).toMatchObject({ ok: true, published: true, draft: false })
    expect(listBoards()).toHaveLength(1); expect(listDatasets()).toHaveLength(1); expect(listQuerySpecs()).toHaveLength(1)
    expect(await call({ action: 'board_build_commit', buildId })).toEqual(saved)
  })
  it('preserves an existing manual board during style-only customization without live queries', async () => {
    await dispatch({ action: 'board_create', name: 'Existing', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Existing', type: 'counter', config: { value: 42 } })
    const before = listBoards()[0]
    const instruction = '保留当前看板所有数据绑定、模块和日期，只把背景改为深色，两个模块交换左右位置，使用浅色文字。'
    expect(freezeBoardBuildIntent(instruction, 'trusted', 1, before).mode).toBe('presentation')
    const buildId = await begin(instruction, before.id)
    expect(await call({ action: 'board_customize', boardId: before.id, version: 1, expectedUpdatedAt: before.updatedAt, preview: false, style: { background: '#111111' }, buildId })).toMatchObject({ ok: true, draft: true })
    expect(listBoards()[0]).toEqual(before)
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: true, published: true })
    expect(listBoards()[0].widgets).toEqual(before.widgets)
    expect(listBoards()[0].style).toEqual({ background: '#111111' })
  })
  it('removes only the explicitly requested structural widget while preserving all survivors', async () => {
    await dispatch({ action: 'board_create', name: 'Clock board', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Clock board', type: 'clock', title: '时钟' })
    await dispatch({ action: 'board_add_widget', name: 'Clock board', type: 'note', title: '保留便签', config: { text: 'Synthetic retained content' } })
    const before = listBoards()[0]
    const buildId = await begin('删掉这个看板的时钟模块，其余保持', before.id)
    expect(await call({ action: 'board_remove_widget', boardId: before.id, widgetId: before.widgets[1].id, buildId })).toMatchObject({ ok: true })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: false })
    await call({ action: 'board_build_abort', buildId })
    const next = (await call({ action: 'board_build_begin', targetBoardId: before.id })).buildId as string
    await call({ action: 'board_remove_widget', boardId: before.id, widgetId: before.widgets[0].id, buildId: next })
    expect(await call({ action: 'board_build_commit', buildId: next })).toMatchObject({ ok: true, published: true })
    expect(listBoards()[0].widgets).toEqual([before.widgets[1]])
  })
  it('adds explicitly requested utilities to an existing clock board without touching its binding or data', async () => {
    await dispatch({ action: 'board_create', name: 'Clock board', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Clock board', type: 'clock', title: '时钟' })
    const original = listBoards()[0]
    const buildId = await begin('给现有时钟板加个便签和待办，其余保持', original.id)
    await call({ action: 'board_add_widget', boardId: original.id, type: 'note', config: { text: 'Synthetic note' }, buildId })
    await call({ action: 'board_add_widget', boardId: original.id, type: 'todo', buildId })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: true, published: true })
    expect(listBoards()[0].widgets[0]).toEqual(original.widgets[0])
    expect(listBoards()[0].widgets.map(widget => widget.type)).toEqual(['clock', 'note', 'todo'])
    expect(listDatasets()).toEqual([])
  })
  it('rejects new manual business values even when other live widgets satisfy the data requirement', async () => {
    const buildId = await begin('只要可刷新的表格看板')
    const datasetId = await seedNative(buildId)
    await call({ action: 'board_create', name: 'Live plus fake', template: 'blank', buildId })
    await call({ action: 'board_add_widget', name: 'Live plus fake', type: 'table', config: { source: 'dataset', datasetId }, buildId })
    const added = await call({ action: 'board_add_widget', name: 'Live plus fake', type: 'counter', config: { value: 0 }, buildId })
    const result = await call({ action: 'board_build_commit', buildId })
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'fixed-value-requires-explicit-snapshot' })]))
    expect(listBoards()).toEqual([])
    await call({ action: 'board_remove_widget', name: 'Live plus fake', widgetId: added.createdWidgetId, buildId })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: true, published: true })
  })
  it('cannot repair an old fixed board by leaving its manual metrics unchanged beside a live table', async () => {
    await dispatch({ action: 'board_create', name: 'Old snapshot', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Old snapshot', type: 'counter', config: { value: 12 } })
    const original = listBoards()[0]
    const buildId = await begin('把这张固定快照接通刷新，改成可刷新的看板', original.id)
    const datasetId = await seedNative(buildId)
    await call({ action: 'board_add_widget', boardId: original.id, type: 'table', config: { source: 'dataset', datasetId }, buildId })
    const rejected = await call({ action: 'board_build_commit', buildId })
    expect(rejected.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'fixed-value-requires-explicit-snapshot', widgetId: original.widgets[0].id })]))
    expect(listBoards()[0]).toEqual(original)
    expect(await call({ action: 'board_update_widget', boardId: original.id, widgetId: original.widgets[0].id, config: { source: 'dataset', datasetId, metric: '事件次数', op: 'sum' }, buildId })).toMatchObject({ ok: true })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: true, published: true })
    expect(listBoards()[0].widgets[0].config.source).toBe('dataset')
  })
  it('supports explicit fixed snapshots and rejects a concurrent official-store edit at commit', async () => {
    const buildId = await begin('生成固定快照看板，只有一个数字')
    await call({ action: 'board_create', name: 'Snapshot', template: 'blank', buildId })
    await call({ action: 'board_add_widget', name: 'Snapshot', type: 'counter', config: { value: 8 }, buildId })
    await dispatch({ action: 'board_create', name: 'Concurrent official', template: 'blank' })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: false, error: 'conflict' })
    expect(listBoards().map(board => board.name)).toEqual(['Concurrent official'])
  })
  it('checks explicit fixed values and rechecks authority before publication', async () => {
    const buildId = await begin('做一个看板，固定数字12和8')
    await call({ action: 'board_create', name: 'Fixed', template: 'blank', buildId })
    await call({ action: 'board_add_widget', name: 'Fixed', type: 'counter', config: { value: 0 }, buildId })
    const rejected = await call({ action: 'board_build_commit', buildId })
    expect(rejected.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'intent-fixed-values-mismatch' })]))
    expect(listBoards()).toEqual([])
    const board = (await call({ action: 'board_get', name: 'Fixed', buildId })).board as { id: string; widgets: Array<{ id: string }> }
    await call({ action: 'board_update_widget', boardId: board.id, widgetId: board.widgets[0].id, config: { value: 12 }, buildId })
    await call({ action: 'board_add_widget', name: 'Fixed', type: 'counter', config: { value: 8 }, buildId })
    const denied = { ...deps, getAccess: () => ({ cwd: '/synthetic-workspace', mode: 'readonly' as const, remoteReadonly: false }) }
    expect(await authorizeAndDispatch(session, { action: 'board_build_commit', buildId }, denied)).toMatchObject({ ok: false, error: 'permission-denied' })
    expect(listBoards()).toEqual([])
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: true, published: true })
  })
  it('preflights data without making a formal board or claiming a whole platform lacks support', async () => {
    const buildId = await begin('做素材级投放看板')
    expect(await call({ action: 'board_build_preflight', buildId })).toMatchObject({ ok: false, error: 'board-data-not-feasible', published: false })
    await seedNative(buildId)
    const result = await call({ action: 'board_build_preflight', buildId })
    expect(result).toMatchObject({ ok: false, error: 'board-data-not-feasible' })
    expect(result.hint).toContain('不代表媒体平台本身不支持')
    expect(listBoards()).toEqual([])
  })
  it('keeps standalone data refresh compatible and isolates stale asynchronous source completion', async () => {
    registerBoardBuildTurn(session, '/synthetic-workspace', '更新 TT 报表')
    expect(await withCurrentBoardBuild(session, async () => boardBuildRoot())).toBeUndefined()
    const old = await begin('生成固定快照看板')
    let release!: () => void
    const pending = withCurrentBoardBuild(session, async () => { await new Promise<void>(resolve => { release = resolve }); recordBoardBuildSourceEvidence(session, 'tiktok'); return true }, old)
    const next = await begin('创建新的素材级看板')
    release()
    await expect(pending).rejects.toThrow('board-build-conflict')
    expect(await call({ action: 'board_build_status', buildId: next })).toMatchObject({ ok: true, intent: { options: { granularity: ['creative'] } } })
    expect(listDatasets()).toEqual([])
  })
  it('rolls all store files back from a fixed-name crash journal before any normal read', () => {
    const before = readBoardStoreBytes(profile)
    for (const name of BOARD_STORE_FILES) atomicBoardFile(path.join(profile, name), 'partial write')
    atomicBoardFile(path.join(profile, 'board-build-publication.json'), JSON.stringify({ version: 1, before }))
    recoverBoardBuild()
    expect(readBoardStoreBytes(profile)).toEqual(before)
    expect(() => readFileSync(path.join(profile, 'board-build-publication.json'))).toThrow()
  })
  it('imports board-only beta overlay once and never rewrites stable stores or credentials', async () => {
    await dispatch({ action: 'board_create', name: 'Stable preserved', template: 'blank' })
    atomicBoardFile(path.join(profile, 'board-datasets.json'), '[]')
    atomicBoardFile(path.join(profile, 'appsflyer-dataset-specs.json'), '{"specs":[]}')
    atomicBoardFile(path.join(profile, 'html-boards.json'), '[]')
    atomicBoardFile(path.join(profile, 'synthetic-credential.json'), '{"testOnly":true}')
    const original = readBoardStoreBytes(profile)
    vi.stubEnv('TOUSHOU_RELEASE_CHANNEL', 'beta')
    const overlay = boardProfileRoot()
    expect(overlay).toBe(path.join(profile, 'board-beta-v3'))
    expect(listBoards().map(board => board.name)).toEqual(['Stable preserved'])
    expect(() => readFileSync(path.join(overlay, 'synthetic-credential.json'))).toThrow()
    expect(readFileSync(path.join(overlay, 'initial-source', 'kanban-boards-v2.json'), 'utf8')).toBe(original['kanban-boards-v2.json'])
    await dispatch({ action: 'board_create', name: 'Beta only', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Beta only', type: 'analysis', config: { source: 'dataset', datasetId: 'synthetic', metric: 'Count' } })
    expect(readBoardStoreBytes(profile)).toEqual(original)
    expect(listBoards()).toHaveLength(2)
    vi.stubEnv('TOUSHOU_RELEASE_CHANNEL', '')
    expect(listBoards().map(board => board.name)).toEqual(['Stable preserved'])
    vi.stubEnv('TOUSHOU_RELEASE_CHANNEL', 'beta')
    expect(listBoards()).toHaveLength(2)
    expect(readFileSync(path.join(profile, 'synthetic-credential.json'), 'utf8')).toBe('{"testOnly":true}')
  })
})
