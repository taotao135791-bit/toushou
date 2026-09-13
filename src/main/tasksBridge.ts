import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { ScheduledTask } from '../shared/types'
import { buildTaskFromAgentInput, deleteTask, listTasks, saveTask } from './scheduledTasks'

/**
 * Loopback bridge for the bundled tasks toolkit: the OMP extension registers
 * toushou_task_list/create/delete and calls back into Main over this server.
 * Main owns validation and identity — the tool process never touches the
 * settings store, and a created task's cwd is always the calling session's
 * own workspace (resolved here, never taken from tool input).
 */

const MAX_BODY_BYTES = 64 * 1024
export const TASKS_TOOLS_ENV_KEY = 'TOUSHOU_TASKS'

export type TaskBridgeRequest =
  | { action: 'task_list' }
  | { action: 'task_create'; name: unknown; prompt: unknown; schedule: unknown; notifyOnComplete?: unknown; notifyChannel?: unknown; permissionMode?: unknown }
  | { action: 'task_delete'; taskId: string }

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
      permissionMode: value.permissionMode
    }
  }
  if (value.action === 'task_delete' && typeof value.taskId === 'string') {
    return { action: 'task_delete', taskId: value.taskId }
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
    lastFailureReason: task.lastFailureReason
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
  const { getSession } = await import('./omp')
  const cwd = getSession(sessionId)?.cwd
  if (!cwd) return json(response, 200, { ok: false, error: 'no-session' })
  return json(response, 200, dispatch(tool, cwd))
}

function dispatch(tool: TaskBridgeRequest, cwd: string): Record<string, unknown> {
  if (tool.action === 'task_list') {
    return { ok: true, tasks: listTasks().map(taskView) }
  }
  if (tool.action === 'task_create') {
    const built = buildTaskFromAgentInput(tool, cwd, Date.now())
    if (!built.ok) return { ok: false, error: built.error }
    saveTask(built.task)
    return { ok: true, task: taskView(built.task) }
  }
  // task_delete
  const deleted = deleteTask(tool.taskId)
  return deleted ? { ok: true } : { ok: false, error: 'not-found' }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/** Test-only: drop tokens so module state cannot leak between cases. */
export function resetTasksBridgeForTest(): void {
  tokens.clear()
}
