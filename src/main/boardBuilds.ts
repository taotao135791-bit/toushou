import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { freezeBoardBuildIntent, type BoardBuildIntent } from '../shared/boardBuild'
import { checkBoardGeneration, type BoardGenerationIssue } from '../shared/boardGeneration'
import { BOARD_LIMITS, createWidget } from '../shared/boards'
import { boardWidgetDatasetBindings } from '../shared/boardDataWidgets'
import { adoptBoardRefreshSnapshot, getLatestBoardRefresh } from './boardRefresh'
import { boardRefreshWidgetDatasets, type BoardRefreshResult } from '../shared/boardRefresh'
import type { BoardDataset, KanbanBoard, SessionEvent } from '../shared/types'
import { boardWidgetWindow } from '../shared/boardWindows'
import { listBoards, saveBoard } from './boards'
import { listDatasetsStrict } from './boardDatasets'
import { listQuerySpecs } from './integrations/appsflyer/appsflyerDataset'
import { atomicBoardFile, boardBuildRoot, boardProfileRoot, BOARD_STORE_FILES, publishBoardBuild, readBoardStoreBytes, recoverBoardBuild, withBoardBuildRoot, type BoardStoreFile } from './boardBuildStorage'

export type BoardTargetUiEvent = Extract<SessionEvent, { type: 'ui_request' | 'ui_cancel' }>
type TargetSelection = { ok: true; targetBoardIds: string[] } | { ok: false; error: string }
interface PendingTargets {
  id: string
  eligible: Set<string>
  result: Promise<TargetSelection>
  finish: (result: TargetSelection) => void
}
interface BuildTurn {
  id: string; revision: number; cwd: string; text: string; requiresBuild: boolean; readOnlyRequest: boolean
  editRequested: boolean; preventCreate: boolean; pendingTargets?: PendingTargets; selection?: TargetSelection; draft?: BuildDraft
}
interface BuildDraft {
  id: string; root: string; profile: string; intent: BoardBuildIntent; targets: Map<string, BoardBuildIntent>
  before: Record<BoardStoreFile, string | null>; boards: KanbanBoard[]; recipes: ReturnType<typeof listQuerySpecs>
  committed?: Record<string, unknown>; busy: number; sourceEvidence: Map<string, string>
  /** tiktok-af 模板的产品前缀：提交时预绑卡按本轮实际拉到的数据集重绑。 */
  afPrefix?: string
}
const turns = new Map<string, BuildTurn>()
const TARGET_TIMEOUT_MS = 120_000

function cancelPendingTargets(turn: BuildTurn | undefined): void {
  turn?.pendingTargets?.finish({ ok: false, error: 'board-target-selection-cancelled' })
}

/** Called only from the trusted Main prompt entry point, never a tool. Every
 * accepted user turn invalidates old in-flight work, including steering. */
export function registerBoardBuildTurn(sessionId: string, cwd: string, text: string): void {
  const previous = turns.get(sessionId)
  cancelPendingTargets(previous)
  if (previous?.draft && !previous.draft.busy) rmSync(previous.draft.root, { recursive: true, force: true })
  const continuation = !!previous?.requiresBuild && /^(?:继续|开始|好了|就这样|按这个|可以|重试|continue|retry)[。！!\s]*$/i.test(text.trim())
  const refreshOnly = /(?:^|[，,。\s])(?:请|帮我|再|重新)?\s*(?:刷新|更新数据|取最新|refresh)|看板\s*(?:刷新|更新)/i.test(text) && !/创建|新建|生成|搭建|添加|布局|样式|结构|定制|create|build/i.test(text)
  const editContinuation = !!previous?.requiresBuild && /背景|颜色|布局|样式|排版|改名|深色|浅色|交换|模块|style|layout|rename/i.test(text)
  const update = /更新|编辑|修改|改成|改为|换成|换(?!算)|改|调整|添加|新增|加(?!拿)|删掉|删除|移除|改名|重命名|定制|改一下|挪|弄|搞|移(?!动端)|放大|缩小|对齐|排列|重排|去掉|\b(?:edit|update|change|remove|customize|rename|add|move|swap|resize|reorder|align)\b/i
  const boardContext = /看板|(?:时钟|待办|便签)板|dashboard|\bboards?\b/i
  const directives = text.replace(/(?:不要|不另|不|别|禁止)(?:再|另外|另)?\s*(?:创建|新建)|\b(?:do not|don’t|don't)\s+(?:create|build)\b/gi, '')
  const preventCreate = directives !== text
  const creates = /生成|创建|新建|搭建|\b(?:create|build|generate)\b/i.test(directives)
  const inspection = (/^(?:请|帮我|麻烦)?\s*(?:我有哪些|有哪些|有什么|列出|查看|看看|看一下|展示|显示|检查|list\b|show\b|what\b)/i.test(directives.trim()) || /[?？]/.test(directives)) && !creates && !update.test(directives) && !/做|建|优化/i.test(directives)
  const editRequested = continuation ? !!previous?.editRequested || previous?.selection?.ok === true : !creates && update.test(directives) && (boardContext.test(directives) || editContinuation)
  turns.set(sessionId, {
    id: randomUUID(), revision: (previous?.revision ?? 0) + 1, cwd,
    text: continuation ? `${previous!.text}\n${text}` : text,
    readOnlyRequest: inspection || /^(?:请)?\s*(?:只读|仅(?:列出|查看)|read.only\b|list.only\b)/i.test(directives.trim()),
    editRequested, preventCreate: preventCreate || (continuation && !!previous?.preventCreate),
    requiresBuild: continuation || (!refreshOnly && !inspection && (boardContext.test(directives) || editContinuation))
  })
}
export function cancelBoardEditTargets(sessionId: string): void { cancelPendingTargets(turns.get(sessionId)) }
export function revokeBoardBuildSession(sessionId: string): void {
  const turn = turns.get(sessionId)
  cancelPendingTargets(turn)
  turns.delete(sessionId)
  if (turn?.draft && !turn.draft.busy) rmSync(turn.draft.root, { recursive: true, force: true })
}
export function getBoardBuildSession(sessionId: string): { requiresBuild: boolean; cwd: string; buildId?: string; published?: boolean; intent?: BoardBuildIntent; targetBoardIds?: string[] } | null {
  const turn = turns.get(sessionId)
  return turn ? { requiresBuild: turn.requiresBuild, cwd: turn.cwd, ...(turn.draft ? { buildId: turn.draft.id, published: !!turn.draft.committed, intent: structuredClone(turn.draft.intent), targetBoardIds: [...turn.draft.targets.keys()] } : {}) } : null
}
export function hasBoardBuildTurn(sessionId: string): boolean { return turns.has(sessionId) }
export function getBoardBuildTurnId(sessionId: string): string | undefined { return turns.get(sessionId)?.id }

function targetIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > BOARD_LIMITS.maxBoards || !value.every(id => typeof id === 'string' && id.length > 0 && id.length <= BOARD_LIMITS.maxIdLength && !/[\x00-\x1f\x7f]/.test(id))) return null
  return new Set(value).size === value.length ? value : null
}

