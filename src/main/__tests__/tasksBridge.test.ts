import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The bridge dispatch is exercised through the real scheduledTasks engine,
// so only electron and the settings store get mocked (same recipe as
// scheduledTasks.test.ts). The omp import is stubbed because the bridge
// resolves the calling session's cwd lazily from it.
const access = vi.hoisted(() => ({ mode: 'full', remoteReadonly: false, cwd: '/tmp/session-workspace', confirm: 0, hasWindow: true, changeOnConfirm: false, rejectConfirm: false }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => access.hasWindow ? { isDestroyed: () => false } : null },
  dialog: { showMessageBox: vi.fn(async () => { if (access.rejectConfirm) throw new Error('synthetic'); if (access.changeOnConfirm) access.mode = 'readonly'; return { response: access.confirm } }) }
}))
vi.mock('../store', () => ({
  getStore: vi.fn(() => tasksFixture()),
  setStore: vi.fn()
}))
vi.mock('../omp', () => ({
  getSession: (id: string) => (id === 'session-1' ? { id, cwd: '/tmp/session-workspace' } : undefined),
  getSessionBridgeAccess: (id: string) => id === 'session-1' ? { mode: access.mode, remoteReadonly: access.remoteReadonly, cwd: access.cwd } : null
}))

import { ScheduledTask } from '../../shared/types'
import { initTasksBridge, parseTaskBridgeRequest, tasksBridgeEnv, resetTasksBridgeForTest } from '../tasksBridge'

const { getStore, setStore } = await import('../store')

let tasks: ScheduledTask[] = []
function tasksFixture(): ScheduledTask[] {
  return tasks
}

beforeEach(() => {
  tasks = []
  Object.assign(access, { mode: 'full', remoteReadonly: false, cwd: '/tmp/session-workspace', confirm: 0, hasWindow: true, changeOnConfirm: false, rejectConfirm: false })
  vi.mocked(getStore).mockImplementation(() => tasks as ScheduledTask[])
  vi.mocked(setStore).mockImplementation((key, value) => {
    if (key === 'scheduledTasks') tasks = value as ScheduledTask[]
  })
  resetTasksBridgeForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseTaskBridgeRequest', () => {
  it('accepts the three actions and validates the delete id', () => {
    expect(parseTaskBridgeRequest({ action: 'task_list' })).toEqual({ action: 'task_list' })
    expect(
      parseTaskBridgeRequest({ action: 'task_create', name: 'a', prompt: 'b', schedule: { type: 'interval', minutes: 3 } })
    ).toMatchObject({ action: 'task_create' })
    expect(parseTaskBridgeRequest({ action: 'task_delete', taskId: 'task-1' })).toEqual({ action: 'task_delete', taskId: 'task-1' })
    expect(parseTaskBridgeRequest({ action: 'task_delete', taskId: 42 })).toBeNull()
    expect(parseTaskBridgeRequest({ action: 'explode' })).toBeNull()
    expect(parseTaskBridgeRequest('nope')).toBeNull()
  })
})

describe('bridge server', () => {
  it('serves task_list, create (bound to session cwd) and delete over loopback', async () => {
    await initTasksBridge()
    const env = tasksBridgeEnv('session-1')
    const base = env.TOUSHOU_TASKS
    expect(base).toBeTruthy()

    const call = async (body: unknown) => {
      const response = await fetch(base!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    }

    // An unknown token is refused before anything else happens.
    const stranger = await fetch((base as string).replace(/\/[^/]+$/, '/deadbeef'), { method: 'POST', body: '{}' })
    expect(stranger.status).toBe(403)

    // Create binds the task to the calling session's own workspace.
    const created = await call({
      action: 'task_create',
      name: '三分钟巡检',
      prompt: '看一眼账户',
      schedule: { type: 'interval', minutes: 3 }
    })
    expect(created.body.ok).toBe(true)
    expect((created.body.task as Record<string, unknown>).cwd).toBe('/tmp/session-workspace')
    expect(tasks).toHaveLength(1)

    const listed = await call({ action: 'task_list' })
    expect(listed.body.ok).toBe(true)
    expect(listed.body.tasks as unknown[]).toHaveLength(1)

    // An invalid schedule is rejected by the same validation the IPC uses.
    const badSchedule = await call({ action: 'task_create', name: 'x', prompt: 'y', schedule: { type: 'interval' } })
    expect(badSchedule.body.ok).toBe(false)

    const taskId = (created.body.task as Record<string, unknown>).id as string
    const deleted = await call({ action: 'task_delete', taskId })
    expect(deleted.body.ok).toBe(true)
    expect(tasks).toHaveLength(0)

    const missing = await call({ action: 'task_delete', taskId })
    expect(missing.body.ok).toBe(false)
  }, 20000)
})


describe('task reuse reset authorization', () => {
  it('enforces the Main session policy and rechecks after confirmation', async () => {
    await initTasksBridge()
    const endpoint = tasksBridgeEnv('session-1').TOUSHOU_TASKS!
    const call = async () => (await (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'task_reset_reuse', taskId: 'synthetic' }) })).json()) as { ok: boolean; error?: string }
    const seed = () => { tasks = [{ id: 'synthetic', name: 'Synthetic task', prompt: 'Synthetic', cwd: '/tmp/session-workspace', schedule: { type: 'daily', time: '09:00' }, enabled: true, createdAt: 1, notifyOnComplete: false, reuseSession: true, reuseSessionFile: '/synthetic/session.jsonl' }] }
    seed()
    access.mode = 'readonly'
    expect(await call()).toEqual({ ok: false, error: 'permission-denied' })
    expect(tasks[0].reuseSession).toBe(true)
    access.mode = 'full'; access.remoteReadonly = true
    expect(await call()).toEqual({ ok: false, error: 'permission-denied' })
    expect(tasks[0].reuseSessionFile).toBe('/synthetic/session.jsonl')
    access.remoteReadonly = false; access.mode = 'ask'; access.confirm = 0
    expect(await call()).toEqual({ ok: false, error: 'permission-denied' })
    expect(tasks[0].reuseSession).toBe(true)
    access.hasWindow = false
    expect(await call()).toEqual({ ok: false, error: 'permission-denied' })
    access.hasWindow = true; access.rejectConfirm = true
    expect(await call()).toEqual({ ok: false, error: 'permission-denied' })
    access.rejectConfirm = false; access.confirm = 1; access.changeOnConfirm = true
    expect(await call()).toEqual({ ok: false, error: 'permission-denied' })
    expect(tasks[0].reuseSession).toBe(true)
    access.mode = 'ask'; access.changeOnConfirm = false
    expect((await call()).ok).toBe(true)
    expect(tasks[0].reuseSession).toBe(false)
    expect(tasks[0].reuseSessionFile).toBeUndefined()
    seed(); access.mode = 'no-bash'
    expect((await call()).ok).toBe(true)
    expect(tasks[0].reuseSession).toBe(false)
  })
})
