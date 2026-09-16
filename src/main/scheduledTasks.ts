import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { getStore, setStore } from './store'
import { ScheduledTask, TaskFailureReason, TaskRunEntry, TaskSchedule } from '../shared/types'
import { isValidSkillId } from '../shared/skills'
import { IPC_CHANNELS } from '../shared/constants'

/**
 * Scheduled task engine.
 *
 * Tasks are stored in the settings store under `scheduledTasks`. A 60 s
 * interval checks for due tasks; when one fires, it creates a session in the
 * task's project directory via the injected `spawnFn`, sends the prompt, and
 * the session's own events drive completion (see noteTaskSessionEvent).
 *
 * Tasks only fire while the app is running. A task never overlaps itself:
 * the running guard is released by the session's terminal event — with a
 * generous wall-clock fallback in case events are lost. A task that fails
 * three times in a row is auto-disabled and surfaced through a notification
 * instead of retrying forever in the dark.
 *
 * `spawnFn` is injected (instead of imported from omp/) so this module has no
 * static dependency on the OMP runtime — tests can stub it and the import
 * chain stays acyclic.
 */

const CHECK_INTERVAL_MS = 60_000
/** Fallback guard lifetime if the session's terminal event never arrives. */
export const MAX_RUN_MS = 6 * 60 * 60 * 1000
/** Consecutive spawn failures before a task disables itself. */
const MAX_CONSECUTIVE_FAILURES = 3
/** Cap on stored tasks — mainly so an agent-created loop cannot flood the store. */
export const MAX_TASKS = 50
/** Per-task run-ledger length. Older entries fall off the front. */
export const MAX_RUN_ENTRIES = 10

export interface TaskSpawnResult {
  sessionId: string
  /** Optional cancellation hook for a spawn that returns after its run timed out. */
  cancel?: () => void | Promise<void>
}

/** Task-level options handed to the spawn implementation. */
export interface TaskSpawnOptions {
  taskId: string
  runId?: string
  /** 'readonly' opts the unattended session down from the global mode. */
  permissionMode?: 'default' | 'readonly'
  /** Skill library id injected as the firing session's system prompt. */
  skillId?: string
}

export type TaskSpawnFn = (
  cwd: string,
  title: string,
  prompt: string,
  opts?: TaskSpawnOptions
) => Promise<TaskSpawnResult | null>

/** Terminal-session hook so guards and completion notices track reality. */
export type TaskSessionEventNote = (
  sessionId: string,
  event: { type: string; status?: string; isTerminal?: boolean; recoverable?: boolean }
) => void

let spawnFn: TaskSpawnFn | null = null
/** taskId → { sessionId, fallbackTimer } for the currently-running firing. */
interface RunningFiring {
  runId: string
  sessionId?: string
  /** Main-side abort handle for a session that has already spawned. */
  cancel?: TaskSpawnResult['cancel']
  startedAt: number
  fallbackTimer: ReturnType<typeof setTimeout>
}
const runningTasks = new Map<string, RunningFiring>()
/** sessionId → taskId once a firing's session exists. */
const taskBySession = new Map<string, string>()
/** Durable lookup retained after a terminal event so a late runtime
 * handshake can still attach the opaque history UUID to the finished run. */
const taskRunBySession = new Map<string, { taskId: string; runId: string }>()
const cancellationRequested = new Set<string>()

export function setTaskSpawnFn(fn: TaskSpawnFn): void {
  spawnFn = fn
}

function getTasks(): ScheduledTask[] {
  const value = getStore('scheduledTasks')
  return Array.isArray(value) ? (value as ScheduledTask[]) : []
}

function saveTasks(tasks: ScheduledTask[]): void {
  setStore('scheduledTasks', tasks)
}

export function listTasks(): ScheduledTask[] {
  return getTasks()
}

/** Fields owned by the engine, never by the renderer: an edit (which sends a
 * whole task back) must not reset the run ledger. */