function explicitlyNamedBoards(text: string, boards: KanbanBoard[]): KanbanBoard[] {
  const references = text.normalize('NFKC').toLowerCase()
  return boards.filter(board => board.name.trim().length > 1 && references.includes(board.name.trim().normalize('NFKC').toLowerCase()))
}

function unambiguousTarget(turn: BuildTurn, boards: KanbanBoard[], candidates: string[]): KanbanBoard | undefined {
  // A full name or ID may belong to something the user says to exclude or
  // use as a reference. In those cases require an explicit pick.
  const withoutCreate = turn.text.replace(/(?:不要|不|别|禁止)(?:再|另外|另)?\s*(?:创建|新建)|\b(?:do not|don’t|don't)\s+(?:create|build)\b/gi, '')
  if (/(?:不要|请勿|别|不)(?:改|更新|编辑|动|选|包含)|排除|参考|参照|对比|\b(?:except|exclude|leave out|compare|reference)\b/i.test(withoutCreate)) return undefined
  const references = turn.text.normalize('NFKC').toLowerCase()
  const inBrackets = [...references.matchAll(/(?:「([^」]+)」|“([^”]+)”|"([^"]+)")/g)].map(match => match[1] ?? match[2] ?? match[3])
  const mentionedIds = new Set(references.split(/[^\w-]+/))
  const exact = boards.filter(board => mentionedIds.has(board.id.toLowerCase()) || inBrackets.includes(board.name.trim().normalize('NFKC').toLowerCase()))
  if (exact.length) return exact.length === 1 ? exact[0] : undefined
  const named = explicitlyNamedBoards(turn.text, boards)
  if (named.length > 1 || candidates.length > 1) return undefined
  if (named.length === 1 && (!candidates.length || candidates.includes(named[0].id))) return named[0]
  const editable = boards.filter(board => !board.locked)
  return editable.length === 1 && (!candidates.length || candidates[0] === editable[0].id) ? editable[0] : undefined
}

/** Saved titles carry context (for example “昨日投放日报”), not requirements.
 * Filter clauses naming other selected boards before freezing each edit. */
function boardEditInstruction(text: string, board: KanbanBoard, selected: KanbanBoard[], catalog: KanbanBoard[]): string {
  const mentions = (clause: string, item: KanbanBoard) => clause.toLowerCase().includes(item.name.toLowerCase()) || clause.includes(item.id)
  const clauses = text.split(/[。;；\r\n]+/).flatMap(sentence => {
    const parts = sentence.split(/[，,]/)
    const namedParts = parts.filter(part => selected.some(item => mentions(part, item)))
    return namedParts.length > 1 && namedParts.every(part => /改|调|换|加|删|移|挪|更新|刷新|\b(?:change|edit|add|move|rename|remove|update|refresh)\b/i.test(part)) ? parts : [sentence]
  })
  const requested = clauses.filter(clause => mentions(clause, board) || !selected.some(item => mentions(clause, item))).join('\n')
  const names = [...new Set(catalog.flatMap(item => [item.name, item.id]).filter(value => value.length > 1))].sort((a, b) => b.length - a.length)
  if (!names.length) return requested
  return names.reduce((instruction, name) => instruction.replaceAll(name, '看板'), requested)
}

export async function requestBoardEditTargets(
  sessionId: string, cwd: string, rawCandidates: unknown,
  emit: (event: BoardTargetUiEvent) => void,
  stillAuthorized: () => boolean,
  signal?: AbortSignal
): Promise<TargetSelection> {
  const turn = turns.get(sessionId)
  if (!turn || turn.cwd !== cwd || !turn.text.trim() || turn.readOnlyRequest) return { ok: false, error: 'board-build-request-required' }
  if (signal?.aborted || !stillAuthorized()) return { ok: false, error: 'permission-denied' }
  if (turn.pendingTargets) return turn.pendingTargets.result
  if (turn.selection) return turn.selection
  if (turn.draft) return { ok: false, error: 'board-build-conflict' }
  const candidates = rawCandidates === undefined ? [] : targetIds(rawCandidates)
  if (!candidates) return { ok: false, error: 'invalid-board-candidates' }
  const boards = listBoards()
  const exact = unambiguousTarget(turn, boards, candidates)
  turn.editRequested = true
  turn.requiresBuild = true
  if (exact) return (turn.selection = exact.locked ? { ok: false, error: 'board-locked' } : { ok: true, targetBoardIds: [exact.id] })

  const eligible = new Set(boards.filter(board => !board.locked).map(board => board.id))
  if (!eligible.size) return (turn.selection = { ok: false, error: 'no-editable-boards' })
  const preferred = new Set([...candidates, ...explicitlyNamedBoards(turn.text, boards).map(board => board.id)])
  const choices = boards.toSorted((a, b) => Number(preferred.has(b.id)) - Number(preferred.has(a.id)) || b.updatedAt - a.updatedAt)
    .map(({ id, name, description, locked }) => ({ id, name, description, locked, suggested: preferred.has(id) }))
  const id = `board-targets:${randomUUID()}`
  const { promise: result, resolve } = Promise.withResolvers<TargetSelection>()
  const abort = () => finish({ ok: false, error: 'board-target-selection-cancelled' })
  const timer = setTimeout(abort, TARGET_TIMEOUT_MS)
  timer.unref?.()
  const finish = (answer: TargetSelection) => {
    if (turn.pendingTargets?.id !== id) return
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    delete turn.pendingTargets
    const accepted = turns.get(sessionId) === turn && stillAuthorized() ? answer : { ok: false as const, error: 'board-target-selection-cancelled' }
    turn.selection = accepted
    resolve(accepted)
    emit({ type: 'ui_cancel', sessionId, id })
  }
  turn.pendingTargets = { id, eligible, result, finish }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    emit({ type: 'ui_request', sessionId, id, method: 'board_targets', title: '', boards: choices, timeout: TARGET_TIMEOUT_MS })
  } catch { abort() }
  return result
}

/** Undefined allows regular runtime answers through the separate validator. */
export function respondBoardEditTargets(sessionId: string, requestId: string, answer: unknown): boolean | undefined {
  if (!requestId.startsWith('board-targets:')) return undefined
  const request = turns.get(sessionId)?.pendingTargets
  if (!request || request.id !== requestId || !answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1) return false
  if ('cancelled' in answer && answer.cancelled === true) {
    request.finish({ ok: false, error: 'board-target-selection-cancelled' })
    return true
  }
  const ids = 'boardIds' in answer ? targetIds(answer.boardIds) : null
  if (!ids?.length || ids.some(id => !request.eligible.has(id))) return false
  const editable = new Set(listBoards().filter(board => !board.locked).map(board => board.id))
  if (ids.some(id => !editable.has(id))) {
    request.finish({ ok: false, error: 'board-targets-changed' })
    return false
  }
  request.finish({ ok: true, targetBoardIds: ids })
  return true
}
const dataDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Main-native pull paths alone call this after a successful actual query. */
export function recordBoardBuildSourceEvidence(sessionId: string, kind: 'tiktok' | 'appsflyer' | 'refresh', datasetIds?: string[]): void {
  const draft = turns.get(sessionId)?.draft
  if (!draft || draft.root !== boardBuildRoot()) return
  withBoardBuildRoot(draft.root, () => {
    for (const dataset of listDatasetsStrict()) {
      if (datasetIds ? datasetIds.includes(dataset.id) : kind === 'tiktok' && dataset.name === 'TikTok 报表') draft.sourceEvidence.set(dataset.id, dataDigest(dataset))
    }
  })
}

export async function withCurrentBoardBuild<T>(sessionId: string, operation: () => Promise<T>, expectedBuildId?: unknown): Promise<T> {
  const turn = turns.get(sessionId)
  const draft = turn?.draft
  if (expectedBuildId !== undefined && (!draft || expectedBuildId !== draft.id || draft.committed)) throw new Error('board-build-conflict')
  if (!turn?.requiresBuild && !draft) return operation()
  if (!draft) throw new Error('board-build-required')
  if (expectedBuildId !== draft.id || draft.committed) throw new Error('board-build-conflict')
  draft.busy++
  try {
    const result = await withBoardBuildRoot(draft.root, operation)
    if (turns.get(sessionId) !== turn) throw new Error('board-build-conflict')
    return result
  } finally {
    draft.busy--
    if (turns.get(sessionId) !== turn && !draft.busy) rmSync(draft.root, { recursive: true, force: true })
  }
}

export function beginBoardBuild(sessionId: string, cwd: string, targetBoardId?: unknown, targetBoardIds?: unknown): Record<string, unknown> {
  const turn = turns.get(sessionId)
  if (!turn || turn.cwd !== cwd) return { ok: false, error: 'board-build-request-required', hint: '本会话当前没有可冻结的建板回合（工作目录已变化）。请等用户在下一条消息里直接下达建板或改板指令后再调用，不要原样重试。' }
  if (!turn.text.trim() || turn.readOnlyRequest) return { ok: false, error: 'board-build-request-required', hint: '当前用户消息被判定为问句或只读请求，不能作为冻结建板要求的依据，原样重试不会成功。若用户确实要新建或修改看板，请向用户转述需要一条明确的指令（例如「把XX看板的YY改成ZZ」「新建一个XX看板」），等用户发出后再调用本工具。' }
  if (targetBoardId !== undefined && targetBoardIds !== undefined) return { ok: false, error: 'invalid-board-id' }
  const requested = targetBoardId !== undefined ? targetIds([targetBoardId]) : targetBoardIds !== undefined ? targetIds(targetBoardIds) : undefined
  if (requested === null || requested?.length === 0) return { ok: false, error: 'invalid-board-id' }
  if (turn.pendingTargets) return { ok: false, error: 'board-target-selection-required' }
  if (turn.selection?.ok === false) return turn.selection
  const sameTargets = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id))
  if (turn.draft) return sameTargets(requested ?? turn.selection?.targetBoardIds ?? [], [...turn.draft.targets.keys()]) ? buildStatus(sessionId, turn.draft.id) : { ok: false, error: 'board-build-conflict' }
  const profile = boardProfileRoot()
  recoverBoardBuild(profile)
  const boards = listBoards()
  if (turn.selection && requested && !sameTargets(requested, turn.selection.targetBoardIds)) return { ok: false, error: 'board-target-not-selected' }
  const ids = turn.selection?.targetBoardIds ?? requested ?? []
  const targets = ids.flatMap(id => boards.filter(board => board.id === id))
  if (targets.length !== ids.length) return { ok: false, error: 'board-not-found' }
  if (targets.some(board => board.locked)) return { ok: false, error: 'board-locked' }
  if (!targets.length && (turn.editRequested || turn.preventCreate)) return { ok: false, error: 'board-target-selection-required' }
  if (targets.length && !turn.selection) {
    const exact = unambiguousTarget(turn, boards, ids)
    if (ids.length !== 1 || exact?.id !== ids[0]) return { ok: false, error: 'board-target-selection-required' }
    turn.selection = { ok: true, targetBoardIds: ids }
  }
  // Strict reads protect corrupt user stores before any draft or journal exists.
  const datasets = listDatasetsStrict()
  const recipes = listQuerySpecs(undefined, { persistMigration: false })
  const before = readBoardStoreBytes(profile)
  const id = randomUUID(), root = path.join(profile, 'board-build-drafts', id)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  atomicBoardFile(path.join(root, BOARD_STORE_FILES[0]), before[BOARD_STORE_FILES[0]] ?? JSON.stringify({ schemaVersion: 2, boards }))
  atomicBoardFile(path.join(root, BOARD_STORE_FILES[1]), before[BOARD_STORE_FILES[1]] ?? JSON.stringify(datasets))
  atomicBoardFile(path.join(root, BOARD_STORE_FILES[2]), before[BOARD_STORE_FILES[2]] ?? JSON.stringify({ specs: recipes }))
  const intents = new Map(targets.map(board => [board.id, freezeBoardBuildIntent(boardEditInstruction(turn.text, board, targets, boards), turn.id, turn.revision, board)]))
  const intent = intents.values().next().value ?? freezeBoardBuildIntent(turn.text, turn.id, turn.revision)
  turn.requiresBuild = true
  turn.draft = { id, root, profile, intent, targets: intents, before, boards: structuredClone(boards), recipes, busy: 0, sourceEvidence: new Map() }
  atomicBoardFile(path.join(root, 'intent.json'), JSON.stringify({ intent, targets: Object.fromEntries(intents) }))
  return buildStatus(sessionId, id)
}

