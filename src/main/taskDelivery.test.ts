import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ScheduledTask } from '../shared/types'

const state = vi.hoisted(() => ({ root: '', tasks: [] as ScheduledTask[], send: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => state.root }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./store', () => ({ getStore: () => state.tasks, setStore: (_key: string, value: ScheduledTask[]) => { state.tasks = value } }))
vi.mock('./integrations/feishu/FeishuConnectionManager', () => ({ feishuConnectionManager: { pushTaskResult: state.send } }))
import { deliverTaskResult, pruneTaskDeliveryPayloads } from './taskDelivery'

beforeEach(() => {
  state.root = mkdtempSync(path.join(tmpdir(), 'toushou-task-delivery-'))
  state.send.mockReset()
  state.tasks = [{ id: 'task-1', name: 'Synthetic report', prompt: 'Synthetic', cwd: '/synthetic', enabled: true, createdAt: 1,
    schedule: { type: 'daily', time: '09:00' }, notifyOnComplete: true, notifyChannel: 'feishu', feishuChatId: 'oc_original',
    runs: [{ runId: 'run-1', startedAt: 1, finishedAt: 2, outcome: 'success', status: 'completed',
      feishuDeliveryRequested: true, feishuChatId: 'oc_original' }] }]
})
afterEach(() => rmSync(state.root, { recursive: true, force: true }))
const delivery = () => state.tasks[0].runs![0].delivery

describe('Main-owned task delivery outbox', () => {
  it('retries the captured content and recipient after task edits, without rerunning the task', async () => {
    state.send.mockResolvedValueOnce({ ok: false, error: 'feishu-not-connected' }).mockResolvedValueOnce({ ok: true })
    expect(await deliverTaskResult('task-1', 'run-1', 'Synthetic original result')).toBe(false)
    expect(delivery()?.status).toBe('failed')
    expect(JSON.stringify(state.tasks)).not.toContain('Synthetic original result')
    state.tasks[0].feishuChatId = 'oc_other'
    state.tasks[0].prompt = 'Changed task'
    state.tasks[0].notifyOnComplete = false
    expect(await deliverTaskResult('task-1', 'run-1', undefined, true)).toBe(true)
    expect(state.send.mock.calls).toEqual([['Synthetic original result', 'oc_original'], ['Synthetic original result', 'oc_original']])
    expect(delivery()?.status).toBe('sent')
    expect(state.tasks[0].runs).toHaveLength(1)
    expect(readdirSync(path.join(state.root, 'task-delivery-outbox'))).toEqual([])
  })

  it('uses the destination captured when the run started, even for its initial send', async () => {
    state.tasks[0].feishuChatId = 'oc_other'
    state.send.mockResolvedValue({ ok: true })
    expect(await deliverTaskResult('task-1', 'run-1', 'Synthetic result')).toBe(true)
    expect(state.send).toHaveBeenCalledWith('Synthetic result', 'oc_original')
  })

  it('blocks concurrent sends and refuses to resend unknown or successful deliveries', async () => {
    let finish!: (result: { ok: boolean; error: string; uncertain: boolean }) => void
    state.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = deliverTaskResult('task-1', 'run-1', 'Synthetic result')
    expect(delivery()?.status).toBe('sending')
    expect(await deliverTaskResult('task-1', 'run-1', 'Different result')).toBe(false)
    expect(await deliverTaskResult('task-1', 'run-1', undefined, true)).toBe(false)
    finish({ ok: false, error: 'no-receipt', uncertain: true })
    await pending
    expect(delivery()?.status).toBe('unknown')
    expect(await deliverTaskResult('task-1', 'run-1', undefined, true)).toBe(false)
    expect(state.send).toHaveBeenCalledOnce()
  })

  it('does not infer an old run recipient from the current task or send a run that never requested Feishu', async () => {
    delete state.tasks[0].runs![0].feishuChatId
    expect(await deliverTaskResult('task-1', 'run-1', 'Synthetic result')).toBe(false)
    expect(delivery()).toMatchObject({ status: 'failed', error: 'no-target' })
    expect(state.send).not.toHaveBeenCalled()
    delete state.tasks[0].runs![0].delivery
    delete state.tasks[0].runs![0].feishuDeliveryRequested
    expect(await deliverTaskResult('task-1', 'run-1', 'Synthetic result')).toBe(false)
    expect(delivery()).toBeUndefined()
  })

  it('refuses a retry without its private payload and removes payloads once their run is deleted', async () => {
    state.send.mockResolvedValue({ ok: false, error: 'no-chat' })
    await deliverTaskResult('task-1', 'run-1', 'Synthetic result')
    state.tasks[0].runs = []
    pruneTaskDeliveryPayloads()
    expect(readdirSync(path.join(state.root, 'task-delivery-outbox'))).toEqual([])
    expect(await deliverTaskResult('task-1', 'run-1', undefined, true)).toBe(false)
    expect(state.send).toHaveBeenCalledOnce()
  })

  it('records missing retry material as unavailable, rather than suggesting repeated network retries', async () => {
    state.send.mockResolvedValue({ ok: false, error: 'feishu-not-connected' })
    await deliverTaskResult('task-1', 'run-1', 'Synthetic result')
    rmSync(path.join(state.root, 'task-delivery-outbox'), { recursive: true })
    expect(await deliverTaskResult('task-1', 'run-1', undefined, true)).toBe(false)
    expect(delivery()).toMatchObject({ status: 'failed', error: 'payload-unavailable' })
    expect(state.send).toHaveBeenCalledOnce()
  })
})
