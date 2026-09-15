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
  buildTaskFromAgentInput,
  isDue,
  isValidSchedule,
  MAX_RUN_ENTRIES,
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
  it('accepts the well-formed shapes', () => {
    expect(isValidSchedule({ type: 'daily', time: '09:30' })).toBe(true)
    expect(isValidSchedule({ type: 'weekly', dayOfWeek: 0, time: '23:59' })).toBe(true)
    expect(isValidSchedule({ type: 'weekdays', time: '09:00' })).toBe(true)
    expect(isValidSchedule({ type: 'interval', hours: 1 })).toBe(true)
    expect(isValidSchedule({ type: 'interval', minutes: 3 })).toBe(true)
  })

  it('rejects malformed shapes that used to become retry loops', () => {
    expect(isValidSchedule({ type: 'mystery' })).toBe(false)
    expect(isValidSchedule({ type: 'daily', time: '99:99' })).toBe(false)
    expect(isValidSchedule({ type: 'daily', time: '9:00' })).toBe(false)
    expect(isValidSchedule({ type: 'interval', hours: 0 })).toBe(false)
    expect(isValidSchedule({ type: 'interval', hours: 200 })).toBe(false)
    expect(isValidSchedule({ type: 'interval', hours: '24' })).toBe(false)
    expect(isValidSchedule({ type: 'interval', minutes: 0 })).toBe(false)
    expect(isValidSchedule({ type: 'interval', minutes: 3, hours: 1 })).toBe(false)
    expect(isValidSchedule({ type: 'interval' })).toBe(false)
    expect(isValidSchedule({ type: 'weekly', dayOfWeek: 7, time: '09:00' })).toBe(false)
    expect(isValidSchedule(null)).toBe(false)
  })
})

describe('nextRunAt for the newer schedule shapes', () => {
  // Friday 2026-09-11, 10:00 local.
  const friday = new Date(2026, 8, 11, 10, 0, 0, 0).getTime()

  it('weekdays rolls past the weekend to Monday', () => {
    const next = new Date(nextRunAt({ type: 'weekdays', time: '09:00' }, friday))
    expect(next.getDay()).toBe(1)
    expect(next.getDate()).toBe(14)
  })

  it('weekdays still fires later the same weekday', () => {
    const before = new Date(2026, 8, 11, 8, 0, 0, 0).getTime()
    const next = new Date(nextRunAt({ type: 'weekdays', time: '09:00' }, before))
    expect(next.getDay()).toBe(5)
    expect(next.getHours()).toBe(9)
  })

  it('minute intervals are honored (test-friendly cadence)', () => {
    expect(nextRunAt({ type: 'interval', minutes: 3 }, 1_000)).toBe(1_000 + 3 * 60_000)
  })
})