function active(sessionId: string, buildId: unknown): { turn: BuildTurn; draft: BuildDraft } | null {
  const turn = turns.get(sessionId), draft = turn?.draft
  return turn && draft && buildId === draft.id && draft.intent.requestId === turn.id && draft.intent.revision === turn.revision ? { turn, draft } : null
}
export function buildStatus(sessionId: string, buildId?: unknown): Record<string, unknown> {
  const turn = turns.get(sessionId), draft = turn?.draft
  if (!draft) return { ok: false, error: 'board-build-required' }
  if (buildId !== undefined && buildId !== draft.id) return { ok: false, error: 'board-build-conflict' }
  const targetBoardIds = [...draft.targets.keys()]
  return { ok: true, buildId: draft.id, draft: !draft.committed, published: !!draft.committed, intent: structuredClone(draft.intent), ...(targetBoardIds.length ? { targetBoardIds } : {}), ...(targetBoardIds.length === 1 ? { targetBoardId: targetBoardIds[0] } : {}), ...(targetBoardIds.length > 1 ? { targetIntents: structuredClone(Object.fromEntries(draft.targets)) } : {}) }
}
export function frozenBoardBuildOptions(sessionId: string, buildId: unknown): BoardBuildIntent | null {
  return active(sessionId, buildId)?.draft.intent ?? null
}
/** tiktok-af 建板的 afPrefix（board_create 时记录）：提交时驱动预绑卡重绑。 */
export function setBoardBuildAfPrefix(sessionId: string, buildId: unknown, afPrefix: string): boolean {
  const state = active(sessionId, buildId)
  if (!state) return false
  state.draft.afPrefix = afPrefix
  return true
}

