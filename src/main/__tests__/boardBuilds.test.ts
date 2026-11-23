import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
let profile: string
vi.mock('electron', () => ({ app: { getPath: () => profile } }))
vi.mock('../appsflyerConnection', () => ({ verifiedAppsFlyerAccessToken: async () => null }))
import { authorizeAndDispatch, dispatch } from '../boardsBridge'
import { createOrUpdateDataset, listDatasets } from '../boardDatasets'
import { listBoards, saveBoard } from '../boards'
import { saveQuerySpec, listQuerySpecs } from '../integrations/appsflyer/appsflyerDataset'
import { recordBoardBuildSourceEvidence, registerBoardBuildTurn, respondBoardEditTargets, revokeBoardBuildSession, setBoardBuildAfPrefix, withCurrentBoardBuild, type BoardTargetUiEvent } from '../boardBuilds'
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

async function seedEditTargets() {
  for (const name of ['远洋商城投放日报', '远洋商城素材复盘', '另一业务投放看板', '已锁定的远洋商城归档']) {
    await dispatch({ action: 'board_create', name, template: 'blank' })
    await dispatch({ action: 'board_add_widget', name, type: 'note', title: '待优化', config: { text: 'Original evidence' } })
  }
  const archive = listBoards().find(board => board.name === '已锁定的远洋商城归档')!
  expect(saveBoard({ ...archive, locked: true }).ok).toBe(true)
  return listBoards()
}

