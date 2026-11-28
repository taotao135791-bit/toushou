import { randomBytes } from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, type WebContents } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { buildMemoryPrompt, deleteMemoryEntry, listProjectMemoryKeys, projectMemoryKey, readMemoryLayer, saveMemoryEntry, updateMemoryText } from './memoryStore'
import { isSessionFilePath, sessionDirCandidatesFor, sessionsRoot } from './sessionHistory'
import { defaultPiAgentDir } from './piSettings'
import { getStore } from './store'
import type { PermissionMode, SessionEvent } from '../shared/types'
import type { MemoryScope } from '../shared/memory'

function projectLabel(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd
}

function sameProject(left: string, right: string): boolean {
  if (left === right) return true
  try { return path.relative(realpathSync(left), realpathSync(right)) === '' } catch { return false }
}

/** 候选目录含同一物理目录的新旧布局别名；按真实路径去重再扫，避免重复计入。 */
function distinctSessionDirs(cwd: string, agentDir: string): string[] {
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const dir of sessionDirCandidatesFor(cwd, agentDir)) {
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    dirs.push(real)
  }
  return dirs
}

/**
 * 长期记忆的回环桥（学 boardsBridge）：omp 侧的 memory-toolkit 通过
 * TOUSHOU_MEMORY env 指向这里；每个会话的 token 绑定该会话，Main 用
 * 会话的 cwd 判定"当前项目"，项目隔离由服务端强制——工具永远看不到
 * 别的项目的记忆，除非请求明确要求跨项目且用户在界面确认过。
 */

export const MEMORY_TOOLS_ENV_KEY = 'TOUSHOU_MEMORY'

const MAX_BODY_BYTES = 512 * 1024
/** 一次检索最多翻多少个会话文件、返回多少条命中。 */
const MAX_SCAN_FILES = 300
const MAX_HITS = 8
const MAX_SNIPPET_CHARS = 400
const MAX_READ_CHARS = 12_000
const MEMORY_APPROVAL_TIMEOUT = 120_000
const MEMORY_APPROVAL_PREFIX = 'memory-mutation:'
const MEMORY_ACTIONS = new Set<unknown>(['memory_save', 'memory_list', 'memory_all_projects', 'memory_search_projects', 'memory_update', 'memory_delete'])
const MEMORY_INSTRUCTIONS = {
  zh: '长期记忆已开启。用户要求记住内容，或对话出现值得长期保留的纠正、项目事实或规则时，用 toushou_memory_save 保存并如实说明。默认本项目，通用规则才保存到全局。拿不准时先问用户。需要更正或删除时，按关键词用 toushou_memory_list 定位条目，再调用 toushou_memory_update 或 toushou_memory_delete。变更由用户确认。操作未获批准、已取消或结果未知时，停止重试并如实说明。跨项目查询使用 toushou_memory_all_projects 或 toushou_memory_search_projects。工具不可用时，不要声称已保存或修改。',
  en: 'Long-term memory is enabled. Use toushou_memory_save when asked to remember or when a lasting correction, project fact, or rule emerges. Default to project scope and use global for general rules. Ask the user when unsure. To correct or remove an entry, find it by keyword with toushou_memory_list, then use toushou_memory_update or toushou_memory_delete. The user approves changes. Report denied, cancelled or unknown results without retrying. Use toushou_memory_all_projects or toushou_memory_search_projects for cross-project recall. If a tool is unavailable, do not claim to have saved or changed memory.'
}

/** Read at most maxBytes from the START of a file (sync, bounded) — jsonl
 * transcripts can embed base64 images and reach tens of MB; a full readFileSync
 * on the main thread per candidate file would stall every window. */
function readHead(file: string, maxBytes: number): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile()) return null
    const size = stat.size
    const len = Math.min(maxBytes, size)
    const buf = Buffer.alloc(len)
    const bytes = readSync(fd, buf, 0, len, 0)
    return buf.toString('utf8', 0, bytes)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** Read the LAST maxBytes of a file (sync, bounded) — session activity appends at the tail. */
function readTail(file: string, maxBytes: number): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile()) return null
    const size = stat.size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    const bytes = readSync(fd, buf, 0, len, start)
    const text = buf.toString('utf8', 0, bytes)
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** Minimal session identity the bridge needs: id → cwd (+ title when known). */
interface BridgeSession {
  id: string
  cwd: string
  title?: string
  mode: PermissionMode
  remoteReadonly?: boolean
  instruction?: string
}

