import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// scheduledTasks touches electron (BrowserWindow broadcasts) and the settings
// store — keep this suite Electron-free with targeted mocks.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../store', () => ({
  getStore: vi.fn(() => tasksFixture()),
  setStore: vi.fn()
}))

import { ScheduledTask } from '../../shared/types'
import {
  isDue,
  isValidSchedule,
  nextRunAt,
  noteTaskSessionEvent,
  runTaskNow,
  saveTask,
  setTaskSpawnFn,
  setTaskOutcomeSink,
  setTaskOutcomeSinkResetForTest,
  resetRunningGuardsForTest,
  startScheduler
} from '../scheduledTasks'

const { getStore, setStore } = await import('../store')

let tasks: ScheduledTask[] = []
function tasksFixture(): ScheduledTask[] {
  return tasks
}

function baseTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't1',
    name: '每日报告',
    prompt: '拉取昨日数据并总结',
    cwd: '/tmp/project',
    schedule: { type: 'daily', time: '09:00' },
    enabled: true,
    createdAt: Date.now() - 24 * 3600_000,
    notifyOnComplete: true,
    ...overrides
  }
}

beforeEach(() => {
  tasks = []
  vi.mocked(getStore).mockImplementation(() => tasks as ScheduledTask[])
  vi.mocked(setStore).mockImplementation((key, value) => {
    if (key === 'scheduledTasks') tasks = value as ScheduledTask[]
  })
  setTaskOutcomeSinkResetForTest()
  resetRunningGuardsForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isValidSchedule', () => {
  it('accepts the three well-formed shapes', () => {
    expect(isValidSchedule({ type: 'daily', time: '09:30' })).toBe(true)
    expect(isValidSchedule({ type: 'weekly', dayOfWeek: 0, time: '23:59' })).toBe(true)
    expect(isValidSchedule({ type: 'interval', hours: 1 })).toBe(true)
  })

  it('rejects malformed shapes that used to become retry loops', () => {
    expect(isValidSchedule({ type: 'mystery' })).toBe(false)
    expect(isValidSchedule({ type: 'daily', time: '99:99' })).toBe(false)
    expect(isValidSchedule({ type: 'daily', time: '9:00' })).toBe(false)
    expect(isValidSchedule({ type: 'interval', hours: 0 })).toBe(false)
    expect(isValidSchedule({ type: 'interval', hours: 200 })).toBe(false)
    expect(isValidSchedule({ type: 'interval', hours: '24' })).toBe(false)
    expect(isValidSchedule({ type: 'weekly', dayOfWeek: 7, time: '09:00' })).toBe(false)
    expect(isValidSchedule(null)).toBe(false)
  })
})

describe('nextRunAt / isDue with malformed schedules', () => {
  it('unknown schedule types are never due (no 30-minute firing loop)', () => {
    // A malformed legacy shape straight from a hand-edited store.
    const task = baseTask({ schedule: { type: 'legacy-thing' } as unknown as ScheduledTask['schedule'] })
    expect(Number.isFinite(nextRunAt(task.schedule, Date.now()))).toBe(false)
    expect(isDue(task, Date.now())).toBe(false)
  })

  it('a NaN-producing time never fires', () => {
    const task = baseTask({ schedule: { type: 'daily', time: 'nope' } as ScheduledTask['schedule'] })
    expect(isDue(task, Date.now())).toBe(false)
  })
})