function changedBoards(draft: BuildDraft, partial = false): KanbanBoard[] | null {
  const boards = listBoards()
  const previous = new Map(draft.boards.map(board => [board.id, board]))
  const ids = new Set(boards.map(board => board.id))
  if (draft.boards.some(board => !ids.has(board.id))) return null
  const changed = boards.filter(board => !isDeepStrictEqual(board, previous.get(board.id)))
  if (!draft.targets.size) return changed.length === 1 && !previous.has(changed[0].id) ? changed : null
  if (changed.some(board => !draft.targets.has(board.id))) return null
  if (!partial && changed.length !== draft.targets.size) return null
  return [...draft.targets.keys()].map(id => boards.find(board => board.id === id)!)
}

function hasRequiredMeasure(board: KanbanBoard, data: BoardDataset[], intent: BoardBuildIntent, measure: NonNullable<BoardBuildIntent['measures']>[number], refresh?: BoardRefreshResult): boolean {
  const aliases = { spend: ['消耗', '花费', '费用', '媒体成本', 'spend', 'cost', 'mediacost'], conversion: ['转化', '转化次数', '转化数', 'conversion', 'conversions'], revenue: ['收入', 'revenue'] }
  const normalized = (name: string) => name.toLowerCase().replace(/[ _-]/g, '')
  const grainKeys = { account: ['advertiserid', 'accountid', '广告主id', '账户id'], campaign: ['campaignid', '活动id', '广告系列id'], adgroup: ['adgroupid', 'adsetid', '广告组id', '广告集id'], ad: ['adid', '广告id'], creative: ['creativeid', 'materialid', 'assetid', '素材id', '创意id'] }
  const grains = intent.options.granularity === undefined ? [] : typeof intent.options.granularity === 'string' ? [intent.options.granularity] : [...intent.options.granularity]
  return board.widgets.some(widget => {
    const datasets = refresh ? boardRefreshWidgetDatasets(refresh, widget, data) : data
    const bindings = boardWidgetDatasetBindings(widget)
    if (widget.type === 'tt-reading') bindings.push({ source: 'dataset', datasetId: 'TikTok 报表' })
    return bindings.some(binding => {
      const dataset = datasets.find(item => item.id === binding.datasetId || item.name === binding.datasetId)
      if (!dataset) return false
      const visible = widget.type === 'table' ? Array.isArray(widget.config.columns) ? widget.config.columns as string[] : dataset.columns.slice(0, 8).map(column => column.name) : widget.type === 'tt-reading' ? dataset.columns.map(column => column.name).filter(name => !Object.values(grainKeys).flat().includes(normalized(name))) : [binding.metric, widget.config.dimension].filter((name): name is string => typeof name === 'string')
      const metric = dataset.columns.findIndex(column => visible.includes(column.name) && column.type === 'number' && aliases[measure].includes(normalized(column.name)))
      if (metric < 0) return false
      const ids = dataset.columns.flatMap((column, index) => visible.includes(column.name) && grains.some(grain => grainKeys[grain].includes(normalized(column.name))) ? [index] : [])
      const window = boardWidgetWindow(board, widget), date = dataset.columns.findIndex(column => column.type === 'date')
      const filter = binding.filterColumn ? dataset.columns.findIndex(column => column.name === binding.filterColumn) : -1
      const values = binding.filterValues ?? (binding.filterValue ? [binding.filterValue] : [])
      return dataset.rows.some(row => typeof row[metric] === 'number' && Number.isFinite(row[metric]) && (date < 0 || String(row[date]) >= window.start && String(row[date]) <= window.end) && (!binding.filterColumn || !values.length || filter >= 0 && values.includes(String(row[filter]))) && (!grains.length || ids.some(index => typeof row[index] === 'number' ? Number.isSafeInteger(row[index]) && Number(row[index]) > 0 : typeof row[index] === 'string' && !['', '0', 'null', 'none', 'all', '—'].includes(String(row[index]).trim().toLowerCase()))))
    })
  })
}

