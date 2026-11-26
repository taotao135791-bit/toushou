import { randomBytes } from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { deleteMemoryEntry, listProjectMemoryKeys, moveMemoryEntry, projectMemoryKey, readMemoryLayer, saveMemoryEntry, updateMemoryText } from './memoryStore'
import { sessionDirCandidatesFor, sessionsRoot } from './sessionHistory'
import { defaultPiAgentDir } from './piSettings'

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
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(maxBytes, size)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, 0)
    return buf.toString('utf-8')
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
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf-8')
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
    const server = createServer((request, response) => void handle(request, response))
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
function confirmCrossProject(targetLabel: string): boolean {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
  if (!win) return false
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    title: '跨项目记忆访问',
    message: `助手请求查看「${targetLabel}」的记忆`,
    detail: '当前对话属于另一个项目。项目记忆默认互相隔离；允许后本次将读取目标项目的记忆内容。',
    buttons: ['允许本次查看', '拒绝'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return choice === 0
}

/** 按名称模糊匹配项目（basename 优先，其次全路径包含）。 */
function findProjectByName(name: string): { key: string; path: string } | null {
  const needle = name.trim().toLowerCase()
  if (!needle) return null
  const projects = listProjectMemoryKeys()
  const byBasename = projects.find((p) => {
    const base = p.path.split(/[\\/]/).filter(Boolean).pop() ?? ''
    return base.toLowerCase().includes(needle)
  })
  return byBasename ?? projects.find((p) => p.path.toLowerCase().includes(needle)) ?? null
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

async function dispatch(body: unknown, session: BridgeSession): Promise<unknown> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'invalid-request' }
  const request = body as Record<string, unknown>
  const cwd = session.cwd
  switch (request.action) {
    case 'memory_save': {
      const scope = request.scope === 'global' ? 'global' : 'project'
      // 来源自动记录当前对话（管理界面可追溯），不依赖模型自报。
      const source = { sessionTitle: (session.title ?? '').slice(0, 120) || undefined }
      const result = saveMemoryEntry({
        text: typeof request.text === 'string' ? request.text : '',
        scope,
        cwd,
        source: source.sessionTitle ? source : undefined
      })
      if (result.ok) {
        // 模型写入 → 通知窗口弹"已记住"toast（可撤销）。重复保存不弹。
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
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
      const layers = listProjectMemoryKeys().map(({ key, path }) => ({
        path,
        entries: readMemoryLayer('project', key).entries
      }))
      const others = layers.filter((layer) => layer.path !== cwd)
      let allowedOthers: typeof layers = []
      if (others.length > 0) {
        const totalEntries = others.reduce((count, layer) => count + layer.entries.length, 0)
        const label = others.length === 1
          ? path.basename(others[0].path)
          : `${others.length} 个项目的记忆（共 ${totalEntries} 条）`
        if (confirmCrossProject(label)) allowedOthers = others
      }
      return {
        ok: true,
        confirmedCrossProject: allowedOthers.length > 0,
        global: readMemoryLayer('global', null).entries,
        currentProject: readMemoryLayer('project', projectMemoryKey(cwd)).entries,
        otherProjects: allowedOthers.map(({ path, entries }) => ({
          project: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
          entries
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
          error: 'project-not-found',
          knownProjects: listProjectMemoryKeys().map(({ path }) => path.split(/[\\/]/).filter(Boolean).pop() ?? path)
        }
      }
      if (target.path === cwd) {
        // 目标就是当前项目：无需确认，直接查。
        const entries = readMemoryLayer('project', target.key).entries
        return { ok: true, project: path.basename(target.path), entries: filterEntriesByKeywords(entries, keywords) }
      }
      const label = path.basename(target.path)
      if (!confirmCrossProject(label)) return { ok: false, error: 'user-declined' }
      const entries = readMemoryLayer('project', target.key).entries
      return { ok: true, confirmedByUser: true, project: label, entries: filterEntriesByKeywords(entries, keywords) }
    }
    case 'memory_delete': {
      const scope = request.scope === 'global' ? 'global' : 'project'
      const removed = deleteMemoryEntry(scope, typeof request.id === 'string' ? request.id : '', cwd)
      return { ok: removed }
    }
    case 'memory_move': {
      const to = request.to === 'global' ? 'global' : 'project'
      const moved = moveMemoryEntry(typeof request.id === 'string' ? request.id : '', to === 'global' ? 'project' : 'global', to, cwd)
      return { ok: moved }
    }
    case 'memory_update': {
      const scope = request.scope === 'global' ? 'global' : 'project'
      const updated = updateMemoryText(scope, typeof request.id === 'string' ? request.id : '', typeof request.text === 'string' ? request.text : '', cwd)
      return { ok: updated }
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
function searchSessions(request: Record<string, unknown>, session: BridgeSession): unknown {
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
        error: 'project-not-found',
        knownProjects: listProjectMemoryKeys().map(({ path }) => path.split(/[\\/]/).filter(Boolean).pop() ?? path)
      }
    }
    if (target.path !== session.cwd) {
      const label = path.basename(target.path)
      if (!confirmCrossProject(label)) return { ok: false, error: 'user-declined' }
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
      const head = readHead(file, 512_000) ?? ''
      const tail = readTail(file, 128_000) ?? ''
      scanBudget -= head.length + tail.length
      const content = head + String.fromCharCode(10) + tail
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
function readSessionExcerpt(request: Record<string, unknown>, session: BridgeSession): unknown {
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
    if (target.path !== session.cwd) {
      const label = path.basename(target.path)
      if (!confirmCrossProject(label)) return { ok: false, error: 'user-declined' }
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
      let content: string
      try {
        content = readTail(file, MAX_READ_CHARS * 8) ?? ''
      } catch {
        continue
      }
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