describe('firing lifecycle', () => {
  it('a successful firing records the session and the guard holds until the session ends', async () => {
    const task = baseTask()
    tasks.push(task)
    setTaskSpawnFn(async () => ({ sessionId: 'session-A' }))

    const result = await runTaskNow('t1')
    expect(result).toBe('ok')

    // Manual re-run while the turn is still open is refused.
    await expect(runTaskNow('t1')).resolves.toBe('running')

    // The session's terminal event releases the guard.
    noteTaskSessionEvent('session-A', { type: 'status', status: 'idle', isTerminal: true })
    await expect(runTaskNow('t1')).resolves.toBe('ok')
  })

  it('fires the completion notice once when the task asks for it', async () => {
    const task = baseTask()
    tasks.push(task)
    setTaskSpawnFn(async () => ({ sessionId: 'session-B' }))
    const outcomes: string[] = []
    setTaskOutcomeSink((kind) => outcomes.push(kind))

    await runTaskNow('t1')
    noteTaskSessionEvent('session-B', { type: 'status', status: 'idle' })
    noteTaskSessionEvent('session-B', { type: 'closed' })
    expect(outcomes).toEqual(['finished'])
  })

  it('three consecutive failures auto-disable the task and notify loudly', async () => {
    vi.useFakeTimers()
    try {
      const task = baseTask()
      tasks.push(task)
      setTaskSpawnFn(async () => null)
      const outcomes: Array<[string, string]> = []
      setTaskOutcomeSink((kind, name) => outcomes.push([kind, name]))

      for (let attempt = 1; attempt <= 3; attempt++) {
        await runTaskNow('t1')
        // Advance past the 6h fallback so the guard frees for the next try.
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 1000)
        const stored = tasks[0]
        expect(stored.consecutiveFailures).toBe(attempt)
        expect(stored.enabled).toBe(attempt < 3)
      }
      expect(outcomes).toContainEqual(['disabled', '每日报告'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-enabling clears the failure slate', () => {
    const task = baseTask({ enabled: false, consecutiveFailures: 2 })
    tasks.push(task)
    // toggleTask is imported lazily to keep the top import list stable.
    return import('../scheduledTasks').then(({ toggleTask }) => {
      const updated = toggleTask('t1', true)
      expect(updated?.enabled).toBe(true)
      expect(updated?.consecutiveFailures).toBe(0)
    })
  })

  it('runTaskNow reports unknown tasks', async () => {
    await expect(runTaskNow('missing')).resolves.toBe('not-found')
  })
})

describe('scheduler tick safety', () => {
  it('a non-array scheduledTasks value does not throw', () => {
    vi.mocked(getStore).mockImplementation(() => ({ oops: true }) as never)
    expect(() => startScheduler()).not.toThrow()
  })

  it('saveTask round-trips through the mocked store', () => {
    const task = baseTask({ id: 't2' })
    const saved = saveTask(task)
    expect(saved.id).toBe('t2')
    expect(tasks).toHaveLength(1)
  })
})

describe('edit-and-ledger loop closures', () => {
  it('a firing hands the task options to the spawn fn and records the run session', async () => {
    const task = baseTask({ permissionMode: 'readonly' })
    tasks.push(task)
    const calls: Array<{ cwd: string; title: string; prompt: string; opts?: { taskId: string; permissionMode?: string } }> = []
    setTaskSpawnFn(async (cwd, title, prompt, opts) => {
      calls.push({ cwd, title, prompt, opts })
      return { sessionId: 'session-C' }
    })

    await runTaskNow('t1')
    expect(calls).toEqual([
      { cwd: '/tmp/project', title: '每日报告', prompt: '拉取昨日数据并总结', opts: { taskId: 't1', permissionMode: 'readonly' } }
    ])
    expect(tasks[0].lastRunSessionId).toBe('session-C')
    expect(tasks[0].consecutiveFailures).toBe(0)
  })

  it('an edit (saveTask with the same id) keeps the engine-owned run ledger', () => {
    tasks.push(baseTask({ lastRunAt: 123, lastRunSessionId: 'session-X', consecutiveFailures: 2, lastFailureReason: 'threw' }))
    // The renderer edit flow sends a fresh task object without those fields.
    saveTask(baseTask({ name: '改名后的任务', prompt: '新的提示词' }))
    expect(tasks).toHaveLength(1)
    expect(tasks[0].name).toBe('改名后的任务')
    expect(tasks[0].prompt).toBe('新的提示词')
    expect(tasks[0].lastRunAt).toBe(123)
    expect(tasks[0].lastRunSessionId).toBe('session-X')
    expect(tasks[0].consecutiveFailures).toBe(2)
    expect(tasks[0].lastFailureReason).toBe('threw')
  })

  it('the completion notice carries the run session id for click-through', async () => {
    tasks.push(baseTask())
    setTaskSpawnFn(async () => ({ sessionId: 'session-D' }))
    const outcomes: Array<[string, string, string | undefined]> = []
    setTaskOutcomeSink((kind, name, sessionId) => outcomes.push([kind, name, sessionId]))

    await runTaskNow('t1')
    noteTaskSessionEvent('session-D', { type: 'status', status: 'idle' })
    expect(outcomes).toEqual([['finished', '每日报告', 'session-D']])
  })
})
