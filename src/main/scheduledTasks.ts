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
 * lets the existing notification system handle completion.
 *
 * Tasks only fire while the app is running. A task never fires while a
 * previous firing of the SAME task is still running (per-task guard).
 *
 * `spawnFn` is injected (instead of imported from omp/) so this module has no
 * static dependency on the OMP runtime — tests can stub it and the import
 * chain stays acyclic.
 */

const CHECK_INTERVAL_MS = 60_000

export interface TaskSpawnResult {
  sessionId: string
}

export type TaskSpawnFn = (
  cwd: string,
  title: string,
  prompt: string
) => Promise<TaskSpawnResult | null>

let spawnFn: TaskSpawnFn | null = null
const runningTaskIds = new Set<string>()

export function setTaskSpawnFn(fn: TaskSpawnFn): void {
  spawnFn = fn
}

function getTasks(): ScheduledTask[] {
  return getStore('scheduledTasks') ?? []
}

function saveTasks(tasks: ScheduledTask[]): void {
  setStore('scheduledTasks', tasks)
}

export function listTasks(): ScheduledTask[] {
  return getTasks()
}

export function saveTask(task: ScheduledTask): ScheduledTask {
  const tasks = getTasks()
  const index = tasks.findIndex((t) => t.id === task.id)
  if (index >= 0) tasks[index] = task
  else tasks.push(task)
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
  saveTasks(tasks)
  broadcastTasksChanged()
  return task
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
  return after
}

/** True when a task should fire now. */
export function isDue(task: ScheduledTask, now: number): boolean {
  if (!task.enabled) return false
  if (runningTaskIds.has(task.id)) return false
  const anchor = task.lastRunAt ?? task.createdAt
  return nextRunAt(task.schedule, anchor) <= now
}

function broadcastTasksChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.TASKS_STATE_CHANGED, getTasks())
    }
  }
}

async function fireTask(task: ScheduledTask): Promise<string | null> {
  runningTaskIds.add(task.id)
  try {
    if (!spawnFn) {
      console.warn('[scheduled-tasks] spawnFn not set; cannot fire task')
      return null
    }
    const result = await spawnFn(task.cwd, task.name, task.prompt)
    if (!result) return null

    const tasks = getTasks()
    const stored = tasks.find((t) => t.id === task.id)
    if (stored) {
      stored.lastRunAt = Date.now()
      saveTasks(tasks)
    }
    broadcastTasksChanged()
    return result.sessionId
  } catch (error) {
    console.error(`[scheduled-tasks] failed to fire task ${task.id}:`, error)
    return null
  } finally {
    // Generous cleanup: one agent turn can take 10+ minutes.
    setTimeout(() => runningTaskIds.delete(task.id), 30 * 60 * 1000)
  }
}

function checkAndFireTasks(): void {
  const now = Date.now()
  for (const task of getTasks()) {
    if (isDue(task, now)) {
      console.info(`[scheduled-tasks] firing "${task.name}" (${task.id})`)
      void fireTask(task)
    }
  }
}

let schedulerStarted = false

export function startScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  setTimeout(checkAndFireTasks, 10_000)
  setInterval(checkAndFireTasks, CHECK_INTERVAL_MS)
  console.info('[scheduled-tasks] scheduler started')
}

export async function runTaskNow(id: string): Promise<boolean> {
  const task = getTasks().find((t) => t.id === id)
  if (!task) return false
  const sessionId = await fireTask(task)
  return sessionId !== null
}