describe('buildTaskFromAgentInput', () => {
  const now = 1_757_000_000_000
  const validInput = {
    name: '每日报告',
    prompt: '拉取昨日数据',
    schedule: { type: 'daily', time: '09:00' }
  }

  it('binds cwd from the session and starts enabled', () => {
    const built = buildTaskFromAgentInput(validInput, '/tmp/project', now)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.task.cwd).toBe('/tmp/project')
    expect(built.task.enabled).toBe(true)
    expect(built.task.id).toMatch(/^task-/)
    expect(built.task.notifyChannel).toBeUndefined()
  })

  it('keeps optional notify and permission choices', () => {
    const built = buildTaskFromAgentInput(
      { ...validInput, notifyChannel: 'feishu', permissionMode: 'readonly', notifyOnComplete: false },
      '/tmp/project',
      now
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.task.notifyChannel).toBe('feishu')
    expect(built.task.permissionMode).toBe('readonly')
    expect(built.task.notifyOnComplete).toBe(false)
  })

  it('rejects bad names, prompts, schedules, and channels', () => {
    expect(buildTaskFromAgentInput({ ...validInput, name: '   ' }, '/p', now).ok).toBe(false)
    expect(buildTaskFromAgentInput({ ...validInput, prompt: '' }, '/p', now).ok).toBe(false)
    expect(buildTaskFromAgentInput({ ...validInput, name: 'x'.repeat(81) }, '/p', now).ok).toBe(false)
    expect(buildTaskFromAgentInput({ ...validInput, prompt: 'x'.repeat(4001) }, '/p', now).ok).toBe(false)
    expect(buildTaskFromAgentInput({ ...validInput, schedule: { type: 'nope' } }, '/p', now).ok).toBe(false)
    expect(buildTaskFromAgentInput({ ...validInput, notifyChannel: 'sms' }, '/p', now).ok).toBe(false)
    expect(buildTaskFromAgentInput(null, '/p', now).ok).toBe(false)
  })

  it('enforces the task cap so an agent loop cannot flood the store', () => {
    tasks = Array.from({ length: 50 }, (_, i) => baseTask({ id: `t${i}` }))
    const built = buildTaskFromAgentInput(validInput, '/p', now)
    expect(built.ok).toBe(false)
    tasks = []
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
    setTaskOutcomeSink(({ kind }) => outcomes.push(kind))

    await runTaskNow('t1')
    noteTaskSessionEvent('session-B', { type: 'status', status: 'idle' })
    noteTaskSessionEvent('session-B', { type: 'closed' })
    expect(outcomes).toEqual(['finished'])
  })

  it('a silent task (notifyOnComplete=false) gets no completion notice', async () => {
    tasks.push(baseTask({ notifyOnComplete: false }))
    setTaskSpawnFn(async () => ({ sessionId: 'session-B2' }))
    const outcomes: string[] = []
    setTaskOutcomeSink(({ kind }) => outcomes.push(kind))

    await runTaskNow('t1')
    noteTaskSessionEvent('session-B2', { type: 'status', status: 'idle' })
    expect(outcomes).toEqual([])
  })

  it('three consecutive failures auto-disable the task and notify loudly', async () => {
    vi.useFakeTimers()
    try {
      const task = baseTask()
      tasks.push(task)
      setTaskSpawnFn(async () => null)
      const outcomes: Array<[string, string]> = []
      setTaskOutcomeSink(({ kind, task }) => outcomes.push([kind, task.name]))

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

  it('the disabled notice still carries the task', async () => {
    vi.useFakeTimers()
    try {
      const task = baseTask()
      tasks.push(task)
      setTaskSpawnFn(async () => null)
      const disabled: ScheduledTask[] = []
      setTaskOutcomeSink(({ kind, task }) => {
        if (kind === 'disabled') disabled.push(task)
      })
      for (let attempt = 1; attempt <= 3; attempt++) {
        await runTaskNow('t1')
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 1000)
      }
      expect(disabled).toHaveLength(1)
      expect(disabled[0].id).toBe('t1')
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
    const task = baseTask({ permissionMode: 'readonly', skillId: '爆款竞品分析.md' })
    tasks.push(task)
    const calls: Array<{ cwd: string; title: string; prompt: string; opts?: { taskId: string; permissionMode?: string; skillId?: string } }> = []
    setTaskSpawnFn(async (cwd, title, prompt, opts) => {
      calls.push({ cwd, title, prompt, opts })
      return { sessionId: 'session-C' }
    })

    await runTaskNow('t1')
    expect(calls).toEqual([
      { cwd: '/tmp/project', title: '每日报告', prompt: '拉取昨日数据并总结', opts: { taskId: 't1', permissionMode: 'readonly', skillId: '爆款竞品分析.md' } }
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
    setTaskOutcomeSink(({ kind, task, sessionId }) => outcomes.push([kind, task.name, sessionId]))

    await runTaskNow('t1')
    noteTaskSessionEvent('session-D', { type: 'status', status: 'idle' })
    expect(outcomes).toEqual([['finished', '每日报告', 'session-D']])
  })
})

describe('run ledger', () => {
  it('a finished run lands in the ledger as success with a duration', async () => {
    tasks.push(baseTask())
    setTaskSpawnFn(async () => ({ sessionId: 'run-1' }))

    await runTaskNow('t1')
    noteTaskSessionEvent('run-1', { type: 'status', status: 'idle' })

    expect(tasks[0].runs).toHaveLength(1)
    const run = tasks[0].runs![0]
    expect(run.sessionId).toBe('run-1')
    expect(run.outcome).toBe('success')
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt)
  })

  it('a mid-run fatal error flips the entry to failed with a reason', async () => {
    tasks.push(baseTask())
    setTaskSpawnFn(async () => ({ sessionId: 'run-2' }))

    await runTaskNow('t1')
    noteTaskSessionEvent('run-2', { type: 'error', recoverable: false })

    expect(tasks[0].runs).toHaveLength(1)
    expect(tasks[0].runs![0].outcome).toBe('failed')
    expect(tasks[0].runs![0].reason).toBe('run-error')
  })

  it('a spawn failure records a failed entry without a session', async () => {
    tasks.push(baseTask())
    setTaskSpawnFn(async () => null)

    await runTaskNow('t1')
    expect(tasks[0].runs).toHaveLength(1)
    expect(tasks[0].runs![0].outcome).toBe('failed')
    expect(tasks[0].runs![0].reason).toBe('spawn-failed')
    expect(tasks[0].runs![0].sessionId).toBeUndefined()
  })

  it('an edit (saveTask) keeps the ledger', async () => {
    tasks.push(baseTask())
    setTaskSpawnFn(async () => ({ sessionId: 'run-3' }))
    await runTaskNow('t1')
    noteTaskSessionEvent('run-3', { type: 'status', status: 'idle' })

    saveTask(baseTask({ name: '改名', prompt: '新提示词' }))
    expect(tasks[0].runs).toHaveLength(1)
    expect(tasks[0].runs![0].sessionId).toBe('run-3')
  })

  it('the ledger is capped at the newest entries', async () => {
    tasks.push(baseTask())
    for (let i = 0; i < MAX_RUN_ENTRIES + 4; i++) {
      const sessionId = `run-cap-${i}`
      setTaskSpawnFn(async () => ({ sessionId }))
      await runTaskNow('t1')
      noteTaskSessionEvent(sessionId, { type: 'status', status: 'idle' })
    }
    expect(tasks[0].runs).toHaveLength(MAX_RUN_ENTRIES)
    // Newest first: the last fired session is at the front.
    expect(tasks[0].runs![0].sessionId).toBe(`run-cap-${MAX_RUN_ENTRIES + 3}`)
  })
})