let lookup: ((sessionId: string) => BridgeSession | undefined) | null = null
let port: number | null = null
let ready: Promise<void> | null = null
const tokens = new Map<string, string>()
const desktopTurns = new Map<string, WebContents>()
const memoryRequests = new Map<AbortController, string>()
const pendingApprovals = new Map<string, { id: string; owner: WebContents; finish: (answer: boolean | null) => void }>()

export function cancelPendingMemoryMutations(sessionId?: string): void {
  for (const [controller, owner] of memoryRequests) {
    if (sessionId === undefined || sessionId === owner) controller.abort()
  }
}

/** Only prompts accepted from a desktop window can own a memory edit approval. */
export function setMemoryTurnOwner(sessionId: string, owner?: WebContents, startsTurn = true): void {
  cancelPendingMemoryMutations(sessionId)
  if (owner && !owner.isDestroyed() && (startsTurn || desktopTurns.get(sessionId) === owner)) desktopTurns.set(sessionId, owner)
  else desktopTurns.delete(sessionId)
}

export function respondMemoryMutation(sessionId: string, requestId: string, answer: unknown, sender: WebContents): boolean | undefined {
  if (!requestId.startsWith(MEMORY_APPROVAL_PREFIX)) return undefined
  const pending = pendingApprovals.get(sessionId)
  if (!pending || pending.id !== requestId || pending.owner !== sender || sender.isDestroyed()) return false
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1) return false
  if ('confirmed' in answer && typeof answer.confirmed === 'boolean') pending.finish(answer.confirmed)
  else if ('cancelled' in answer && answer.cancelled === true) pending.finish(null)
  else return false
  return true
}

export function initMemoryBridge(sessionLookup: (sessionId: string) => BridgeSession | undefined): Promise<void> {
  lookup = sessionLookup
  if (port !== null) return Promise.resolve()
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    const server = createServer((request, response) => void handle(request, response).catch(() => { if (!response.destroyed) response.destroy() }))
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        ready = null
        reject(new Error('memory bridge did not receive a port'))
        return
      }
      port = address.port
      resolve()
    })
  })
  return ready
}

export function memoryBridgeEnv(sessionId: string): Record<string, string> {
  if (port === null) return {}
  const token = randomBytes(24).toString('hex')
  if (tokens.size >= 200) {
    const oldest = tokens.keys().next().value
    if (oldest !== undefined) tokens.delete(oldest)
  }
  tokens.set(token, sessionId)
  return { [MEMORY_TOOLS_ENV_KEY]: `http://127.0.0.1:${port}/${token}` }
}

export function revokeMemoryBridgeTokens(sessionId: string): void {
  setMemoryTurnOwner(sessionId)
  for (const [token, owner] of tokens) {
    if (owner === sessionId) tokens.delete(token)
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/**
 * 跨项目访问的用户确认（原生弹窗，按钮写动词）。隔离原则"非手动不互相
 * 访问"的手动闸门：模型声称用户要求跨项目时，必须用户在弹窗里点头，
 * Main 才放行。拒绝/无窗口时一律不放行。
 */
async function confirmCrossProject(targetLabel: string, signal?: AbortSignal): Promise<boolean> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
  if (!win) return false
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '跨项目记忆访问',
    message: `助手请求查看「${targetLabel}」的记忆`,
    detail: '当前对话属于另一个项目。项目记忆默认互相隔离；允许后本次将读取目标项目的记忆内容。',
    buttons: ['允许本次查看', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    signal
  })
  return !signal?.aborted && response === 0
}

/** 按名称模糊匹配项目（basename 优先，其次全路径包含）。 */
function findProjectByName(name: string): { key: string; path: string } | null {
  const needle = name.trim().toLowerCase()
  if (!needle) return null
  const projects = listProjectMemoryKeys()
  const exact = projects.filter(project => projectLabel(project.path).toLowerCase() === needle || project.path.toLowerCase() === needle)
  const matches = exact.length ? exact : projects.filter(project => projectLabel(project.path).toLowerCase().includes(needle))
  return matches.length === 1 ? matches[0] : null
}