/** Cross-language metric aliases for the mechanical heal below. */
const HEAL_ALIASES: string[][] = [
  ['消耗', '花费', '费用', '媒体成本', 'spend', 'cost', 'mediacost'],
  ['转化', '转化次数', '转化数', 'conversion', 'conversions'],
  ['收入', 'revenue'],
  ['点击', '点击数', 'clicks'],
  ['展示', '展示数', 'impressions'],
  ['安装', '安装数', 'installs']
]

const healNorm = (name: string) => name.toLowerCase().replace(/[\s_-]/g, '')

/**
 * Resolve a wanted column name to the dataset's real column when the match is
 * UNAMBIGUOUS: exact → normalized-equal → same alias bucket. Ambiguous or
 * unknown names return null — the heal never guesses.
 */
function healResolveColumn(wanted: string, columns: string[]): string | null {
  if (columns.includes(wanted)) return wanted
  const normalized = columns.filter((column) => healNorm(column) === healNorm(wanted))
  if (normalized.length === 1) return normalized[0]
  const bucket = HEAL_ALIASES.find((list) => list.some((entry) => healNorm(entry) === healNorm(wanted)))
  if (!bucket) return null
  const matches = columns.filter((column) => bucket.some((entry) => healNorm(entry) === healNorm(column)))
  return matches.length === 1 ? matches[0] : null
}

/**
 * 阶段2 mechanical heal, run inside the draft root just before validation.
 * Rewrites dataset-bound widget references that miss by exact name but match
 * unambiguously by normalization/alias (spend vs 消耗), and aligns the board's
 * masterScope range with the frozen intent. Returns human-readable notes for
 * the check payload; persists only when something actually changed.
 */
function healBoardDraft(board: KanbanBoard, datasets: BoardDataset[], intentRange?: string): string[] {
  const notes: string[] = []
  let changed = false
  const datasetOf = (id: unknown): BoardDataset | undefined => typeof id === 'string' ? datasets.find(dataset => dataset.id === id || dataset.name === id) : undefined
  const healField = (holder: Record<string, unknown>, field: string, dataset: BoardDataset, context: string): void => {
    const wanted = holder[field]
    if (typeof wanted !== 'string' || !wanted) return
    const resolved = healResolveColumn(wanted, dataset.columns.map((column) => column.name))
    if (resolved && resolved !== wanted) {
      holder[field] = resolved
      notes.push(`${context}: ${field}「${wanted}」→「${resolved}」`)
      changed = true
    }
  }
  for (const widget of board.widgets) {
    const config = widget.config as Record<string, unknown>
    if (config?.source === 'dataset') {
      const dataset = datasetOf(config.datasetId)
      if (dataset) {
        healField(config, 'metric', dataset, `组件「${widget.title || widget.type}」`)
        healField(config, 'dimension', dataset, `组件「${widget.title || widget.type}」`)
        healField(config, 'filterColumn', dataset, `组件「${widget.title || widget.type}」`)
        if (Array.isArray(config.columns)) {
          config.columns = (config.columns as unknown[]).map((column) => {
            if (typeof column !== 'string') return column
            const resolved = healResolveColumn(column, dataset.columns.map((entry) => entry.name))
            if (resolved && resolved !== column) {
              notes.push(`组件「${widget.title || widget.type}」: 列「${column}」→「${resolved}」`)
              changed = true
              return resolved
            }
            return column
          })
        }
      }
    }
    if (Array.isArray(config?.stages)) {
      const stages = config.stages as Array<Record<string, unknown>>
      for (const [index, stage] of stages.entries()) {
        const dataset = datasetOf(stage.datasetId)
        if (!dataset) continue
        healField(stage, 'metric', dataset, `漏斗阶段${index + 1}`)
        healField(stage, 'filterColumn', dataset, `漏斗阶段${index + 1}`)
      }
    }
  }
  if (intentRange && board.masterScope && board.masterScope.range !== intentRange) {
    notes.push(`总控日期范围「${board.masterScope.range}」→「${intentRange}」`)
    board.masterScope = { ...board.masterScope, range: intentRange as typeof board.masterScope.range }
    changed = true
  }
  if (changed) saveBoard(board)
  return notes
}

