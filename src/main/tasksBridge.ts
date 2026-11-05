import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { BrowserWindow, dialog } from 'electron'
import { ScheduledTask } from '../shared/types'
import { buildTaskFromAgentInput, deleteTask, listTasks, resetTaskSessionReuse, saveTask } from './scheduledTasks'
import { serializeBoundedJson } from '../shared/boundedJson'

/**
 * Loopback bridge for the bundled tasks toolkit: the OMP extension registers
 * toushou_task_list/create/delete/reset_reuse and calls back into Main over
 * this server. Main owns validation and identity — the tool process never
 * touches the settings store, and a created task's cwd is always the calling
 * session's own workspace (resolved here, never taken from tool input).
 */

const MAX_BODY_BYTES = 64 * 1024
export const TASKS_TOOLS_ENV_KEY = 'TOUSHOU_TASKS'

export type TaskBridgeRequest =
  | { action: 'task_list' }
  | { action: 'task_create'; name: unknown; prompt: unknown; schedule: unknown; notifyOnComplete?: unknown; notifyChannel?: unknown; permissionMode?: unknown; reuseSession?: unknown }
  | { action: 'task_delete'; taskId: string }
  | { action: 'task_reset_reuse'; taskId: string }

export function parseTaskBridgeRequest(raw: unknown): TaskBridgeRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.action === 'task_list') return { action: 'task_list' }
  if (value.action === 'task_create') {
    return {
      action: 'task_create',
      name: value.name,
      prompt: value.prompt,
      schedule: value.schedule,
      notifyOnComplete: value.notifyOnComplete,
      notifyChannel: value.notifyChannel,
      permissionMode: value.permissionMode,
      reuseSession: value.reuseSession
    }
  }
  if (value.action === 'task_delete' && typeof value.taskId === 'string') {
    return { action: 'task_delete', taskId: value.taskId }
  }
  if (value.action === 'task_reset_reuse' && typeof value.taskId === 'string') {
    return { action: 'task_reset_reuse', taskId: value.taskId }
  }
  return null
}

/** Public projection a task tool receives — no run ledger, no raw workspace paths beyond cwd. */
function taskView(task: ScheduledTask): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt.length > 200 ? `${task.prompt.slice(0, 200)}…` : task.prompt,
    schedule: task.schedule,
    enabled: task.enabled,
    cwd: task.cwd,
    notifyChannel: task.notifyChannel ?? 'system',
    notifyOnComplete: task.notifyOnComplete,
    lastRunAt: task.lastRunAt,
    lastFailureReason: task.lastFailureReason,
    /** True = firings continue the same conversation; reset via task_reset_reuse. */
    reuseSession: task.reuseSession === true
  }
}

let port: number | null = null
let ready: Promise<void> | null = null
const tokens = new Map<string, string>()

export function initTasksBridge(): Promise<void> {
  if (port !== null) return Promise.resolve()
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    const server = createServer((request, response) => void handle(request, response))
    const fail = (error: Error) => {
      port = null
      ready = null
      reject(error)
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return fail(new Error('tasks bridge did not receive a port'))
      port = address.port
      resolve()
    })
  })
  return ready
}

/** Per-session loopback URL injected into the OMP process env. */
export function tasksBridgeEnv(sessionId: string): Record<string, string> {
  if (port === null) return {}
  const token = randomBytes(24).toString('hex')
  // Same bound as the other bridges: dead sessions must not accumulate tokens.
  if (tokens.size >= 200) {
    const oldest = tokens.keys().next().value
    if (oldest !== undefined) tokens.delete(oldest)
  }
  tokens.set(token, sessionId)
  return { [TASKS_TOOLS_ENV_KEY]: `http://127.0.0.1:${port}/${token}` }
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
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return json(response, 400, { ok: false, error: 'bad-json' })
  }
  const tool = parseTaskBridgeRequest(raw)
  if (!tool) return json(response, 400, { ok: false, error: 'unsupported-action' })
  // Resolved lazily so the env-injection import chain (OmpProcess → here)
  // stays acyclic, mirroring the Feishu bridge.
  const { getSession, getSessionBridgeAccess } = await import('./omp')
  const cwd = getSession(sessionId)?.cwd
  if (!cwd) return json(response, 200, { ok: false, error: 'no-session' })
  if (tool.action === 'task_reset_reuse') {
    const access = getSessionBridgeAccess(sessionId)
    if (!access || access.remoteReadonly || !['full', 'no-bash', 'ask'].includes(access.mode) || access.cwd !== cwd) return json(response, 200, { ok: false, error: 'permission-denied' })
    if (access.mode === 'ask') {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
      if (!win || win.isDestroyed()) return json(response, 200, { ok: false, error: 'permission-denied' })
      const task = listTasks().find(item => item.id === tool.taskId)
      const name = typeof task?.name === 'string' ? task.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80) : ''
      let approved = false
      try {
        const result = await dialog.showMessageBox(win, {
          type: 'question', title: '确认任务操作', message: '允许此会话重置自动任务的对话复用？',
          ...(name ? { detail: `任务：${name}` } : {}),
          buttons: ['拒绝', '允许一次'], defaultId: 0, cancelId: 0, noLink: true
        })
        approved = result.response === 1
      } catch { /* Closing the native window fails closed. */ }
      if (!approved) return json(response, 200, { ok: false, error: 'permission-denied' })
      const current = getSessionBridgeAccess(sessionId)
      if (!current || current.remoteReadonly || !['full', 'no-bash', 'ask'].includes(current.mode) || current.cwd !== access.cwd) return json(response, 200, { ok: false, error: 'permission-denied' })
    }
  }
  return json(response, 200, dispatch(tool, cwd))
}

function dispatch(tool: TaskBridgeRequest, cwd: string): Record<string, unknown> {
  if (tool.action === 'task_list') {
    return { ok: true, tasks: listTasks().map(taskView) }
  }
  if (tool.action === 'task_create') {
    const built = buildTaskFromAgentInput(tool, cwd, Date.now())
    if (!built.ok) return { ok: false, error: built.error }
    // Opt-in reuse at creation time (the natural phrasing: "以后都在这个对话里跑").
    if (tool.reuseSession === true) built.task.reuseSession = true
    saveTask(built.task)
    return { ok: true, task: taskView(built.task) }
  }
  if (tool.action === 'task_reset_reuse') {
    const reset = resetTaskSessionReuse(tool.taskId)
    return reset ? { ok: true, task: taskView(reset) } : { ok: false, error: 'not-found' }
  }
  // task_delete
  const deleted = deleteTask(tool.taskId)
  return deleted ? { ok: true } : { ok: false, error: 'not-found' }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(serializeBoundedJson(body, 30_000))
}

/** Test-only: drop tokens so module state cannot leak between cases. */
export function resetTasksBridgeForTest(): void {
  tokens.clear()
}
