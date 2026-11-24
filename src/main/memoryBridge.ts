import { randomBytes } from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import { deleteMemoryEntry, moveMemoryEntry, projectMemoryKey, readMemoryLayer, saveMemoryEntry, updateMemoryText } from './memoryStore'
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
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.MEMORY_SAVED_EVENT, {
              id: result.entry.id,
              scope,
              text: result.entry.text,
              duplicate: result.duplicate
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
    const head = readFileSync(file, 'utf-8').slice(0, 16_000)
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

/**
 * 只搜当前项目的会话目录（sessionDirCandidatesFor 的全部候选布局都扫，
 * 不含别的项目）；跨项目必须走用户手动确认的通道，工具层永远给不了。
 */
function searchSessions(request: Record<string, unknown>, session: BridgeSession): unknown {
  const keywords = Array.isArray(request.keywords)
    ? request.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).slice(0, 5).map((k) => k.trim())
    : []
  if (keywords.length === 0) return { ok: false, error: 'keywords-required' }
  const days = typeof request.days === 'number' && Number.isFinite(request.days) ? Math.min(365, Math.max(1, Math.floor(request.days))) : null
  const titleWords = typeof request.titleWords === 'string' && request.titleWords.trim()
    ? request.titleWords.trim().toLowerCase()
    : null
  const agentDir = defaultPiAgentDir()
  const dirs = distinctSessionDirs(session.cwd, agentDir)
  const agentRoot = sessionsRoot(agentDir)
  const hits: SearchHit[] = []
  let scanned = 0
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
      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
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
    scope: 'current-project',
    project: session.title ?? path.basename(session.cwd),
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
  const agentDir = defaultPiAgentDir()
  const dirs = distinctSessionDirs(session.cwd, agentDir)
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
        content = readFileSync(file, 'utf-8')
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
        truncated: excerpt.length < content.length,
        excerpt: excerpt.replace(/\s+\n/g, '\n').trim().slice(0, MAX_READ_CHARS)
      }
    }
  }
  return { ok: false, error: 'session-not-found' }
}
