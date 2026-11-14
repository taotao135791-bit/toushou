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
  noteTaskSessionFile,
  runTaskNow,
  saveTask,
  toggleTask,
  deleteTask,
  setTaskSpawnFn,
  setTaskOutcomeSink,
  setTaskOutcomeSinkResetForTest,
  resetRunningGuardsForTest,
  setTaskReuseSessionFile,
  validateTaskSaveInput,
  resetTaskSessionReuse,
  startScheduler,
  stopSchedulerForTest,
  reconcileInterruptedTaskRuns,
  beginTaskDelivery,
  finishTaskDelivery
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
  stopSchedulerForTest()
})

afterEach(() => {
  stopSchedulerForTest()
  vi.useRealTimers()
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

  it('manual re-enable clears the failure count and reason', () => {
    const task = baseTask({ enabled: false, consecutiveFailures: 2, lastFailureReason: 'run-error' })
    tasks.push(task)
    // toggleTask is imported lazily to keep the top import list stable.
    return import('../scheduledTasks').then(({ toggleTask }) => {
      const updated = toggleTask('t1', true)
      expect(updated?.enabled).toBe(true)
      expect(updated?.consecutiveFailures).toBe(0)
      expect(updated?.lastFailureReason).toBeUndefined()
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

describe('scheduler cadence', () => {
  it('runs short interval tasks at their deadline', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-11-03T10:00:00')
    vi.setSystemTime(start)
    const fired: string[] = []
    setTaskSpawnFn(async (_cwd, title) => {
      fired.push(title)
      return { sessionId: 'sess-tick' }
    })
    tasks.push(baseTask({ schedule: { type: 'interval', minutes: 2 }, createdAt: start.getTime() }))
    startScheduler()
    // Startup pass at +10s: the task is due at +2min.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fired).toHaveLength(0)
    // At +1min the task is not due; at +2min it fires.
    await vi.advanceTimersByTimeAsync(50_000)
    expect(fired).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fired).toHaveLength(1)
  })
  it('stops the startup catch-up pass along with the ticker', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-11-03T10:00:00')
    vi.setSystemTime(start)
    const fired: string[] = []
    setTaskSpawnFn(async (_cwd, title) => {
      fired.push(title)
      return { sessionId: 'sess-stop' }
    })
    // Already due: only a surviving 10s startup timer could fire it.
    tasks.push(baseTask({ schedule: { type: 'interval', minutes: 60 }, createdAt: start.getTime() - 2 * 3600_000 }))
    startScheduler()
    stopSchedulerForTest()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fired).toHaveLength(0)
  })
})

describe('deadline-driven scheduling regressions', () => {
  it('runs a daily task at 09:00 after an 08:50 app start', async () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 3, 8, 50).getTime()
    vi.setSystemTime(start)
    const fired: number[] = []
    setTaskSpawnFn(async () => { fired.push(Date.now()); return { sessionId: 'daily-session' } })
    tasks.push(baseTask({ createdAt: start - 50 * 60_000 }))
    startScheduler()
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    expect(fired).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toEqual([new Date(2026, 10, 3, 9, 0).getTime()])
  })

  it('does not postpone an existing deadline when an unrelated task is edited or deleted', async () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 3, 8, 50).getTime()
    vi.setSystemTime(start)
    const fired: number[] = []
    setTaskSpawnFn(async () => { fired.push(Date.now()); return { sessionId: 'daily-session' } })
    const daily = baseTask({ createdAt: start - 50 * 60_000 })
    const other = baseTask({ id: 'other', enabled: false, createdAt: start })
    tasks.push(daily, other)
    startScheduler()
    await vi.advanceTimersByTimeAsync(8 * 60_000)
    saveTask({ ...other, name: 'synthetic edit' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deleteTask('other')).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fired).toEqual([new Date(2026, 10, 3, 9, 0).getTime()])
  })

  it('recomputes deadlines when a task is added and its schedule is edited', async () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 3, 10, 0).getTime()
    vi.setSystemTime(start)
    const fired: number[] = []
    setTaskSpawnFn(async () => { fired.push(Date.now()); return { sessionId: 'edited-session' } })
    startScheduler()
    await vi.advanceTimersByTimeAsync(10_000)
    const createdAt = Date.now()
    const task = baseTask({ createdAt, schedule: { type: 'interval', minutes: 1 } })
    saveTask(task)
    await vi.advanceTimersByTimeAsync(30_000)
    saveTask({ ...task, schedule: { type: 'interval', minutes: 2 } })
    await vi.advanceTimersByTimeAsync(89_999)
    expect(fired).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toEqual([createdAt + 2 * 60_000])
  })

  it('runs an enabled overdue task immediately and respects a later pause', async () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 3, 9, 5).getTime()
    vi.setSystemTime(start)
    const fired: string[] = []
    setTaskSpawnFn(async () => { fired.push('run'); return { sessionId: 'overdue-session' } })
    tasks.push(baseTask({ enabled: false, createdAt: start - 65 * 60_000 }))
    startScheduler()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fired).toHaveLength(0)
    toggleTask('t1', true)
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toHaveLength(1)
    toggleTask('t1', false)
    noteTaskSessionEvent('overdue-session', { type: 'status', status: 'idle' })
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(fired).toHaveLength(1)
  })

  it('catches up after startup, without firing before the ten-second grace period', async () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 3, 10, 0).getTime()
    vi.setSystemTime(start)
    const fired: number[] = []
    setTaskSpawnFn(async () => { fired.push(Date.now()); return { sessionId: 'catchup-session' } })
    tasks.push(baseTask({ createdAt: start - 2 * 60 * 60_000 }))
    startScheduler()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fired).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toEqual([start + 10_000])
  })

  it('runs short intervals on time without overlapping and catches up after the active run ends', async () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 3, 10, 0).getTime()
    vi.setSystemTime(start)
    const fired: number[] = []
    setTaskSpawnFn(async () => { fired.push(Date.now()); return { sessionId: `interval-${fired.length}` } })
    tasks.push(baseTask({ createdAt: start, schedule: { type: 'interval', minutes: 1 } }))
    startScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fired).toEqual([start + 60_000])
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(fired).toHaveLength(1)
    noteTaskSessionEvent('interval-1', { type: 'status', status: 'idle' })
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toEqual([start + 60_000, start + 4 * 60_000])
  })

  it('ignores malformed task schedules without preventing valid tasks or startup', async () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 3, 8, 50).getTime()
    vi.setSystemTime(start)
    const fired: string[] = []
    setTaskSpawnFn(async (_cwd, title) => { fired.push(title); return { sessionId: 'valid-session' } })
    tasks.push(baseTask({ id: 'bad', schedule: null as never }), baseTask({ id: 'good', name: 'valid', createdAt: start - 50 * 60_000 }))
    expect(() => startScheduler()).not.toThrow()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fired).toEqual(['valid'])
    expect(tasks.find(task => task.id === 'bad')?.schedule).toBeNull()
  })

  it('does not fire a task paused while an earlier due task is spawning', async () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 3, 10, 0).getTime()
    vi.setSystemTime(start)
    // The persisted store returns snapshots; mutations of a later read must
    // not retroactively change the dispatcher's earlier array.
    vi.mocked(getStore).mockImplementation(() => structuredClone(tasks) as ScheduledTask[])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fired: string[] = []
    setTaskSpawnFn(async (_cwd, title) => { fired.push(title); if (title === 'first') await gate; return { sessionId: title } })
    tasks.push(baseTask({ id: 'first', name: 'first', createdAt: start - 2 * 60 * 60_000 }), baseTask({ id: 'second', name: 'second', createdAt: start - 2 * 60 * 60_000 }))
    startScheduler()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fired).toEqual(['first'])
    expect(toggleTask('second', false)?.enabled).toBe(false)
    release()
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toEqual(['first'])
    expect(tasks.find(task => task.id === 'second')?.enabled).toBe(false)
  })

  it('does not enqueue repeated overdue checks while a session is spawning', async () => {
    vi.useFakeTimers()
    const start = new Date(2026, 10, 3, 10, 0).getTime()
    vi.setSystemTime(start)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fired: string[] = []
    setTaskSpawnFn(async (_cwd, title) => { fired.push(title); if (title === 'first') await gate; return { sessionId: title } })
    tasks.push(baseTask({ id: 'first', name: 'first', createdAt: start - 2 * 60 * 60_000 }), baseTask({ id: 'second', name: 'second', createdAt: start - 2 * 60 * 60_000 }))
    startScheduler()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fired).toEqual(['first'])
    for (let i = 0; i < 10; i++) saveTask(baseTask({ id: 'inactive', enabled: false, name: `edit-${i}` }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fired).toEqual(['first'])
    release()
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toEqual(['first', 'second'])
  })
})