const RUNTIME_OWNED_KEYS = [
  'lastRunAt',
  'lastRunSessionId',
  'lastRunId',
  'lastRunStatus',
  'consecutiveFailures',
  'lastFailureReason',
  'runs'
] as const

export function saveTask(task: ScheduledTask): ScheduledTask {
  const tasks = getTasks()
  const index = tasks.findIndex((t) => t.id === task.id)
  if (index >= 0) {
    const previous = tasks[index]
    const carried = Object.fromEntries(
      RUNTIME_OWNED_KEYS.filter((key) => previous[key] !== undefined).map((key) => [key, previous[key]])
    )
    tasks[index] = { ...task, ...carried }
  } else {
    tasks.push(task)
  }
  saveTasks(tasks)
  broadcastTasksChanged()
  return task
}

export function deleteTask(id: string): boolean {
  const tasks = getTasks()
  const next = tasks.filter((t) => t.id !== id)
  if (next.length === tasks.length) return false
  saveTasks(next)
  broadcastTasksChanged()
  return true
}

export type AgentTaskInputResult =
  | { ok: true; task: ScheduledTask }
  | { ok: false; error: string }

/**
 * Validate agent-supplied task fields and bind them to `cwd` — the session's
 * own workspace, never a directory the agent names. The engine owns identity
 * (id/createdAt/enabled) and the run ledger; a created task always starts
 * enabled so "create then run" needs no second step.
 */
export function buildTaskFromAgentInput(raw: unknown, cwd: string, now: number): AgentTaskInputResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid-input' }
  const value = raw as Record<string, unknown>
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) {
    return { ok: false, error: 'invalid-name' }
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.trim().length > 4000) {
    return { ok: false, error: 'invalid-prompt' }
  }
  if (!isValidSchedule(value.schedule)) return { ok: false, error: 'invalid-schedule' }
  if (
    value.permissionMode !== undefined &&
    value.permissionMode !== 'default' &&
    value.permissionMode !== 'readonly'
  ) {
    return { ok: false, error: 'invalid-permission-mode' }
  }
  if (value.notifyChannel !== undefined && value.notifyChannel !== 'system' && value.notifyChannel !== 'feishu') {
    return { ok: false, error: 'invalid-notify-channel' }
  }
  if (value.skillId !== undefined && !isValidSkillId(value.skillId)) {
    return { ok: false, error: 'invalid-skill-id' }
  }
  if (getTasks().length >= MAX_TASKS) return { ok: false, error: 'too-many-tasks' }
  const task: ScheduledTask = {
    id: `task-${now}-${Math.random().toString(36).slice(2, 6)}`,
    name: value.name.trim(),
    prompt: value.prompt.trim(),
    cwd,
    schedule: value.schedule,
    enabled: true,
    createdAt: now,
    notifyOnComplete: value.notifyOnComplete !== false,
    ...(value.notifyChannel === 'feishu' ? { notifyChannel: 'feishu' as const } : {}),
    ...(typeof value.skillId === 'string' && isValidSkillId(value.skillId) ? { skillId: value.skillId } : {}),
    ...(value.permissionMode === 'readonly' ? { permissionMode: 'readonly' as const } : {})
  }
  return { ok: true, task }
}

export function toggleTask(id: string, enabled: boolean): ScheduledTask | null {
  const tasks = getTasks()
  const task = tasks.find((t) => t.id === id)
  if (!task) return null
  task.enabled = enabled
  // A manual re-enable is an explicit vote of confidence: give the task a
  // clean failure slate instead of letting old failures disable it again on
  // the next hiccup.
  if (enabled) task.consecutiveFailures = 0
  saveTasks(tasks)
  broadcastTasksChanged()
  return task
}