function inspectBoardBuild(
  draft: BuildDraft, board: KanbanBoard, intent: BoardBuildIntent, data: BoardDataset[],
  recipes: ReturnType<typeof listQuerySpecs>, savedDatasets: Map<string, BoardDataset>, feasibility: boolean
) {
  const presentation = intent.mode === 'presentation'
  const options = feasibility && !draft.targets.has(board.id)
    ? { ...intent.options, mode: 'custom' as const, required: presentation || intent.mode === 'snapshot' ? [] as const : ['data'] as const, daily: false }
    : intent.options
  const previous = draft.boards.find(item => item.id === board.id)
  // Mechanical preflight heal: deterministic alias/column rewrites and the
  // masterScope range alignment kill a whole class of model round-trips.
  // The synthetic feasibility board is never healed (it is not persisted).
  const healed = board.id !== 'feasibility' && !presentation ? healBoardDraft(board, data, intent.range) : []
  const refresh = getLatestBoardRefresh(board)
  const check = checkBoardGeneration(board, data, options, recipes, Date.now(), refresh)
  const issues = [...check.issues]
  if (!feasibility) for (const type of intent.utilityTypes ?? []) if (!board.widgets.some(widget => widget.type === type)) issues.push({ code: `intent-utility-missing:${type}` })
  if (!feasibility) for (const measure of intent.measures ?? []) if (!hasRequiredMeasure(board, data, intent, measure, refresh)) issues.push({ code: `intent-measure-missing:${measure}` })
  for (const reason of intent.unresolved ?? []) issues.push({ code: `intent-unresolved:${reason}` })
  if (intent.range && board.masterScope?.range !== intent.range) issues.push({ code: 'intent-date-scope-mismatch' })
  if (intent.fixedValues) {
    const values = board.widgets.filter(widget => widget.type === 'counter' && widget.config.source !== 'dataset').map(widget => widget.config.value).sort((a, b) => Number(a) - Number(b))
    if (!isDeepStrictEqual(values, [...intent.fixedValues].sort((a, b) => a - b))) issues.push({ code: 'intent-fixed-values-mismatch' })
  }
  if (presentation) {
    const removed = previous?.widgets.filter(widget => !board.widgets.some(next => next.id === widget.id)).map(widget => widget.id).sort() ?? []
    const added = board.widgets.filter(widget => !previous?.widgets.some(old => old.id === widget.id)).map(widget => widget.type).sort()
    if (!isDeepStrictEqual(added, [...(intent.addedUtilityTypes ?? [])].sort())) issues.push({ code: 'presentation-unrequested-addition' })
    if (!previous || !isDeepStrictEqual(removed, [...(intent.removedWidgetIds ?? [])].sort()) || board.widgets.some(widget => {
      const old = previous.widgets.find(item => item.id === widget.id)
      return old ? old.type !== widget.type || !isDeepStrictEqual(old.config, widget.config) || !isDeepStrictEqual(old.dateScope, widget.dateScope) : !['clock', 'note', 'todo', 'link'].includes(widget.type)
    }) || !isDeepStrictEqual(previous.masterScope, board.masterScope)) issues.push({ code: 'presentation-changed-data-binding' })
  }
  if (!presentation && intent.mode !== 'snapshot') {
    for (const widget of board.widgets) {
      if (!['counter', 'gauge', 'chart-line', 'chart-bar', 'reading-module', 'reading-snapshot'].includes(widget.type) || widget.config.source === 'dataset') continue
      const original = previous?.widgets.find(item => item.id === widget.id)
      if (intent.requireLiveBindings || !original || original.type !== widget.type || !isDeepStrictEqual(original.config, widget.config)) issues.push({ code: 'fixed-value-requires-explicit-snapshot', widgetId: widget.id })
    }
  }
  if (!presentation && intent.mode !== 'snapshot') {
    const canUseSavedData = previous && !intent.requireLiveBindings && !intent.refreshRequested
      && isDeepStrictEqual(previous.masterScope, board.masterScope)
      && board.widgets.every(widget => {
        const original = previous.widgets.find(item => item.id === widget.id)
        return isDeepStrictEqual(original?.dateScope, widget.dateScope)
      })
    const ids = new Set(board.widgets.flatMap(widget => boardWidgetDatasetBindings(widget).map(binding => binding.datasetId)))
    if (board.widgets.some(widget => widget.type === 'tt-reading')) ids.add('TikTok 报表')
    for (const id of ids) {
      const dataset = data.find(item => item.id === id || item.name === id)
      const sources = refresh?.widgets.flatMap(widget => [
        ...widget.bindings.filter(binding => binding.datasetId === id || binding.datasetId === dataset?.id || binding.datasetId === dataset?.name).map(binding => binding.sourceKey),
        ...(id === 'TikTok 报表' && widget.ttSummary && widget.nativeSourceKey ? [widget.nativeSourceKey] : [])
      ]).map(key => refresh.sources.find(source => source.key === key)) ?? []
      // Unavailable bindings are masked by this run, so they cannot render an
      // old base dataset. A different successful source remains publishable.
      const allUnavailable = sources.length > 0 && sources.every(source => source && source.kind !== 'dataset' && !source.dataset)
      const actualRead = sources.some(source => source?.dataset && source.kind !== 'dataset' && (source.status === 'updated' || source.status === 'empty'))
      const stored = canUseSavedData && dataset && savedDatasets.get(dataset.id)
      if (dataset && !actualRead && !allUnavailable && !(stored && isDeepStrictEqual(stored, dataset)) && draft.sourceEvidence.get(dataset.id) !== dataDigest(dataset)) issues.push({ code: 'source-query-evidence-required', datasetId: dataset.id })
    }
  }
  const passed = check.status === 'ready' && issues.length === 0
  return { ...check, status: check.missing.length ? 'incomplete' : issues.length ? 'needs-attention' : 'ready', issues, ok: passed, passed, ...(healed.length ? { healed } : {}), ...(passed ? {} : { error: feasibility ? 'board-data-not-feasible' : 'board-incomplete' }), buildId: draft.id, boardId: board.id, draft: !draft.committed, published: !!draft.committed,
    ...(feasibility && !passed ? { hint: '当前数据或已接入适配器尚不能证明本次要求；这不代表媒体平台本身不支持。请在草稿补齐真实数据或说明受阻，不能自动降级后发布。' } : {}) }
}

