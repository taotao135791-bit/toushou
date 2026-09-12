import { BrowserWindow } from 'electron'
import { getStore, setStore } from './store'
import { ScheduledTask, TaskSchedule } from '../shared/types'
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
const MAX_RUN_MS = 6 * 60 * 60 * 1000
/** Consecutive spawn failures before a task disables itself. */
const MAX_CONSECUTIVE_FAILURES = 3

export interface TaskSpawnResult {
  sessionId: string
}

/** Task-level options handed to the spawn implementation. */
export interface TaskSpawnOptions {
  taskId: string
  /** 'readonly' opts the unattended session down from the global mode. */
  permissionMode?: 'default' | 'readonly'
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
  sessionId: string
  fallbackTimer: ReturnType<typeof setTimeout>
}
const runningTasks = new Map<string, RunningFiring>()
/** sessionId → taskId once a firing's session exists. */
const taskBySession = new Map<string, string>()

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
const RUNTIME_OWNED_KEYS = ['lastRunAt', 'lastRunSessionId', 'consecutiveFailures', 'lastFailureReason'] as const

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

/** Structural validation for a schedule coming over IPC. */
export function isValidSchedule(value: unknown): value is TaskSchedule {
  if (!value || typeof value !== 'object') return false
  const schedule = value as Record<string, unknown>
  if (schedule.type === 'daily' || schedule.type === 'weekly') {
    if (typeof schedule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return false
    if (schedule.type === 'weekly') {
      if (typeof schedule.dayOfWeek !== 'number' || !Number.isInteger(schedule.dayOfWeek)) return false
      if (schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6) return false
    }
    return true
  }
  if (schedule.type === 'interval') {
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
  if (schedule.type === 'interval') {
    return after + schedule.hours * 3_600_000
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

/** Completion/failure notice sink — wired by ipc.ts to desktop notifications. */
let onTaskOutcome: ((kind: 'finished' | 'failed' | 'disabled', taskName: string, sessionId?: string) => void) | null = null

export function setTaskOutcomeSink(
  sink: (kind: 'finished' | 'failed' | 'disabled', taskName: string, sessionId?: string) => void
): void {
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
}

function releaseFiring(taskId: string): void {
  const running = runningTasks.get(taskId)
  if (!running) return
  clearTimeout(running.fallbackTimer)
  runningTasks.delete(taskId)
  taskBySession.delete(running.sessionId)
}

/**
 * Feed session events for task-spawned sessions. The session's terminal
 * state (idle after a turn, fatal error, or process exit) releases the
 * per-task guard so a long-running turn can never overlap itself, and fires
 * the task-scoped completion notice when the task asks for one.
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
  if (!terminal) return
  releaseFiring(taskId)
  const task = getTasks().find((t) => t.id === taskId)
  if (task && event.type === 'status' && task.notifyOnComplete !== false) {
    onTaskOutcome?.('finished', task.name, sessionId)
  }
}

async function fireTask(task: ScheduledTask): Promise<string | null> {
  runningTasks.set(task.id, {
    sessionId: '',
    fallbackTimer: setTimeout(() => {
      // Events lost (runtime killed without a closed event): release anyway
      // so the task is not wedged until the next app restart.
      const running = runningTasks.get(task.id)
      if (running) {
        if (running.sessionId) taskBySession.delete(running.sessionId)
        runningTasks.delete(task.id)
      }
    }, MAX_RUN_MS)
  })
  try {
    if (!spawnFn) {
      console.error('[scheduled-tasks] spawnFn not set; cannot fire task')
      await recordFailure(task, 'engine-unavailable')
      return null
    }
    const result = await spawnFn(task.cwd, task.name, task.prompt, {
      taskId: task.id,
      permissionMode: task.permissionMode
    })
    if (!result) {
      await recordFailure(task, 'spawn-failed')
      return null
    }
    const running = runningTasks.get(task.id)
    if (running) {
      running.sessionId = result.sessionId
      taskBySession.set(result.sessionId, task.id)
    }
    const tasks = getTasks()
    const stored = tasks.find((t) => t.id === task.id)
    if (stored) {
      stored.lastRunAt = Date.now()
      stored.lastRunSessionId = result.sessionId
      stored.consecutiveFailures = 0
      saveTasks(tasks)
    }
    broadcastTasksChanged()
    return result.sessionId
  } catch (error) {
    console.error(`[scheduled-tasks] failed to fire task ${task.id}:`, error)
    await recordFailure(task, 'threw')
    return null
  }
}

/** Count a firing failure; three in a row auto-disables the task loudly. */
async function recordFailure(task: ScheduledTask, reason: string): Promise<void> {
  const tasks = getTasks()
  const stored = tasks.find((t) => t.id === task.id)
  if (!stored) return
  stored.consecutiveFailures = (stored.consecutiveFailures ?? 0) + 1
  stored.lastFailureReason = reason
  let disabled = false
  if (stored.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && stored.enabled) {
    stored.enabled = false
    disabled = true
  }
  saveTasks(tasks)
  broadcastTasksChanged()
  if (disabled) onTaskOutcome?.('disabled', stored.name)
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