/** Structural validation for a schedule coming over IPC or the agent bridge. */
export function isValidSchedule(value: unknown): value is TaskSchedule {
  if (!value || typeof value !== 'object') return false
  const schedule = value as Record<string, unknown>
  if (schedule.type === 'daily' || schedule.type === 'weekly' || schedule.type === 'weekdays') {
    if (typeof schedule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return false
    if (schedule.type === 'weekly') {
      if (typeof schedule.dayOfWeek !== 'number' || !Number.isInteger(schedule.dayOfWeek)) return false
      if (schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6) return false
    }
    return true
  }
  if (schedule.type === 'interval') {
    // Exactly one granularity must be present — a shape with both (or neither)
    // would make the due computation ambiguous.
    if (schedule.minutes !== undefined) {
      if (schedule.hours !== undefined) return false
      return (
        typeof schedule.minutes === 'number' &&
        Number.isInteger(schedule.minutes) &&
        schedule.minutes >= 1 &&
        schedule.minutes <= 7 * 24 * 60
      )
    }
    return (
      typeof schedule.hours === 'number' &&
      Number.isInteger(schedule.hours) &&
      schedule.hours >= 1 &&
      schedule.hours <= 168
    )
  }
  return false
}

/** Compute the next due timestamp for a schedule, anchored to `after`. */
export function nextRunAt(schedule: TaskSchedule, after: number): number {
  const d = new Date(after)
  const parseTime = (time: string): [number, number] => {
    const [h, m] = time.split(':').map(Number)
    return [h ?? 0, m ?? 0]
  }
  if (schedule.type === 'daily') {
    const [h, m] = parseTime(schedule.time)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0)
    if (next.getTime() <= after) next.setDate(next.getDate() + 1)
    return next.getTime()
  }
  if (schedule.type === 'weekly') {
    const [h, m] = parseTime(schedule.time)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0)
    const delta = (schedule.dayOfWeek - next.getDay() + 7) % 7
    next.setDate(next.getDate() + delta)
    if (next.getTime() <= after) next.setDate(next.getDate() + 7)
    return next.getTime()
  }
  if (schedule.type === 'weekdays') {
    const [h, m] = parseTime(schedule.time)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0)
    // 0=Sun .. 6=Sat — roll forward to the next Monday–Friday slot.
    while (next.getDay() === 0 || next.getDay() === 6 || next.getTime() <= after) {
      next.setDate(next.getDate() + 1)
    }
    return next.getTime()
  }
  if (schedule.type === 'interval') {
    if (typeof schedule.minutes === 'number') return after + schedule.minutes * 60_000
    return after + (schedule.hours ?? 0) * 3_600_000
  }
  // Unknown schedule shape: never due (a malformed store entry must not turn
  // into a 30-minute retry loop).
  return Number.NaN
}

/** True when a task should fire now. */
export function isDue(task: ScheduledTask, now: number): boolean {
  if (!task.enabled) return false
  if (runningTasks.has(task.id)) return false
  const anchor = task.lastRunAt ?? task.createdAt
  const due = nextRunAt(task.schedule, anchor)
  return Number.isFinite(due) && due <= now
}

function broadcastTasksChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.TASKS_STATE_CHANGED, getTasks())
    }
  }
}

/** Completion/failure notice sink — wired by ipc.ts to desktop notifications
 * and the Feishu push. Receives the stored task so the sink can honor its
 * notify options without re-reading the store. */
type TaskOutcome = {
  kind: 'finished' | 'failed' | 'disabled'
  task: ScheduledTask
  sessionId?: string
}
let onTaskOutcome: ((outcome: TaskOutcome) => void) | null = null

export function setTaskOutcomeSink(sink: (outcome: TaskOutcome) => void): void {
  onTaskOutcome = sink
}

/** Test-only: drop the outcome sink so module state cannot leak between cases. */
export function setTaskOutcomeSinkResetForTest(): void {
  onTaskOutcome = null
}

/** Test-only: clear running guards so cases start from a clean slate. */
export function resetRunningGuardsForTest(): void {
  for (const running of runningTasks.values()) clearTimeout(running.fallbackTimer)
  runningTasks.clear()
  taskBySession.clear()
  taskRunBySession.clear()
  cancellationRequested.clear()
}