function askForTargets(candidates: string[]) {
  const requestBoardTargets = vi.fn<(event: BoardTargetUiEvent) => void>()
  const result = authorizeAndDispatch(session, { action: 'board_edit_targets', candidateBoardIds: candidates }, { ...deps, requestBoardTargets })
  const event = requestBoardTargets.mock.calls[0]?.[0]
  if (!event || event.type !== 'ui_request') throw new Error('expected a board selection dialog')
  return { event, result, requestBoardTargets }
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
  it('remaps tiktok-af preset bindings to the datasets actually pulled this build', async () => {
    const buildId = await begin('做固定快照看板，只有固定数字，产品是 Lemon8 泰国')
    // board_create 的 authorize 路径会记录 afPrefix；这里直接落到草稿模拟。
    expect(setBoardBuildAfPrefix(session, buildId, 'Lemon8泰国')).toBe(true)
    // 模型按习惯名拉数：草稿库里的数据集名与模板虚拟名（AF-{prefix}基础分天）不同。
    const datasetId = await withCurrentBoardBuild(session, async () => {
      const win = { start: '2026-10-30', end: '2026-11-05' }
      const made: string[] = []
      for (const [name, columns, row] of [
        ['AF-Lemon8泰国TikTok基础', [{ name: '活跃用户', type: 'number' }, { name: '安装量', type: 'number' }, { name: '日期', type: 'date' }], [1105, 244, '2026-11-04']],
        ['AF-Lemon8泰国TikTok次留', [{ name: '事件次数', type: 'number' }, { name: '独立用户', type: 'number' }, { name: '日期', type: 'date' }], [74, 74, '2026-11-04']]
      ] as const) {
        const result = createOrUpdateDataset(name, { columns, rows: [row], truncated: false }, undefined, { appsflyer: { specId: 'spec-' + name.slice(-4), status: 'updated', window: win, dataWindow: win, attemptedAt: Date.now() } })
        if (!result.ok) throw new Error(result.error)
        recordBoardBuildSourceEvidence(session, 'appsflyer', [result.dataset.id])
        made.push(result.dataset.id)
      }
      return made.join(',')
    }, buildId)
    await call({ action: 'board_create', name: 'AF preset remap', template: 'tiktok-af', afPrefix: 'Lemon8泰国', buildId })
    const committed = await call({ action: 'board_build_commit', buildId, allowPartial: true })
    expect(committed).toMatchObject({ ok: true, published: true })
    const board = listBoards().find((candidate) => candidate.name === 'AF preset remap')!
    // 预绑的虚拟名在提交时被重绑到本轮实际拉到的数据集——绑定靠证据不靠记忆。
    const afCards = board.widgets.filter((w) => (w.title ?? '').startsWith('AF ') && w.config.source === 'dataset')
    expect(afCards.length).toBeGreaterThanOrEqual(5)
    const pulled = datasetId.split(',')
    expect(afCards.every((w) => pulled.includes(String(w.config.datasetId)))).toBe(true)
    expect(new Set(afCards.map((w) => w.config.datasetId)).size).toBe(2)
  })
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
  it('asks before editing ambiguous business boards and publishes all selected changes together', async () => {
    const boards = await seedEditTargets()
    const [daily, creative] = boards.filter(board => board.name.startsWith('远洋商城'))
    const unrelated = boards.find(board => board.name.startsWith('另一业务'))!
    const locked = boards.find(board => board.locked)!
    registerBoardBuildTurn(session, '/synthetic-workspace', '给远洋商城的投放看板把便签标题改成待验证，保留已有读数、日期和其他模块。')
    expect(await call({ action: 'board_build_begin' })).toMatchObject({ ok: false, error: 'board-target-selection-required' })
    expect(await call({ action: 'board_build_begin', targetBoardId: daily.id })).toMatchObject({ ok: false, error: 'board-target-selection-required' })
    const { event, result } = askForTargets([daily.id, creative.id])
    expect(event.boards?.slice(0, 2)).toEqual(expect.arrayContaining([expect.objectContaining({ id: daily.id, suggested: true }), expect.objectContaining({ id: creative.id, suggested: true })]))
    expect(event.boards).toContainEqual(expect.objectContaining({ id: locked.id, locked: true }))
    expect(respondBoardEditTargets('other-session', event.id, { boardIds: [daily.id] })).toBe(false)
    for (const invalid of [[], [daily.id, daily.id], ['outside-dialog'], [locked.id]]) expect(respondBoardEditTargets(session, event.id, { boardIds: invalid })).toBe(false)
    expect(respondBoardEditTargets(session, event.id, { boardIds: [daily.id, creative.id] })).toBe(true)
    expect(await result).toEqual({ ok: true, targetBoardIds: [daily.id, creative.id] })
    expect(await call({ action: 'board_build_begin', targetBoardIds: [daily.id, unrelated.id] })).toMatchObject({ ok: false, error: 'board-target-not-selected' })
    const draft = await call({ action: 'board_build_begin' })
    expect(draft).toMatchObject({ ok: true, targetBoardIds: [daily.id, creative.id] })
    const buildId = draft.buildId as string
    expect(await call({ action: 'board_create', name: 'Replacement', buildId })).toMatchObject({ ok: false, error: 'board-target-not-selected' })
    expect(await call({ action: 'board_update_widget', boardId: unrelated.id, widgetId: unrelated.widgets[0].id, title: 'Unwanted change', buildId })).toMatchObject({ ok: false, error: 'board-target-not-selected' })
    await call({ action: 'board_update_widget', boardId: daily.id, widgetId: daily.widgets[0].id, title: '待验证', buildId })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: false, published: false })
    expect(listBoards()).toEqual(boards)
    await call({ action: 'board_update_widget', boardId: creative.id, widgetId: creative.widgets[0].id, title: '待验证', buildId })
    const saved = await call({ action: 'board_build_commit', buildId })
    expect(saved).toMatchObject({ ok: true, published: true, boards: [{ id: daily.id }, { id: creative.id }] })
    for (const target of [daily, creative]) expect(listBoards().find(board => board.id === target.id)?.widgets).toEqual([{ ...target.widgets[0], title: '待验证' }])
    expect(listBoards().find(board => board.id === unrelated.id)).toEqual(unrelated)
    expect(await call({ action: 'board_build_commit', buildId })).toEqual(saved)
  })

  it('stops a cancelled choice from falling back to a guessed target or a new board', async () => {
    const boards = await seedEditTargets()
    const candidates = boards.filter(board => board.name.startsWith('远洋商城')).map(board => board.id)
    registerBoardBuildTurn(session, '/synthetic-workspace', '给远洋商城的投放看板加一块素材观察清单便签。')
    expect(await call({ action: 'board_build_begin' })).toMatchObject({ ok: false, error: 'board-target-selection-required' })
    const { event, result, requestBoardTargets } = askForTargets(candidates)
    expect(respondBoardEditTargets(session, event.id, { cancelled: true })).toBe(true)
    expect(await result).toEqual({ ok: false, error: 'board-target-selection-cancelled' })
    expect(requestBoardTargets).toHaveBeenLastCalledWith({ type: 'ui_cancel', sessionId: session, id: event.id })
    expect(await call({ action: 'board_build_begin', targetBoardId: candidates[0] })).toMatchObject({ ok: false, error: 'board-target-selection-cancelled' })
    expect(listBoards()).toEqual(boards)
  })

  it('allows edits naming an exact board and discards stale choices after a new turn', async () => {
    const boards = await seedEditTargets()
    const [daily, creative] = boards.filter(board => board.name.startsWith('远洋商城'))
    registerBoardBuildTurn(session, '/synthetic-workspace', '修改远洋商城看板的样式')
    const pending = askForTargets([daily.id, creative.id])
    registerBoardBuildTurn(session, '/synthetic-workspace', `更新「${creative.name}」的背景色，不要新建看板。`)
    expect(await pending.result).toMatchObject({ ok: false, error: 'board-target-selection-cancelled' })
    expect(respondBoardEditTargets(session, pending.event.id, { boardIds: [daily.id] })).toBe(false)
    expect(await call({ action: 'board_edit_targets', candidateBoardIds: [daily.id, creative.id] })).toEqual({ ok: true, targetBoardIds: [creative.id] })
    expect(await call({ action: 'board_build_begin' })).toMatchObject({ ok: true, targetBoardIds: [creative.id] })
  })

  it('does not auto-select a board the user names only to exclude', async () => {
    const boards = await seedEditTargets()
    const [daily, creative] = boards.filter(board => board.name.startsWith('远洋商城'))
    registerBoardBuildTurn(session, '/synthetic-workspace', `更新远洋商城的投放看板，别改「${creative.name}」。`)
    const pending = askForTargets([daily.id, creative.id])
    expect(respondBoardEditTargets(session, pending.event.id, { boardIds: [daily.id] })).toBe(true)
    expect(await pending.result).toEqual({ ok: true, targetBoardIds: [daily.id] })
  })

  it('protects unrelated datasets and recipes during a selected board edit', async () => {
    const [board] = await seedEditTargets()
    const buildId = await begin(`编辑看板 ${board.id}，修改复盘便签内容。`, board.id)
    await withCurrentBoardBuild(session, async () => {
      const dataset = createOrUpdateDataset('Synthetic Unrelated', { columns: [{ name: 'Count', type: 'number' }], rows: [[9]], truncated: false })
      expect(dataset.ok).toBe(true)
    }, buildId)
    await call({ action: 'board_update_widget', boardId: board.id, widgetId: board.widgets[0].id, config: { text: 'Updated review' }, buildId })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: false, error: 'board-source-outside-targets', published: false })
    expect(listDatasets()).toEqual([])
    expect(listBoards().find(item => item.id === board.id)).toEqual(board)
  })

  it('keeps date words in saved titles and different board clauses from becoming shared requirements', async () => {
    const [daily, creative] = (await seedEditTargets()).filter(board => board.name.startsWith('远洋商城'))
    const renamed = { ...daily, name: '远洋商城昨日报告' }
    expect(saveBoard(renamed).ok).toBe(true)
    registerBoardBuildTurn(session, '/synthetic-workspace', `把「${renamed.name}」的背景改深色；给「${creative.name}」加一个待办。`)
    const pending = askForTargets([daily.id, creative.id])
    expect(respondBoardEditTargets(session, pending.event.id, { boardIds: [daily.id, creative.id] })).toBe(true)
    await pending.result
    const draft = await call({ action: 'board_build_begin' })
    expect(draft.targetIntents).toMatchObject({
      [daily.id]: { mode: 'presentation', options: { required: [] } },
      [creative.id]: { mode: 'presentation', addedUtilityTypes: ['todo'] }
    })
    expect((draft.targetIntents as Record<string, Record<string, unknown>>)[daily.id].range).toBeUndefined()
  })

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
  it('accepts question-form edit requests after a published build instead of dead-ending', async () => {
    // Natural post-build edits are polite questions ("能不能把背景换成深色？").
    // The old ？-heuristic read them as inspection and board_build_begin was
    // rejected with no recovery path.
    const buildId = await begin('做一个时钟和待办看板')
    await call({ action: 'board_create', name: 'Utility', template: 'blank', buildId })
    await call({ action: 'board_add_widget', name: 'Utility', type: 'clock', buildId })
    await call({ action: 'board_add_widget', name: 'Utility', type: 'todo', buildId })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: true, published: true })
    const boardId = listBoards()[0].id
    for (const text of ['能不能把背景换成深色？', '帮我加一个便签模块好吗？', 'can you add a note widget?']) {
      registerBoardBuildTurn(session, '/synthetic-workspace', text)
      expect(await call({ action: 'board_build_begin', targetBoardId: boardId })).toMatchObject({ ok: true, draft: true })
      expect(await call({ action: 'board_build_abort', buildId: (await call({ action: 'board_build_status' })).buildId })).toMatchObject({ ok: true })
    }
  })
  it('still treats pure data and listing questions as read-only with an actionable hint', async () => {
    for (const text of ['加拿大市场的消耗怎么样？', '移动端消耗多少？', '汇率换算有公式吗？', '我有哪些看板？']) {
      registerBoardBuildTurn(session, '/synthetic-workspace', text)
      const rejected = await call({ action: 'board_build_begin' })
      expect(rejected).toMatchObject({ ok: false, error: 'board-build-request-required' })
      expect(typeof rejected.hint).toBe('string')
    }
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
    expect(await call({ action: 'board_build_commit', buildId, allowPartial: true })).toMatchObject({ ok: false, published: false })
    expect(listBoards()).toEqual([]); expect(listDatasets()).toEqual([])
    await withCurrentBoardBuild(session, async () => recordBoardBuildSourceEvidence(session, 'appsflyer', [datasetId]), buildId)
    const saved = await call({ action: 'board_build_commit', buildId })
    expect(saved).toMatchObject({ ok: true, published: true, draft: false })
    expect(listBoards()).toHaveLength(1); expect(listDatasets()).toHaveLength(1); expect(listQuerySpecs()).toHaveLength(1)
    expect(await call({ action: 'board_build_commit', buildId })).toEqual(saved)
  })
  it('publishes verified saved media with a visible AppsFlyer gap after a rejected full commit', async () => {
    const media = createOrUpdateDataset('Imported media', {
      columns: [{ name: 'Date', type: 'date' }, { name: 'Spend', type: 'number' }],
      rows: [['2026-11-05', 89.25]], truncated: false
    })
    if (!media.ok) throw new Error(media.error)
    await dispatch({ action: 'board_create', name: 'Acme Media', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Acme Media', type: 'table', config: { source: 'dataset', datasetId: media.dataset.id } })
    const [target] = listBoards()
    const text = `编辑看板 ID ${target.id}。换成紫色背景并加入 AF 付费事件转化模块。保留已有读数，日期不变。`
    expect(freezeBoardBuildIntent(text, 'trusted', 1, target)).toMatchObject({ mode: 'custom', options: { required: ['third-party'] }, measures: ['conversion'] })
    const buildId = await begin(text, target.id)
    const pull = await call({ action: 'af_dataset_pull', name: 'AF Checkout', appId: 'app.synthetic', eventName: 'checkout', days: 1, buildId })
    expect(pull.ok).toBe(false)
    expect(await call({ action: 'board_rename', boardId: target.id, newName: 'Acme Report', buildId })).toMatchObject({ ok: true })
    expect(await call({ action: 'board_build_commit', buildId })).toMatchObject({ ok: false, published: false, numericCoverage: true, missing: expect.arrayContaining(['third-party']) })
    expect(listBoards()).toEqual([target])
    expect(await call({ action: 'board_build_commit', buildId, allowPartial: true })).toMatchObject({ ok: true, published: true, status: 'partial', passed: false })
    expect(listBoards()[0]).toMatchObject({ id: target.id, name: 'Acme Report', widgets: target.widgets, partialDelivery: { missing: expect.arrayContaining(['third-party']) } })
    expect(listDatasets()).toEqual([media.dataset])
    expect(listQuerySpecs()).toEqual([])
  })
  it('publishes a table with known columns and preserves the missing ones as coverage gaps', async () => {
    const media = createOrUpdateDataset('Imported reports', {
      columns: [{ name: 'Date', type: 'date' }, { name: 'Spend', type: 'number' }],
      rows: [['2026-11-05', 89.25]], truncated: false
    })
    if (!media.ok) throw new Error(media.error)
    await dispatch({ action: 'board_create', name: 'Acme Data', template: 'blank' })
    await dispatch({ action: 'board_add_widget', name: 'Acme Data', type: 'table', config: { source: 'dataset', datasetId: media.dataset.id } })
    const [target] = listBoards()
    const buildId = await begin('给现有表格增加转化列，保留已保存日期与数据', target.id)
    await call({ action: 'board_update_widget', boardId: target.id, widgetId: target.widgets[0].id, config: { columns: ['Date', 'Spend', 'Conversions'] }, buildId })
    const rejected = await call({ action: 'board_build_commit', buildId })
    expect(rejected).toMatchObject({ published: false, numericCoverage: true, issues: expect.arrayContaining([expect.objectContaining({ code: 'table-columns-partial' })]) })
    expect(await call({ action: 'board_build_commit', buildId, allowPartial: true })).toMatchObject({ ok: true, status: 'partial' })
    expect(listBoards()[0].partialDelivery?.issues).toContain('table-columns-partial')
    expect(listDatasets()[0].rows).toEqual([['2026-11-05', 89.25]])
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
    expect(await call({ action: 'board_build_commit', buildId, allowPartial: true })).toMatchObject({ ok: false, published: false })
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

  it('rejects an old draft ID after an unrelated turn without letting it write the formal store', async () => {
    const buildId = await begin('创建新看板')
    registerBoardBuildTurn(session, '/synthetic-workspace', '现在几点？')
    const operation = vi.fn(async () => 'unreachable')
    await expect(withCurrentBoardBuild(session, operation, buildId)).rejects.toThrow('board-build-conflict')
    expect(operation).not.toHaveBeenCalled()
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

describe('mechanical preflight heal (阶段2)', () => {
  it('rewrites an aliased metric binding to the real column and reports it', async () => {
    const buildId = await begin('只做必须有花费的表格看板')
    const datasetId = await seedNative(buildId, false)
    await withCurrentBoardBuild(session, async () => recordBoardBuildSourceEvidence(session, 'appsflyer', [datasetId]), buildId)
    await call({ action: 'board_create', name: 'Heal me', template: 'blank', buildId })
    // Widget binds metric "spend"; the synthetic dataset's column is 消耗-unrelated —
    // build one with an alias-mismatched numeric column via a second dataset.
    await withCurrentBoardBuild(session, async () => {
      const window = { start: '2026-10-30', end: '2026-11-05' }
      const result = createOrUpdateDataset('AF-Heal', { columns: [{ name: '花费', type: 'number' }, { name: 'Date', type: 'date' }, { name: '币种', type: 'text' }], rows: [[42, '2026-11-01', 'USD']], truncated: false }, undefined, { appsflyer: { specId: 'heal-spec', status: 'updated', window, dataWindow: window, attemptedAt: Date.now() } })
      if (!result.ok) throw new Error(result.error)
      saveQuerySpec({ id: 'heal-spec', name: 'Heal', datasetName: result.dataset.name, datasetId: result.dataset.id, query: { app_ids: ['app.heal'], in_app_event: ['heal'], filters: {} } })
      recordBoardBuildSourceEvidence(session, 'appsflyer', [result.dataset.id])
      await call({ action: 'board_add_widget', name: 'Heal me', type: 'counter', title: '花费卡', config: { source: 'dataset', datasetId: result.dataset.id, metric: 'spend', op: 'sum' }, buildId })
      await call({ action: 'board_add_widget', name: 'Heal me', type: 'table', title: '花费明细', config: { source: 'dataset', datasetId: result.dataset.id, columns: ['Date'] }, buildId })
    }, buildId)
    const check = await call({ action: 'board_build_preflight', buildId })
    expect((check as { healed?: string[] }).healed).toEqual(expect.arrayContaining([expect.stringContaining('spend')]))
    // The healed binding is the committed truth: commit succeeds through the measure gate.
    const commit = await call({ action: 'board_build_commit', buildId })
    expect(commit).toMatchObject({ ok: true, published: true })
    const board = (commit as { board: { widgets: unknown[] } }).board
    const widgets = board.widgets as Array<{ config?: { metric?: string } }>
    expect(widgets.some((widget) => widget.config?.metric === '花费')).toBe(true)
  })

  it('never guesses on ambiguous or unknown columns', async () => {
    const buildId = await begin('做必须有转化的看板')
    const datasetId = await seedNative(buildId, false)
    await withCurrentBoardBuild(session, async () => recordBoardBuildSourceEvidence(session, 'appsflyer', [datasetId]), buildId)
    await call({ action: 'board_create', name: 'No heal', template: 'blank', buildId })
    await withCurrentBoardBuild(session, async () => {
      await call({ action: 'board_add_widget', name: 'No heal', type: 'counter', title: '未知列', config: { source: 'dataset', datasetId, metric: 'definitely-not-a-column', op: 'sum' }, buildId })
    }, buildId)
    const check = await call({ action: 'board_build_preflight', buildId })
    expect((check as { healed?: string[] }).healed).toBeUndefined()
    expect(check.ok).toBe(false)
    await call({ action: 'board_build_abort', buildId })
  })
})