async function handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  const token = (incoming.url ?? '').replace(/^\//, '')
  const sessionId = tokens.get(token)
  if (incoming.method !== 'POST' || !sessionId) return json(response, 403, { ok: false, error: 'forbidden' })
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of incoming) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return json(response, 413, { ok: false, error: 'request-too-large' })
    chunks.push(buffer)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  } catch {
    return json(response, 400, { ok: false, error: 'invalid-json' })
  }
  const session = lookup?.(sessionId)
  if (!session) return json(response, 410, { ok: false, error: 'session-gone' })
  if (tokens.get(token) !== sessionId || session.remoteReadonly) return json(response, 403, { ok: false, error: 'permission-denied' })
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (!request) return json(response, 400, { ok: false, error: 'invalid-request' })
  const isMemory = MEMORY_ACTIONS.has(request.action)
  if (isMemory && getStore('memoryEnabled') === false) return json(response, 200, { ok: false, error: 'memory-disabled' })
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (response.destroyed || incoming.aborted) return
  response.once('close', abort)
  if (isMemory) memoryRequests.set(controller, sessionId)
  const revalidate = (write = false): string | null => {
    if (isMemory && getStore('memoryEnabled') === false) return 'memory-disabled'
    if (controller.signal.aborted || response.destroyed) return 'cancelled'
    const current = lookup?.(sessionId)
    if (tokens.get(token) !== sessionId || !current || current.cwd !== session.cwd || current.remoteReadonly ||
        (write && (current.mode === 'readonly' || current.mode !== session.mode))) return 'permission-denied'
    return null
  }
  try {
    return json(response, 200, await dispatch(request, session, controller.signal, revalidate))
  } catch {
    return json(response, 200, { ok: false, error: revalidate() ?? 'memory-action-failed' })
  } finally {
    response.removeListener('close', abort)
    memoryRequests.delete(controller)
  }
}

interface SearchHit {
  uuid: string
  file: string
  title: string
  modifiedAt: number
  snippet: string
}

type RevalidateMemoryRequest = (write?: boolean) => string | null

function listMemoryEntries(request: Record<string, unknown>, cwd: string) {
  const scope = request.scope ?? 'all'
  const limit = request.limit ?? 10
  const cursor = request.cursor ?? '0'
  const query = request.query ?? ''
  if ((scope !== 'all' && scope !== 'global' && scope !== 'project') ||
      typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20 ||
      typeof cursor !== 'string' || !/^\d{1,4}$/.test(cursor) ||
      typeof query !== 'string' || query.length > 120) return { ok: false, error: 'invalid-query' }
  const offset = Number(cursor)
  const keyword = query.trim().toLowerCase()
  const scopes: MemoryScope[] = scope === 'all' ? ['global', 'project'] : [scope]
  const matches = scopes.flatMap(layer => readMemoryLayer(layer, layer === 'project' ? projectMemoryKey(cwd) : null).entries
    .filter(entry => entry.text.toLowerCase().includes(keyword))
    .map(entry => ({ ...entry, scope: layer })))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const entries = matches.slice(offset, offset + limit).map(({ id, scope, text, updatedAt }) => {
    const characters = Array.from(text)
    return { id, scope, text: characters.slice(0, 300).join(''), updatedAt, truncated: characters.length > 300 }
  })
  return { ok: true, entries, nextCursor: offset + limit < matches.length ? String(offset + limit) : null }
}

function askToChangeMemory(sessionId: string, owner: WebContents, title: string, message: string, signal: AbortSignal): Promise<boolean | null> {
  const id = MEMORY_APPROVAL_PREFIX + randomBytes(16).toString('hex')
  const { promise, resolve } = Promise.withResolvers<boolean | null>()
  const send = (event: SessionEvent) => {
    if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.OMP_SESSION_EVENT, event)
  }
  const abort = () => finish(null)
  const timer = setTimeout(abort, MEMORY_APPROVAL_TIMEOUT)
  timer.unref()
  const finish = (choice: boolean | null) => {
    if (pendingApprovals.get(sessionId)?.id !== id) return
    pendingApprovals.delete(sessionId)
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    owner.removeListener('destroyed', abort)
    resolve(choice)
    try { send({ type: 'ui_cancel', sessionId, id }) } catch { /* Window is closing. */ }
  }
  pendingApprovals.set(sessionId, { id, owner, finish })
  signal.addEventListener('abort', abort, { once: true })
  owner.once('destroyed', abort)
  if (signal.aborted || owner.isDestroyed()) abort()
  else {
    try { send({ type: 'ui_request', sessionId, id, method: 'confirm', title, message, timeout: MEMORY_APPROVAL_TIMEOUT }) }
    catch { abort() }
  }
  return promise
}