function releaseFiring(taskId: string): void {
  const running = runningTasks.get(taskId)
  if (!running) return
  clearTimeout(running.fallbackTimer)
  runningTasks.delete(taskId)
  if (running.sessionId) taskBySession.delete(running.sessionId)
}

/**
 * Feed session events for task-spawned sessions. The session's terminal
 * state (idle after a turn, fatal error, or process exit) releases the
 * per-task guard so a long-running turn can never overlap itself, closes the
 * firing's run-ledger entry, and fires the task-scoped completion notice when
 * the task asks for one.
 */
export function noteTaskSessionEvent(sessionId: string, event: {
  type: string
  status?: string
  isTerminal?: boolean
  recoverable?: boolean
}): void {
  const taskId = taskBySession.get(sessionId)
  if (!taskId) return
  const terminal =
    (event.type === 'status' && event.status === 'idle' && event.isTerminal !== false) ||
    (event.type === 'error' && event.recoverable === false) ||
    event.type === 'closed'
  if (event.type === 'status' && event.status === 'aborting') {
    cancellationRequested.add(sessionId)
    return
  }
  if (!terminal) return
  if (event.type === 'status' && event.status === 'idle') {
    const running = runningTasks.get(taskId)
    const cancelled = cancellationRequested.delete(sessionId)
    if (running) settleFiring(taskId, running.runId, cancelled ? 'failed' : 'success', cancelled ? 'cancelled' : undefined, sessionId)
    return
  }
  // error (fatal) or closed without a completing idle: the run did not finish
  // cleanly — an open run is settled exactly once and never reads as success.
  const running = runningTasks.get(taskId)
  const cancelled = cancellationRequested.delete(sessionId)
  if (running) settleFiring(taskId, running.runId, 'failed', cancelled ? 'cancelled' : 'run-error', sessionId)
}

/** Attach the runtime's opaque durable transcript identity to this run. */
export function noteTaskSessionFile(sessionId: string, runId: string, historyUuid: string): void {
  const relation = taskRunBySession.get(sessionId)
  const taskId = taskBySession.get(sessionId) ?? relation?.taskId
  const linkedRunId = relation?.runId ?? runId
  if (!taskId || !linkedRunId || !historyUuid || (relation && relation.runId !== runId)) return
  updateStoredTask(taskId, (stored) => {
    const run = (stored.runs ?? []).find((entry) => entry.runId === linkedRunId)
    if (run && !run.historyUuid) run.historyUuid = historyUuid.slice(0, 200)
  })
}

/** Update one task from one fresh store snapshot, then broadcast the result. */
function updateStoredTask(taskId: string, update: (task: ScheduledTask) => void): ScheduledTask | null {
  const tasks = getTasks()
  const index = tasks.findIndex((task) => task.id === taskId)
  if (index < 0) return null
  const stored = {
    ...tasks[index],
    ...(tasks[index].runs ? { runs: tasks[index].runs!.map((run) => ({ ...run })) } : {})
  }
  update(stored)
  tasks[index] = stored
  saveTasks(tasks)
  broadcastTasksChanged()
  return stored
}

function updateRunEntry(
  taskId: string,
  runId: string,
  update: (run: TaskRunEntry) => void
): { task: ScheduledTask; settled: boolean } | null {
  let settled = false
  const task = updateStoredTask(taskId, (stored) => {
    const run = (stored.runs ?? []).find((entry) => entry.runId === runId)
    if (!run || run.finishedAt !== undefined) return
    update(run)
    settled = true
  })
  return task ? { task, settled } : null
}