export function checkFrozenBoardBuild(sessionId: string, buildId: unknown, feasibility = false, boardId?: string): Record<string, unknown> {
  const state = active(sessionId, buildId)
  if (!state) return { ok: false, error: 'board-build-conflict' }
  const { draft } = state
  if (boardId && draft.targets.size && !draft.targets.has(boardId)) return { ok: false, error: 'board-target-not-selected' }
  const inspect = (): Record<string, unknown> => {
    const data = listDatasetsStrict(), recipes = listQuerySpecs(undefined, { persistMigration: false })
    let boards = changedBoards(draft, feasibility || boardId !== undefined)
    if (!boards && feasibility && !draft.targets.size) {
      boards = [{ id: 'feasibility', name: 'Data feasibility', createdAt: 0, updatedAt: 0, widgets: data.map((dataset, index) => createWidget('table', '', { x: 0, y: index * 4 }, { source: 'dataset', datasetId: dataset.id })), ...(draft.intent.range ? { masterScope: { range: draft.intent.range, metrics: ['spend'] } } : {}) }]
    }
    if (!boards) return { ok: false, error: 'board-build-target-required', buildId: draft.id, targetBoardIds: [...draft.targets.keys()], published: false }
    if (boardId) boards = boards.filter(board => board.id === boardId)
    if (!boards.length) return { ok: false, error: 'board-not-found' }
    const saved = draft.targets.size ? (JSON.parse(draft.before[BOARD_STORE_FILES[1]] ?? '[]') as BoardDataset[]) : []
    const savedDatasets = new Map(saved.map(dataset => [dataset.id, dataset]))
    const checks = boards.map(board => inspectBoardBuild(draft, board, draft.targets.get(board.id) ?? draft.intent, data, recipes, savedDatasets, feasibility))
    if (checks.length === 1) return checks[0]
    const passed = checks.every(check => check.passed)
    return { ok: passed, passed, status: passed ? 'ready' : checks.some(check => check.status === 'incomplete') ? 'incomplete' : 'needs-attention',
      ...(!passed ? { error: feasibility ? 'board-data-not-feasible' : 'board-incomplete' } : {}),
      buildId: draft.id, draft: !draft.committed, published: !!draft.committed, checks }
  }
  return draft.committed ? inspect() : withBoardBuildRoot(draft.root, inspect)
}

const coverageGaps = new Set([
  'source-failed', 'source-empty', 'query-binding-missing', 'source-not-refreshable',
  'native-data-unverified', 'dataset-missing', 'metric-data-empty', 'trend-history-insufficient',
  'source-coverage-partial', 'dataset-truncated', 'table-columns-partial', 'intent-measure-missing:spend', 'intent-measure-missing:conversion',
  'intent-measure-missing:revenue'
])