async function changeMemory(request: Record<string, unknown>, session: BridgeSession, signal: AbortSignal, revalidate: RevalidateMemoryRequest) {
  const { scope, id } = request
  const update = request.action === 'memory_update'
  const nextText = typeof request.text === 'string' ? request.text.trim() : ''
  if ((scope !== 'global' && scope !== 'project') || typeof id !== 'string' || !id.length || id.length > 64) return { ok: false, error: 'invalid-entry' }
  if (update && (!nextText || typeof request.text !== 'string' || request.text.length > 2_000)) return { ok: false, error: 'invalid-text' }
  const owner = desktopTurns.get(session.id)
  const invalid = revalidate(true)
  if (invalid) return { ok: false, error: invalid }
  if (!owner || owner.isDestroyed()) return { ok: false, error: 'permission-denied' }
  if (pendingApprovals.has(session.id)) return { ok: false, error: 'approval-pending' }

  const key = scope === 'project' ? projectMemoryKey(session.cwd) : null
  const find = () => readMemoryLayer(scope, key).entries.find(entry => entry.id === id)
  const before = find()
  if (!before) return { ok: false, error: 'not-found' }
  const storagePath = getStore('memoryStoragePath')
  const en = getStore('language') === 'en'
  const destination = scope === 'global' ? (en ? 'All projects' : '所有项目') : projectLabel(session.cwd)
  const title = update ? (en ? 'Rewrite saved memory' : '改写长期记忆') : (en ? 'Delete saved memory' : '删除长期记忆')
  const message = [destination, session.title?.slice(0, 120), '', en ? 'Current text' : '原文', before.text,
    ...(update ? ['', en ? 'Replacement' : '改为', nextText] : [])].filter(line => line !== undefined).join('\n')
  const approved = await askToChangeMemory(session.id, owner, title, message, signal)
  const invalidAfter = revalidate(true)
  if (invalidAfter) return { ok: false, error: invalidAfter }
  if (approved === null || owner.isDestroyed() || desktopTurns.get(session.id) !== owner) return { ok: false, error: 'cancelled' }
  if (!approved) return { ok: false, error: 'user-declined' }
  if (getStore('memoryStoragePath') !== storagePath) return { ok: false, error: 'stale-entry' }
  const current = find()
  if (!current || current.text !== before.text || current.createdAt !== before.createdAt || current.updatedAt !== before.updatedAt) {
    return { ok: false, error: 'stale-entry' }
  }
  const committed = update ? updateMemoryText(scope, id, nextText, session.cwd) : deleteMemoryEntry(scope, id, session.cwd)
  return committed ? { ok: true, id, scope } : { ok: false, error: 'storage-unavailable' }
}