function settleFiring(
  taskId: string,
  runId: string,
  outcome: 'success' | 'failed',
  reason?: TaskFailureReason,
  sessionId?: string
): void {
  const running = runningTasks.get(taskId)
  if (!running || running.runId !== runId) return
  releaseFiring(taskId)
  const updated = updateRunEntry(taskId, runId, (run) => {
    const finishedAt = Date.now()
    run.finishedAt = finishedAt
    run.outcome = outcome
    run.status = outcome === 'success' ? 'completed' : reason === 'cancelled' ? 'cancelled' : reason === 'interrupted' || reason === 'timeout' ? 'interrupted' : 'failed'
    if (reason) run.reason = reason
    if (reason === 'timeout' || reason === 'interrupted') {
      run.recovery = '可以立即重试；旧运行已从任务队列中解除。'
    } else if (reason === 'run-error') {
      run.recovery = '检查会话错误后可重新运行。'
    }
    if (sessionId && !run.sessionId) run.sessionId = sessionId
  })
  if (!updated?.settled) return
  const task = updateStoredTask(taskId, (stored) => {
    stored.lastRunStatus = outcome === 'success' ? 'completed' : updated.task.runs?.find((run) => run.runId === runId)?.status
    stored.lastRunSessionId = sessionId ?? stored.lastRunSessionId
    stored.lastFailureReason = reason
    stored.consecutiveFailures = outcome === 'success' ? 0 : (stored.consecutiveFailures ?? 0) + 1
    if (outcome === 'failed' && (stored.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
      stored.enabled = false
    }
  })
  if (!task) return
  if (outcome === 'success') {
    if (task.notifyOnComplete !== false) onTaskOutcome?.({ kind: 'finished', task, sessionId })
  } else if ((task.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES && !task.enabled) {
    onTaskOutcome?.({ kind: 'disabled', task, sessionId })
  } else if (task.notifyOnComplete !== false) {
    onTaskOutcome?.({ kind: 'failed', task, sessionId })
  }
}

function beginFiring(task: ScheduledTask): { runId: string; startedAt: number } | null {
  const runId = randomUUID()
  const startedAt = Date.now()
  runningTasks.set(task.id, {
    runId,
    startedAt,
    fallbackTimer: setTimeout(() => {
      // Events lost (runtime killed without a closed event) are a failed,
      // interrupted run. If spawn already returned, invoke its real cancel
      // handle before releasing the guard; changing the ledger alone would
      // let an old session continue beside the retry.
      const running = runningTasks.get(task.id)
      if (running?.runId === runId && running.cancel) {
        try {
          void running.cancel()
        } catch (error) {
          console.warn('[scheduled-tasks] timed-out session cancellation failed:', error)
        }
      }
      settleFiring(task.id, runId, 'failed', 'timeout')
    }, MAX_RUN_MS)
  })
  const stored = updateStoredTask(task.id, (current) => {
    const entry: TaskRunEntry = {
      runId,
      status: 'preparing',
      startedAt,
      recovery: '正在启动运行时…'
    }
    current.runs = [entry, ...(current.runs ?? [])].slice(0, MAX_RUN_ENTRIES)
    current.lastRunAt = startedAt
    current.lastRunId = runId
    current.lastRunStatus = 'preparing'
    current.lastRunSessionId = undefined
    current.lastFailureReason = undefined
  })
  if (!stored) {
    releaseFiring(task.id)
    return null
  }
  return { runId, startedAt }
}

async function recordFailure(taskId: string, runId: string, reason: TaskFailureReason): Promise<void> {
  settleFiring(taskId, runId, 'failed', reason)
}

async function fireTask(task: ScheduledTask): Promise<string | null> {
  const firing = beginFiring(task)
  if (!firing) return null
  const { runId } = firing
  try {
    if (!spawnFn) {
      console.error('[scheduled-tasks] spawnFn not set; cannot fire task')
      await recordFailure(task.id, runId, 'engine-unavailable')
      return null
    }
    const result = await spawnFn(task.cwd, task.name, task.prompt, {
      taskId: task.id,
      runId,
      permissionMode: task.permissionMode,
      ...(task.skillId ? { skillId: task.skillId } : {})
    })
    if (!result) {
      await recordFailure(task.id, runId, 'spawn-failed')
      return null
    }
    const running = runningTasks.get(task.id)
    if (!running || running.runId !== runId) {
      // A timeout may have settled while spawnFn was still returning. Kill the
      // late session when the real spawner supplied a cancellation hook.
      await result.cancel?.()
      return null
    }
    if (running) {
      running.sessionId = result.sessionId
      running.cancel = result.cancel
      taskBySession.set(result.sessionId, task.id)
      taskRunBySession.set(result.sessionId, { taskId: task.id, runId })
    }
    updateRunEntry(task.id, runId, (run) => {
      run.status = 'running'
      run.sessionId = result.sessionId
      run.recovery = '会话运行中；结束事件会更新最终结果。'
    })
    updateStoredTask(task.id, (stored) => {
      stored.lastRunStatus = 'running'
      stored.lastRunSessionId = result.sessionId
      stored.lastRunId = runId
      stored.consecutiveFailures = 0
      stored.lastFailureReason = undefined
    })
    return result.sessionId
  } catch (error) {
    console.error(`[scheduled-tasks] failed to fire task ${task.id}:`, error)
    const message = error instanceof Error ? error.message : String(error)
    const reason: TaskFailureReason = message.startsWith('skill-unavailable')
      ? 'skill-unavailable'
      : message.startsWith('project-unavailable')
        ? 'project-unavailable'
        : 'threw'
    await recordFailure(task.id, runId, reason)
    return null
  }
}

/** Mark entries left open by a previous app process as interrupted. */
export function reconcileInterruptedTaskRuns(now = Date.now()): void {
  const tasks = getTasks()
  let changed = false
  for (const task of tasks) {
    for (const run of task.runs ?? []) {
      if (run.finishedAt !== undefined) continue
      run.finishedAt = now
      run.outcome = 'failed'
      run.status = 'interrupted'
      run.reason = 'interrupted'
      run.recovery = '应用已重启；请核对会话后手动重试。'
      if (task.lastRunId === run.runId) task.lastRunStatus = 'interrupted'
      changed = true
    }
  }
  if (changed) {
    saveTasks(tasks)
    broadcastTasksChanged()
  }
}

let firingChain: Promise<void> = Promise.resolve()

/**
 * Fire due tasks SEQUENTIALLY. A weekend offline can leave many tasks due at
 * once; spawning them all in the same tick would stampede the machine with
 * OMP processes. Serial dispatch also keeps failures attributable.
 */
function checkAndFireTasks(): void {
  let due: ScheduledTask[] = []
  try {
    const now = Date.now()
    due = getTasks().filter((task) => isDue(task, now))
  } catch (error) {
    console.error('[scheduled-tasks] tick failed:', error)
    return
  }
  if (due.length === 0) return
  firingChain = firingChain.then(async () => {
    // Re-read due state inside the chain: an earlier firing may have changed
    // anchors or disabled tasks.
    const now = Date.now()
    for (const task of getTasks()) {
      if (!isDue(task, now)) continue
      console.info(`[scheduled-tasks] firing "${task.name}" (${task.id})`)
      await fireTask(task)
    }
  })
}

let schedulerStarted = false

export function startScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  // A renderer/main reload cannot observe the old in-memory session registry.
  // Close any durable open rows before the first due-task check so history
  // never presents a run as permanently active.
  reconcileInterruptedTaskRuns()
  setTimeout(checkAndFireTasks, 10_000)
  setInterval(() => {
    try {
      checkAndFireTasks()
    } catch (error) {
      // The interval callback must never take the main process down.
      console.error('[scheduled-tasks] scheduler tick crashed:', error)
    }
  }, CHECK_INTERVAL_MS)
  console.info('[scheduled-tasks] scheduler started')
}

export type RunNowResult = 'ok' | 'running' | 'not-found' | 'failed'

export async function runTaskNow(id: string): Promise<RunNowResult> {
  const task = getTasks().find((t) => t.id === id)
  if (!task) return 'not-found'
  // Manual run respects the same no-overlap guard as scheduled firing.
  if (runningTasks.has(task.id)) return 'running'
  const sessionId = await fireTask(task)
  return sessionId !== null ? 'ok' : 'failed'
}