describe('task session reuse', () => {
  it('passes the pinned transcript to the spawn fn and re-pins the forked file', async () => {
    tasks.push(baseTask({ reuseSession: true, reuseSessionFile: '/sessions/first.jsonl' }))
    const optsSeen: Array<{ resumeSessionFile?: string; runId?: string; reuseGeneration?: string } | undefined> = []
    setTaskSpawnFn(async (_cwd, _title, _prompt, opts) => {
      optsSeen.push(opts)
      return { sessionId: 'sess-reuse' }
    })
    await runTaskNow('t1')
    expect(optsSeen[0]?.resumeSessionFile).toBe('/sessions/first.jsonl')
    // The 'connected' handshake re-pins the forked file through the bridge.
    setTaskReuseSessionFile('t1', '/sessions/second.jsonl', { runId: optsSeen[0]!.runId!, generation: optsSeen[0]!.reuseGeneration!, cwd: '/tmp/project' })
    expect(tasks[0].reuseSessionFile).toBe('/sessions/second.jsonl')
  })

  it('resetTaskSessionReuse clears the mode and the pin; the next firing opens fresh', async () => {
    tasks.push(baseTask({ reuseSession: true, reuseSessionFile: '/sessions/first.jsonl' }))
    expect(resetTaskSessionReuse('t1')?.reuseSession).toBe(false)
    expect(tasks[0].reuseSessionFile).toBeUndefined()
    const optsSeen: Array<{ resumeSessionFile?: string } | undefined> = []
    setTaskSpawnFn(async (_cwd, _title, _prompt, opts) => {
      optsSeen.push(opts)
      return { sessionId: 'sess-fresh' }
    })
    await runTaskNow('t1')
    expect(optsSeen[0]?.resumeSessionFile).toBeUndefined()
  })

  it('a failed resume drops the stale pin so the next firing can start fresh', async () => {
    tasks.push(baseTask({ reuseSession: true, reuseSessionFile: '/sessions/deleted.jsonl' }))
    setTaskSpawnFn(async () => null)
    await runTaskNow('t1')
    expect(tasks[0].reuseSession).toBe(true)
    expect(tasks[0].reuseSessionFile).toBeUndefined()
  })

  it('an edit that omits reuse fields does not silently flip the mode', () => {
    tasks.push(baseTask({ reuseSession: true, reuseSessionFile: '/s/first.jsonl' }))
    const edited = baseTask({ name: 'renamed' })
    const saved = saveTask(edited)
    expect(saved.reuseSession).toBe(true)
    expect(saved.reuseSessionFile).toBe('/s/first.jsonl')
  })

  it('honors explicit false at the IPC validator and keeps the run ledger', () => {
    tasks.push(baseTask({ reuseSession: true, reuseSessionFile: '/sessions/first.jsonl', lastRunId: 'previous-run', lastRunStatus: 'completed' }))
    const input = validateTaskSaveInput({ ...baseTask(), reuseSession: false })
    expect(input.ok).toBe(true)
    if (!input.ok) return
    const saved = saveTask(input.task)
    expect(saved).toMatchObject({ reuseSession: false, lastRunId: 'previous-run', lastRunStatus: 'completed' })
    expect(saved.reuseSessionFile).toBeUndefined()
    expect(validateTaskSaveInput({ ...baseTask(), reuseSession: 'false' })).toEqual({ ok: false, error: 'invalid-reuse-session' })
  })

  it('clears a pin when the task changes project while preserving its ledger', async () => {
    tasks.push(baseTask({ reuseSession: true, reuseSessionFile: '/sessions/project-a.jsonl', lastRunId: 'old-run' }))
    const saved = saveTask(baseTask({ cwd: '/tmp/another-project', reuseSession: true }))
    expect(saved.lastRunId).toBe('old-run')
    expect(saved.reuseSessionFile).toBeUndefined()
    let resume: string | undefined
    setTaskSpawnFn(async (_cwd, _title, _prompt, opts) => { resume = opts?.resumeSessionFile; return { sessionId: 'fresh' } })
    await runTaskNow('t1')
    expect(resume).toBeUndefined()
  })

  it('ignores an old handshake after reset and re-enable', async () => {
    tasks.push(baseTask({ reuseSession: true }))
    let old: { runId: string; generation: string; cwd: string } | undefined
    setTaskSpawnFn(async (cwd, _title, _prompt, opts) => { old = { runId: opts!.runId!, generation: opts!.reuseGeneration!, cwd }; return { sessionId: 'old-session' } })
    await runTaskNow('t1')
    resetTaskSessionReuse('t1')
    saveTask(baseTask({ reuseSession: true }))
    setTaskReuseSessionFile('t1', '/sessions/old.jsonl', old!)
    expect(tasks[0].reuseSessionFile).toBeUndefined()
  })

  it('ignores an old handshake after a task changes project', async () => {
    tasks.push(baseTask({ reuseSession: true }))
    let old: { runId: string; generation: string; cwd: string } | undefined
    setTaskSpawnFn(async (cwd, _title, _prompt, opts) => { old = { runId: opts!.runId!, generation: opts!.reuseGeneration!, cwd }; return { sessionId: 'old-session' } })
    await runTaskNow('t1')
    saveTask(baseTask({ cwd: '/tmp/other-project', reuseSession: true }))
    setTaskReuseSessionFile('t1', '/sessions/old.jsonl', old!)
    expect(tasks[0].reuseSessionFile).toBeUndefined()
  })

  it('resetTaskSessionReuse reports unknown tasks', () => {
    expect(resetTaskSessionReuse('missing')).toBeNull()
  })
})