async function dispatch(request: Record<string, unknown>, session: BridgeSession, signal: AbortSignal, revalidate: RevalidateMemoryRequest): Promise<unknown> {
  const cwd = session.cwd
  switch (request.action) {
    case 'memory_save': {
      const scope = request.scope === 'global' ? 'global' : 'project'
      const text = typeof request.text === 'string' ? request.text.trim() : ''
      if (!text || text.length > 4_000) return { ok: false, error: 'invalid-text' }
      if (session.mode === 'readonly') return { ok: false, error: 'permission-denied' }
      if (session.mode === 'ask' || scope === 'global') {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(w => w.isVisible() && !w.isDestroyed())
        if (!win) return { ok: false, error: 'permission-denied' }
        const en = getStore('language') === 'en'
        const destination = scope === 'global' ? (en ? 'All projects' : '所有项目') : projectLabel(cwd)
        const { response } = await dialog.showMessageBox(win, {
          type: 'question', title: en ? 'Save memory' : '保存记忆',
          message: destination, detail: text.slice(0, 500),
          buttons: en ? ['Save memory', 'Cancel'] : ['保存记忆', '取消'],
          defaultId: 1, cancelId: 1, noLink: true, signal
        })
        const invalid = revalidate(true)
        if (invalid || response !== 0) return { ok: false, error: invalid ?? 'permission-denied' }
      }
      // 来源自动记录当前对话（管理界面可追溯），不依赖模型自报。
      const source = { sessionTitle: (session.title ?? '').slice(0, 120) || undefined }
      const result = saveMemoryEntry({
        text,
        scope,
        cwd,
        source: source.sessionTitle ? source : undefined
      })
      if (result.ok) {
        // 模型写入 → 通知窗口弹"已记住"toast（可撤销）。重复保存不弹。
        for (const win of BrowserWindow.getAllWindows()) {
          if (!result.duplicate && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.MEMORY_SAVED_EVENT, {
              id: result.entry.id,
              scope,
              text: result.entry.text,
              duplicate: result.duplicate,
              // 来源会话 cwd：toast 撤销时按正确的项目层删除（查看方可能已切走）。
              cwd
            })
          }
        }
        return { ok: true, id: result.entry.id, scope, duplicate: result.duplicate ?? false }
      }
      return { ok: false, error: result.error }
    }
    case 'memory_list':
      return listMemoryEntries(request, cwd)
    case 'memory_update':
    case 'memory_delete':
      return changeMemory(request, session, signal, revalidate)
    case 'memory_all_projects': {
      // 「你还记得之前记过什么」：全局 + 全部项目的记忆，一次给全。
      // 跨项目部分弹用户确认（隔离闸门），拒绝则只返回全局和本项目。
      const others = listProjectMemoryKeys().filter(layer => !sameProject(layer.path, cwd))
      let allowedOthers: typeof others = []
      if (others.length > 0) {
        const label = others.length === 1
          ? projectLabel(others[0].path)
          : `${others.length} 个项目的记忆`
        if (await confirmCrossProject(label, signal)) allowedOthers = others
        const invalid = revalidate()
        if (invalid) return { ok: false, error: invalid }
      }
      return {
        ok: true,
        confirmedCrossProject: allowedOthers.length > 0,
        global: readMemoryLayer('global', null).entries,
        currentProject: readMemoryLayer('project', projectMemoryKey(cwd)).entries,
        otherProjects: allowedOthers.map(({ path, key }) => ({
          project: projectLabel(path),
          entries: readMemoryLayer('project', key).entries
        }))
      }
    }
    case 'memory_search_projects': {
      // 「去某个项目里找那条记忆」：按项目名模糊定位 → 用户确认 → 搜索。
      const projectName = typeof request.projectName === 'string' ? request.projectName : ''
      const keywords = Array.isArray(request.keywords)
        ? request.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).slice(0, 5).map((k) => k.trim())
        : []
      if (!keywords.length) return { ok: false, error: 'keywords-required' }
      const target = findProjectByName(projectName)
      if (!target) {
        return {
          ok: false,
          error: 'project-not-found'
        }
      }
      if (sameProject(target.path, cwd)) {
        // 目标就是当前项目：无需确认，直接查。
        const entries = readMemoryLayer('project', target.key).entries
        return { ok: true, project: projectLabel(target.path), entries: filterEntriesByKeywords(entries, keywords) }
      }
      const label = projectLabel(target.path)
      const approved = await confirmCrossProject(label, signal)
      const invalid = revalidate()
      if (invalid || !approved) return { ok: false, error: invalid ?? 'user-declined' }
      const entries = readMemoryLayer('project', target.key).entries
      return { ok: true, confirmedByUser: true, project: label, entries: filterEntriesByKeywords(entries, keywords) }
    }
    case 'prompt_context': {
      const language = getStore('language') === 'en' ? 'en' : 'zh'
      const instruction = session.instruction
        ? (language === 'en' ? '## Conversation instructions' : '## 本会话设定') + '\n' + session.instruction
        : ''
      const enabled = getStore('memoryEnabled') !== false
      const guidance = enabled && session.mode !== 'readonly' ? MEMORY_INSTRUCTIONS[language] : ''
      return { ok: true, prompt: [guidance, enabled ? buildMemoryPrompt(cwd, language) : '', instruction].filter(Boolean).join('\n\n') }
    }
    case 'session_search': {
      return searchSessions(request, session)
    }
    case 'session_read': {
      return readSessionExcerpt(request, session)
    }
    default:
      return { ok: false, error: 'unknown-action' }
  }
}

