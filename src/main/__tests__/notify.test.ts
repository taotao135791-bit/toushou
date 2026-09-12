import { describe, expect, it, vi } from 'vitest'

// notify.ts touches electron (windows, notifications) and Main's registries;
// only the pure target resolution is under test here.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false }
}))
vi.mock('../omp', () => ({ getSession: vi.fn(), getLastAssistantText: vi.fn(() => '') }))
vi.mock('../store', () => ({ getStore: vi.fn(() => true) }))
vi.mock('../sessionHistory', () => ({ listAllSessions: vi.fn() }))

import { getSession } from '../omp'
import { listAllSessions } from '../sessionHistory'
import { resolveTaskNotificationTarget } from '../notify'

describe('resolveTaskNotificationTarget', () => {
  it('prefers the live run session when it still exists', async () => {
    vi.mocked(getSession).mockReturnValue({ id: 'session-live', cwd: '/x', title: 't', createdAt: 0, status: 'idle' })
    await expect(resolveTaskNotificationTarget('每日报告', 'session-live')).resolves.toEqual({
      kind: 'select',
      sessionId: 'session-live'
    })
    expect(vi.mocked(listAllSessions)).not.toHaveBeenCalled()
  })

  it('falls back to the newest durable row titled after the task after a restart', async () => {
    vi.mocked(getSession).mockReturnValue(undefined)
    vi.mocked(listAllSessions).mockResolvedValue([
      { uuid: 'u-other', title: '别的会话', timestamp: 3, cwd: '/tmp/other', filePath: '/a.jsonl' },
      { uuid: 'u-run', title: '每日报告', timestamp: 2, cwd: '/tmp/project', filePath: '/b.jsonl' },
      { uuid: 'u-old-run', title: '每日报告', timestamp: 1, cwd: '/tmp/project', filePath: '/c.jsonl' }
    ] as never)
    await expect(resolveTaskNotificationTarget('每日报告', 'session-dead')).resolves.toEqual({
      kind: 'history',
      uuid: 'u-run',
      cwd: '/tmp/project'
    })
  })

  it('resolves to nothing when no live session and no matching history row', async () => {
    vi.mocked(getSession).mockReturnValue(undefined)
    vi.mocked(listAllSessions).mockResolvedValue([])
    await expect(resolveTaskNotificationTarget('每日报告', 'session-dead')).resolves.toBeNull()
  })
})
