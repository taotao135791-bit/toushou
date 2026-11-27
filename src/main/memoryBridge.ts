import { randomBytes } from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { buildMemoryPrompt, deleteMemoryEntry, listProjectMemoryKeys, moveMemoryEntry, projectMemoryKey, readMemoryLayer, saveMemoryEntry, updateMemoryText } from './memoryStore'
import { isSessionFilePath, sessionDirCandidatesFor, sessionsRoot } from './sessionHistory'
import { defaultPiAgentDir } from './piSettings'
import { getStore } from './store'
import type { PermissionMode } from '../shared/types'

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
  for (const [token, owner] of tokens) {
    if (owner === sessionId) tokens.delete(token)
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/**
 * 跨项目访问的用户确认（原生弹窗，按钮写动词）。隔离原则"非手动不互相
 * 访问"的手动闸门：模型声称用户要求跨项目时，必须用户在弹窗里点头，
 * Main 才放行。拒绝/无窗口时一律不放行。
 */
async function confirmCrossProject(targetLabel: string): Promise<boolean> {
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
    noLink: true
  })
  return response === 0
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

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const token = (request.url ?? '').replace(/^\//, '')
  const sessionId = tokens.get(token)
  if (request.method !== 'POST' || !sessionId) return json(response, 403, { ok: false, error: 'forbidden' })
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
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
  try {
    return json(response, 200, await dispatch(body, session))
  } catch (error) {
    return json(response, 200, { ok: false, error: 'memory-action-failed', detail: String((error as Error)?.message ?? error).slice(0, 300) })
  }
}

interface SearchHit {
  uuid: string
  file: string
  title: string
  modifiedAt: number
  snippet: string
}


/**
 * 改写/删除长期记忆的用户确认（原生弹窗，按钮写动词）。Agent 默认只能
 * 追加；顺着对话修正记忆必须走这里——用户在弹窗里看到原文（和改后的
 * 新文）并点头才放行。拒绝/无窗口时一律不改。
 */