/** Title lookup follows the same durable overlay the sidebar uses. */
function titleForFile(file: string): string {
  try {
    const head = readHead(file, 16_000) ?? ''
    for (const line of head.split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        if (record.type === 'title' && typeof record.title === 'string' && record.title.trim()) return record.title.slice(0, 120)
        if (record.type === 'session') {
          const inner = record as { title?: unknown }
          if (typeof inner.title === 'string' && inner.title.trim()) return inner.title.slice(0, 120)
        }
      } catch {
        continue
      }
    }
  } catch {
    // Unreadable file: fall through to the filename.
  }
  return path.basename(file)
}

/** A directory label is not proof of ownership in historical OMP layouts. */
function readOwnedSessionHead(file: string, cwd: string, agentDir: string, limit: number): string | null {
  if (!isSessionFilePath(file, agentDir)) return null
  try {
    if (path.relative(file, realpathSync(file)) !== '') return null
    const head = readHead(file, limit)
    if (!head) return null
    const record = JSON.parse(head.split('\n', 1)[0])
    return record?.type === 'session' && typeof record.cwd === 'string' && sameProject(record.cwd, cwd) ? head : null
  } catch { return null }
}

function transcriptText(records: string): string {
  const messages: string[] = []
  for (const line of records.split('\n')) {
    try {
      const entry = JSON.parse(line)
      const message = entry?.message
      if (entry?.type !== 'message' || !message || !['user', 'assistant'].includes(message.role)) continue
      if (typeof message.content === 'string') messages.push(message.content)
      else if (Array.isArray(message.content)) {
        messages.push(message.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: { text: string }) => part.text).join('\n'))
      }
    } catch { /* A bounded read can end in a partial JSONL record. */ }
  }
  return messages.join('\n')
}

function snippetAround(content: string, needle: string): string {
  const lower = content.toLowerCase()
  const at = lower.indexOf(needle.toLowerCase())
  if (at < 0) return content.slice(0, MAX_SNIPPET_CHARS)
  const start = Math.max(0, at - MAX_SNIPPET_CHARS / 2)
  return content.slice(start, start + MAX_SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
}

/** 按关键词过滤记忆条目（任一命中即保留；无关键词返回全部）。 */
function filterEntriesByKeywords(entries: Array<{ id: string; text: string; createdAt: number; updatedAt: number; source?: unknown }>, keywords: string[]): typeof entries {
  if (keywords.length === 0) return entries
  return entries.filter((entry) => {
    const text = entry.text.toLowerCase()
    return keywords.some((keyword) => text.includes(keyword.toLowerCase()))
  })
}

/**
 * 只搜当前项目的会话目录（sessionDirCandidatesFor 的全部候选布局都扫，
 * 不含别的项目）；跨项目必须走用户手动确认的通道，工具层永远给不了。
 */
async function searchSessions(request: Record<string, unknown>, session: BridgeSession): Promise<unknown> {
  const keywords = Array.isArray(request.keywords)
    ? request.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).slice(0, 5).map((k) => k.trim())
    : []
  if (keywords.length === 0) return { ok: false, error: 'keywords-required' }
  // 跨项目检索：用户手动触发（模型在用户明确要求时才带 projectName），
  // Main 再弹一次确认——两层都在才算"手动"。
  let scanCwd = session.cwd
  let scopeProject: string | null = null
  const projectName = typeof request.projectName === 'string' ? request.projectName.trim() : ''
  if (projectName) {
    const target = findProjectByName(projectName)
    if (!target) {
      return {
        ok: false,
        error: 'project-not-found'
      }
    }
    if (!sameProject(target.path, session.cwd)) {
      const label = projectLabel(target.path)
      if (!await confirmCrossProject(label)) return { ok: false, error: 'user-declined' }
      scopeProject = label
    }
    scanCwd = target.path
  }
  const days = typeof request.days === 'number' && Number.isFinite(request.days) ? Math.min(365, Math.max(1, Math.floor(request.days))) : null
  const titleWords = typeof request.titleWords === 'string' && request.titleWords.trim()
    ? request.titleWords.trim().toLowerCase()
    : null
  const agentDir = defaultPiAgentDir()
  const dirs = distinctSessionDirs(scanCwd, agentDir)
  const agentRoot = sessionsRoot(agentDir)
  const hits: SearchHit[] = []
  let scanned = 0
  let scanBudget = 16 * 1024 * 1024
  for (const dir of dirs) {
    if (hits.length >= MAX_HITS || scanned >= MAX_SCAN_FILES) break
    let files: string[]
    try {
      files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of files) {
      if (hits.length >= MAX_HITS || scanned >= MAX_SCAN_FILES) break
      const file = path.join(dir, name)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (days !== null && Date.now() - stat.mtimeMs > days * 24 * 60 * 60 * 1000) continue
      scanned += 1
      const uuid = name.match(/_([^_]+)\.jsonl$/)?.[1] ?? name
      let title = titleForFile(file)
      if (!title || title === name) title = name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, '').replace(/\.jsonl$/, '')
      if (titleWords && !title.toLowerCase().includes(titleWords)) continue
      // 有界读取：头 512KB + 尾 128KB，并消耗全局字节预算（防止大转写文件阻塞主进程）。
      if (scanBudget <= 0) break
      const head = readOwnedSessionHead(file, scanCwd, agentDir, 512_000)
      if (!head) continue
      const tail = stat.size > 512_000 ? readTail(file, 128_000) ?? '' : ''
      scanBudget -= Buffer.byteLength(head) + Buffer.byteLength(tail)
      const content = transcriptText(head + '\n' + tail)
      const matched = keywords.find((keyword) => content.toLowerCase().includes(keyword.toLowerCase()))
      if (!matched) continue
      hits.push({
        uuid,
        file: path.relative(agentRoot, file),
        title,
        modifiedAt: stat.mtimeMs,
        snippet: snippetAround(content, matched)
      })
    }
  }
  return {
    ok: true,
    scanned,
    scope: scopeProject ? `cross-project: ${scopeProject}` : 'current-project',
    project: scopeProject ?? session.title ?? path.basename(session.cwd),
    hits: hits.sort((a, b) => b.modifiedAt - a.modifiedAt)
  }
}