describe('edit-and-ledger loop closures', () => {
  it('a firing hands the task options to the spawn fn and records the run session', async () => {
    const task = baseTask({ permissionMode: 'readonly', skillId: '爆款竞品分析.md' })
    tasks.push(task)
    const calls: Array<{ cwd: string; title: string; prompt: string; opts?: { taskId: string; runId?: string; permissionMode?: string; skillId?: string } }> = []
    setTaskSpawnFn(async (cwd, title, prompt, opts) => {
      calls.push({ cwd, title, prompt, opts })
      return { sessionId: 'session-C' }
    })

    await runTaskNow('t1')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      cwd: '/tmp/project',
      title: '每日报告',
      prompt: '拉取昨日数据并总结',
      opts: { taskId: 't1', permissionMode: 'readonly', skillId: '爆款竞品分析.md' }
    })
    expect(calls[0].opts?.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(tasks[0].lastRunSessionId).toBe('session-C')
    expect(tasks[0].consecutiveFailures).toBeUndefined()
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

  it('does not accept a caller-supplied run ledger or engine state on create or edit', () => {
    const forged = [{ runId: 'forged', startedAt: 1, finishedAt: 2, outcome: 'success' as const, feishuDeliveryRequested: true, feishuChatId: 'oc_forged' }]
    saveTask(baseTask({ runs: forged, consecutiveFailures: 88, lastRunId: 'forged' }))
    expect(tasks[0].runs).toBeUndefined()
    expect(tasks[0].lastRunId).toBeUndefined()
    expect(tasks[0].consecutiveFailures).toBeUndefined()
    saveTask(baseTask({ runs: forged, lastFailureReason: 'threw' }))
    expect(tasks[0].runs).toBeUndefined()
    expect(tasks[0].lastFailureReason).toBeUndefined()
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
  it('freezes the chosen Feishu recipient for the run even if the task is edited', async () => {
    tasks.push(baseTask({ notifyChannel: 'feishu', feishuChatId: 'oc_first' }))
    setTaskSpawnFn(async () => ({ sessionId: 'recipient-session' }))
    await runTaskNow('t1')
    saveTask(baseTask({ notifyChannel: 'feishu', feishuChatId: 'oc_second' }))
    noteTaskSessionEvent('recipient-session', { type: 'status', status: 'idle' })
    expect(tasks[0].feishuChatId).toBe('oc_second')
    expect(tasks[0].runs![0]).toMatchObject({ feishuChatId: 'oc_first', feishuDeliveryRequested: true })
  })

  it('counts failures across successful spawns, resetting only on a completed run', async () => {
    tasks.push(baseTask())
    let id = 0
    setTaskSpawnFn(async () => ({ sessionId: `failure-${++id}` }))
    for (let n = 1; n <= 3; n++) {
      await runTaskNow('t1')
      expect(tasks[0].consecutiveFailures ?? 0).toBe(n - 1)
      noteTaskSessionEvent(`failure-${n}`, { type: 'error', recoverable: false })
      expect(tasks[0].consecutiveFailures).toBe(n)
    }
    expect(tasks[0].enabled).toBe(false)
    toggleTask('t1', true)
    expect(tasks[0].consecutiveFailures).toBe(0)
    await runTaskNow('t1')
    noteTaskSessionEvent('failure-4', { type: 'status', status: 'idle' })
    expect(tasks[0].consecutiveFailures).toBe(0)
  })

  it('keeps delivery separate and never retries an uncertain receipt', async () => {
    tasks.push(baseTask())
    setTaskSpawnFn(async () => ({ sessionId: 'delivery-session' }))
    await runTaskNow('t1')
    noteTaskSessionEvent('delivery-session', { type: 'status', status: 'idle' })
    const runId = tasks[0].runs![0].runId!
    expect(beginTaskDelivery('t1', runId)).not.toBeNull()
    expect(beginTaskDelivery('t1', runId)).toBeNull()
    finishTaskDelivery('t1', runId, { status: 'failed', error: 'feishu-not-connected' })
    expect(tasks[0].runs![0].outcome).toBe('success')
    expect(beginTaskDelivery('t1', runId, true)).not.toBeNull()
    finishTaskDelivery('t1', runId, { status: 'unknown', error: 'send-failed' })
    expect(beginTaskDelivery('t1', runId, true)).toBeNull()
  })

  it('marks an interrupted delivery as unknown instead of resending after restart', () => {
    tasks.push(baseTask({ runs: [{ runId: 'old', startedAt: 1, finishedAt: 2, outcome: 'success', delivery: { status: 'sending', attemptedAt: 2 } }] }))
    reconcileInterruptedTaskRuns(3)
    expect(tasks[0].runs![0].delivery?.status).toBe('unknown')
    expect(beginTaskDelivery('t1', 'old', true)).toBeNull()
  })
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

  it('records a user stop as cancelled when the runtime converges to idle', async () => {
    tasks.push(baseTask())
    setTaskSpawnFn(async () => ({ sessionId: 'run-cancelled' }))
    await runTaskNow('t1')
    noteTaskSessionEvent('run-cancelled', { type: 'status', status: 'aborting' })
    noteTaskSessionEvent('run-cancelled', { type: 'status', status: 'idle' })
    expect(tasks[0].runs![0]).toMatchObject({ outcome: 'failed', status: 'cancelled', reason: 'cancelled' })
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

  it('releases the guard after spawn failure so a manual retry is immediate', async () => {
    tasks.push(baseTask())
    let attempts = 0
    setTaskSpawnFn(async () => {
      attempts += 1
      return null
    })

    await expect(runTaskNow('t1')).resolves.toBe('failed')
    await expect(runTaskNow('t1')).resolves.toBe('failed')
    expect(attempts).toBe(2)
    expect(tasks[0].runs?.slice(0, 2).map((run) => run.outcome)).toEqual(['failed', 'failed'])
  })

  it('keeps an open run in preparing/running state instead of optimistic success', async () => {
    tasks.push(baseTask())
    setTaskSpawnFn(async () => ({ sessionId: 'open-run' }))

    await runTaskNow('t1')
    expect(tasks[0].runs?.[0].outcome).toBeUndefined()
    expect(tasks[0].runs?.[0].status).toBe('running')
    noteTaskSessionEvent('open-run', { type: 'status', status: 'idle' })
    expect(tasks[0].runs?.[0].outcome).toBe('success')
  })

  it('cancels a spawned session before releasing the timeout guard', async () => {
    vi.useFakeTimers()
    try {
      tasks.push(baseTask())
      let cancelled = 0
      setTaskSpawnFn(async () => ({
        sessionId: 'timed-out-session',
        cancel: () => { cancelled += 1 }
      }))

      await expect(runTaskNow('t1')).resolves.toBe('ok')
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)

      expect(cancelled).toBe(1)
      expect(tasks[0].runs?.[0]).toMatchObject({ outcome: 'failed', status: 'interrupted', reason: 'timeout' })
      // The old session is no longer mapped to the task, so its late event
      // cannot settle or mutate a retried run.
      noteTaskSessionEvent('timed-out-session', { type: 'status', status: 'idle' })
      expect(tasks[0].runs?.[0].reason).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles open runs after an app restart as interrupted', () => {
    tasks.push(baseTask({
      lastRunId: 'old-run',
      lastRunStatus: 'running',
      runs: [{ runId: 'old-run', status: 'running', startedAt: 100, sessionId: 'old-session' }]
    }))
    reconcileInterruptedTaskRuns(200)
    expect(tasks[0].runs?.[0]).toMatchObject({
      runId: 'old-run', outcome: 'failed', status: 'interrupted', reason: 'interrupted', finishedAt: 200
    })
    expect(tasks[0].lastRunStatus).toBe('interrupted')
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

  it('attaches a late durable history UUID even after the session is complete', async () => {
    tasks.push(baseTask())
    setTaskSpawnFn(async () => ({ sessionId: 'run-late-file' }))
    await runTaskNow('t1')
    noteTaskSessionEvent('run-late-file', { type: 'status', status: 'idle' })
    noteTaskSessionFile('run-late-file', tasks[0].runs![0].runId!, 'history-uuid-1')
    expect(tasks[0].runs![0].historyUuid).toBe('history-uuid-1')
  })
})