async function confirmMemoryMutation(kind: 'update' | 'delete' | 'move', scope: 'global' | 'project', currentText: string, nextText?: string, moveTo?: 'global' | 'project'): Promise<boolean> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
  if (!win) return false
  const scopeLabel = scope === 'global' ? '全局' : '本项目'
  const oldText = currentText.slice(0, 200)
  if (kind === 'move') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: '移动长期记忆',
      message: `助手请求把${scopeLabel}的一条记忆${moveTo === 'global' ? '提升为全局' : '收回到本项目'}`,
      detail: `「${oldText}」\n\n${moveTo === 'global' ? '提升后所有项目都能看到这条记忆。' : '移动后只有本项目能看到这条记忆。'}`,
      buttons: [moveTo === 'global' ? '提升为全局记忆' : '移入本项目', '留在原层'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    return response === 0
  }
  if (kind === 'delete') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '删除长期记忆',
      message: `助手请求删除${scopeLabel}的一条记忆`,
      detail: `「${oldText}」

删除后不可恢复。`,
      buttons: ['删掉这条记忆', '保留不动'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    return response === 0
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '改写长期记忆',
    message: `助手请求改写${scopeLabel}的一条记忆`,
    detail: `原文：${oldText}

改为：${(nextText ?? '').slice(0, 200)}`,
    buttons: ['改成新内容', '保留原样'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return response === 0
}

/** 找一条记忆的当前文本（改写/删除前先核实存在，弹窗要展示原文）。 */
function memoryEntryText(scope: 'global' | 'project', id: string, cwd: string): string | null {
  const key = scope === 'global' ? null : projectMemoryKey(cwd)
  const entry = readMemoryLayer(scope, key).entries.find((e) => e.id === id)
  return entry ? entry.text : null
}

/** 弹窗期间会话状态可能变化（切只读/被吊销/换目录）；落盘前按最新状态复核。 */
function sessionStillWritable(session: BridgeSession): boolean {
  const current = lookup?.(session.id)
  return !!current && current.cwd === session.cwd && current.mode !== 'readonly' && !current.remoteReadonly
}

async function dispatch(body: unknown, session: BridgeSession): Promise<unknown> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'invalid-request' }
  const request = body as Record<string, unknown>
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
          defaultId: 1, cancelId: 1, noLink: true
        })
        const current = lookup?.(session.id)
        if (response !== 0 || !current || current.remoteReadonly || current.mode === 'readonly' || current.cwd !== cwd) {
          return { ok: false, error: 'permission-denied' }
        }
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
    case 'memory_list': {
      const projectKey = projectMemoryKey(cwd)
      return {
        ok: true,
        global: readMemoryLayer('global', null).entries,
        project: readMemoryLayer('project', projectKey).entries
      }
    }
    case 'memory_all_projects': {
      // 「你还记得之前记过什么」：全局 + 全部项目的记忆，一次给全。
      // 跨项目部分弹用户确认（隔离闸门），拒绝则只返回全局和本项目。
      const others = listProjectMemoryKeys().filter(layer => !sameProject(layer.path, cwd))
      let allowedOthers: typeof others = []
      if (others.length > 0) {
        const label = others.length === 1
          ? projectLabel(others[0].path)
          : `${others.length} 个项目的记忆`
        if (await confirmCrossProject(label)) allowedOthers = others
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
      if (!await confirmCrossProject(label)) return { ok: false, error: 'user-declined' }
      const entries = readMemoryLayer('project', target.key).entries
      return { ok: true, confirmedByUser: true, project: label, entries: filterEntriesByKeywords(entries, keywords) }
    }
    case 'memory_delete': {
      // 与 memory_save 同一套纪律：只读会话直接拒；弹窗确认期间会话状态
      // 可能变化（切只读/被吊销），批准后重查再落盘。
      if (session.mode === 'readonly') return { ok: false, error: 'permission-denied' }
      const scope = request.scope === 'global' ? 'global' : 'project'
      const id = typeof request.id === 'string' ? request.id : ''
      const text = memoryEntryText(scope, id, cwd)
      if (text === null) return { ok: false, error: 'not-found' }
      if (!(await confirmMemoryMutation('delete', scope, text))) return { ok: false, error: 'user-declined' }
      if (!sessionStillWritable(session)) return { ok: false, error: 'permission-denied' }
      const removed = deleteMemoryEntry(scope, id, cwd)
      return removed ? { ok: true } : { ok: false, error: 'not-found' }
    }
    case 'memory_move': {
      // 跨层移动也是改动（project↔global 影响可见范围），同样弹确认。
      if (session.mode === 'readonly') return { ok: false, error: 'permission-denied' }
      const to = request.to === 'global' ? 'global' : 'project'
      const id = typeof request.id === 'string' ? request.id : ''
      const from = to === 'global' ? 'project' : 'global'
      const text = memoryEntryText(from, id, cwd)
      if (text === null) return { ok: false, error: 'not-found' }
      if (!(await confirmMemoryMutation('move', from, text, undefined, to))) return { ok: false, error: 'user-declined' }
      if (!sessionStillWritable(session)) return { ok: false, error: 'permission-denied' }
      const moved = moveMemoryEntry(id, from, to, cwd)
      return moved ? { ok: true } : { ok: false, error: 'move-failed' }
    }
    case 'memory_update': {
      if (session.mode === 'readonly') return { ok: false, error: 'permission-denied' }
      const scope = request.scope === 'global' ? 'global' : 'project'
      const id = typeof request.id === 'string' ? request.id : ''
      const nextText = typeof request.text === 'string' ? request.text.trim() : ''
      if (!nextText || nextText.length > 4_000) return { ok: false, error: 'invalid-text' }
      const text = memoryEntryText(scope, id, cwd)
      if (text === null) return { ok: false, error: 'not-found' }
      if (!(await confirmMemoryMutation('update', scope, text, nextText))) return { ok: false, error: 'user-declined' }
      if (!sessionStillWritable(session)) return { ok: false, error: 'permission-denied' }
      const updated = updateMemoryText(scope, id, nextText, cwd)
      return updated ? { ok: true } : { ok: false, error: 'update-failed' }
    }
    case 'prompt_context': {
      const language = getStore('language') === 'en' ? 'en' : 'zh'
      const instruction = session.instruction
        ? (language === 'en' ? '## Conversation instructions' : '## 本会话设定') + '\n' + session.instruction
        : ''
      return { ok: true, prompt: [buildMemoryPrompt(cwd, language), instruction].filter(Boolean).join('\n\n') }
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