/**
 * 读取一个命中的老对话（限当前项目；按 uuid 定位文件，返回有界摘录）。
 */
async function readSessionExcerpt(request: Record<string, unknown>, session: BridgeSession): Promise<unknown> {
  const uuid = typeof request.uuid === 'string' ? request.uuid : ''
  const keyword = typeof request.keyword === 'string' && request.keyword.trim() ? request.keyword.trim() : null
  if (!uuid) return { ok: false, error: 'uuid-required' }
  // 跨项目读取：与检索同样的确认闸门。
  let scanCwd = session.cwd
  let scopeProject: string | null = null
  const projectName = typeof request.projectName === 'string' ? request.projectName.trim() : ''
  if (projectName) {
    const target = findProjectByName(projectName)
    if (!target) return { ok: false, error: 'project-not-found' }
    if (!sameProject(target.path, session.cwd)) {
      const label = projectLabel(target.path)
      if (!await confirmCrossProject(label)) return { ok: false, error: 'user-declined' }
      scopeProject = label
    }
    scanCwd = target.path
  }
  const agentDir = defaultPiAgentDir()
  const dirs = distinctSessionDirs(scanCwd, agentDir)
  for (const dir of dirs) {
    let files: string[]
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(`_${uuid}.jsonl`))
    } catch {
      continue
    }
    for (const name of files) {
      const file = path.join(dir, name)
      if (!readOwnedSessionHead(file, scanCwd, agentDir, 16_000)) continue
      const content = transcriptText(readTail(file, MAX_READ_CHARS * 8) ?? '')
      if (!content) continue
      let excerpt: string
      if (keyword) {
        const at = content.toLowerCase().indexOf(keyword.toLowerCase())
        excerpt = at < 0
          ? content.slice(0, MAX_READ_CHARS)
          : content.slice(Math.max(0, at - MAX_READ_CHARS / 3), at + (MAX_READ_CHARS * 2) / 3)
      } else {
        excerpt = content.slice(0, MAX_READ_CHARS)
      }
      return {
        ok: true,
        uuid,
        title: titleForFile(file),
        ...(scopeProject ? { project: scopeProject } : {}),
        truncated: excerpt.length < content.length,
        excerpt: excerpt.replace(/\s+\n/g, '\n').trim().slice(0, MAX_READ_CHARS)
      }
    }
  }
  return { ok: false, error: 'session-not-found' }
}