export function commitBoardBuild(sessionId: string, buildId: unknown, stillAuthorized: () => boolean, allowPartial = false): Record<string, unknown> {
  const state = active(sessionId, buildId)
  if (!state) return { ok: false, error: 'board-build-conflict' }
  const { draft } = state
  if (draft.committed) return draft.committed
  if (draft.busy) return { ok: false, error: 'board-build-busy' }
  const check = checkFrozenBoardBuild(sessionId, buildId)
  const checks = (Array.isArray(check.checks) ? check.checks : [check]) as Array<{
    boardId: string; passed?: boolean; numericCoverage?: boolean; missing?: string[]; issues?: BoardGenerationIssue[]; issuesTruncated?: true
  }>
  const partial = !check.passed && allowPartial && checks.every(item =>
    item.passed || (item.numericCoverage && !item.issuesTruncated && item.issues?.every(issue => coverageGaps.has(issue.code)) &&
      Boolean(item.issues.length || item.missing?.length)))
  if (!check.passed && !partial) return check
  if (!stillAuthorized() || active(sessionId, buildId)?.draft !== draft) return { ok: false, error: 'permission-denied' }
  // Conservative whole-store CAS also catches source-cache changes and other
  // boards changed during generation. No unrelated user write is overwritten.
  if (!isDeepStrictEqual(readBoardStoreBytes(draft.profile), draft.before)) return { ok: false, error: 'conflict', buildId: draft.id }
  // tiktok-af 契约的确定性收尾：模板预绑卡指向 AF-{afPrefix}…虚拟名，而模型
  // 拉数用的名字不可靠（实测它会用习惯名）。按本轮已登记证据的数据集重绑——
  // 绑定靠证据不靠记忆。必须跑在草稿根上下文里：拉数写进的是草稿库，证据里
  // 的数据集 id 只存在于 draft.root（在正式库上找永远找不到，重绑会静默失效）。
  // 找不到对应数据集就保留虚拟名（卡片如实显示缺数据集）。
  if (draft.afPrefix) {
    withBoardBuildRoot(draft.root, () => {
      const datasets = listDatasetsStrict()
      const evidenceIds = [...draft.sourceEvidence.keys()].filter(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      const resolveRole = (role: '基础' | '次留'): string | undefined => {
        const hits = evidenceIds
          .map(id => datasets.find(dataset => dataset.id === id))
          .filter((dataset): dataset is NonNullable<typeof dataset> => !!dataset && dataset.name.includes(role))
        return hits[0]?.id
      }
      const baseId = resolveRole('基础')
      const retentionId = resolveRole('次留')
      if (baseId || retentionId) {
        const targetIds = new Set([...draft.targets.keys()])
        for (const board of listBoards()) {
          if (draft.targets.size && !targetIds.has(board.id)) continue
          let touched = false
          const widgets = board.widgets.map(widget => {
            const bound = widget.config?.datasetId
            if (bound === `AF-${draft.afPrefix}基础分天` && baseId) { touched = true; return { ...widget, config: { ...widget.config, datasetId: baseId } } }
            if (bound === `AF-${draft.afPrefix}次留分天` && retentionId) { touched = true; return { ...widget, config: { ...widget.config, datasetId: retentionId } } }
            return widget
          })
          if (!touched) continue
          const next = { ...board, widgets, updatedAt: board.updatedAt + 1 }
          const saved = saveBoard(next, undefined, board.updatedAt)
          if (!saved.ok) throw new Error('af-preset-remap-save-failed')
        }
      }
    })
  }
  const results = withBoardBuildRoot(draft.root, () => changedBoards(draft)!.map(board => ({ board, refresh: getLatestBoardRefresh(board) })))
  if (draft.targets.size && hasUnrelatedSourceChanges(draft, results.map(({ board }) => board), readBoardStoreBytes(draft.root))) return { ok: false, error: 'board-source-outside-targets', buildId: draft.id, published: false }
  withBoardBuildRoot(draft.root, () => {
    for (const item of results) {
      const result = checks.find(entry => entry.boardId === item.board.id)!
      const intent = draft.targets.get(result.boardId) ?? draft.intent
      if (result.passed && (!item.board.partialDelivery || intent.mode === 'presentation')) continue
      const { partialDelivery: previousCoverage, ...board } = item.board
      const partialDelivery = !result.passed ? { missing: result.missing ?? [], issues: [...new Set(result.issues?.map(issue => issue.code) ?? [])] } :
        previousCoverage && !item.refresh ? previousCoverage : undefined
      const next = { ...board, updatedAt: board.updatedAt + 1, ...(partialDelivery ? { partialDelivery } : {}) }
      const saved = saveBoard(next, undefined, board.updatedAt)
      if (!saved.ok) throw new Error('board-coverage-save-failed')
      item.board = next
    }
  })
  const boards = results.map(({ board }) => board)
  publishBoardBuild(draft.profile, draft.before, readBoardStoreBytes(draft.root))
  const refreshed = results.flatMap(({ board, refresh }) => refresh ? [{ boardId: board.id, adopted: adoptBoardRefreshSnapshot(board, refresh) }] : [])
  draft.committed = { ok: true, published: true, draft: false, buildId: draft.id, boards, check, ...(partial ? { status: 'partial', passed: false } : {}),
    ...(boards.length === 1 ? { board: boards[0], ...(refreshed.length ? { refreshAdopted: refreshed[0].adopted } : {}) } : {}),
    ...(boards.length > 1 && refreshed.length ? { refreshed } : {}) }
  rmSync(draft.root, { recursive: true, force: true })
  return draft.committed
}

function hasUnrelatedSourceChanges(draft: BuildDraft, boards: KanbanBoard[], after: BuildDraft['before']): boolean {
  const dataTargets = new Set([...draft.targets].filter(([, intent]) => intent.mode !== 'presentation' && intent.mode !== 'snapshot').map(([id]) => id))
  const bindings = new Set<string>()
  for (const board of [...draft.boards, ...boards]) {
    if (!dataTargets.has(board.id)) continue
    for (const widget of board.widgets) {
      if (widget.type === 'tt-reading') bindings.add('TikTok 报表')
      for (const binding of boardWidgetDatasetBindings(widget)) bindings.add(binding.datasetId)
    }
  }
  function outside<T extends { id: string }>(saved: T[], next: T[], allowed: (record: T) => boolean): boolean {
    const protectedRecords = (records: T[]) => records.filter(record => !allowed(record)).sort((a, b) => a.id.localeCompare(b.id))
    return !isDeepStrictEqual(protectedRecords(saved), protectedRecords(next))
  }
  if (draft.before[BOARD_STORE_FILES[1]] !== after[BOARD_STORE_FILES[1]]) {
    const datasets = (files: BuildDraft['before']) => JSON.parse(files[BOARD_STORE_FILES[1]] ?? '[]') as BoardDataset[]
    if (outside(datasets(draft.before), datasets(after), dataset => bindings.has(dataset.id) || bindings.has(dataset.name) || dataTargets.has(dataset.appsflyer?.materialization?.boardId ?? ''))) return true
  }
  if (draft.before[BOARD_STORE_FILES[2]] === after[BOARD_STORE_FILES[2]]) return false
  try { JSON.parse(draft.before[BOARD_STORE_FILES[2]] ?? '{}') } catch { return true }
  const recipes = withBoardBuildRoot(draft.root, () => listQuerySpecs(undefined, { persistMigration: false }))
  return outside(draft.recipes, recipes, recipe => bindings.has(recipe.datasetId ?? '') || bindings.has(recipe.datasetName))
}
export function abortBoardBuild(sessionId: string, buildId: unknown): Record<string, unknown> {
  const state = active(sessionId, buildId)
  if (!state || state.draft.committed) return { ok: false, error: 'board-build-conflict' }
  if (state.draft.busy) return { ok: false, error: 'board-build-busy' }
  rmSync(state.draft.root, { recursive: true, force: true })
  delete state.turn.draft
  return { ok: true, aborted: true, published: false }
}
