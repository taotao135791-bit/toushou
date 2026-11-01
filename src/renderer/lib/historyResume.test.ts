import { describe, expect, it, vi } from 'vitest'
import type { HistorySessionDescriptor, WorkspaceGrant } from '@shared/types'
import type { SessionRecord } from './sessionRegistry'
import { finishHistoryResume, historyResumeGrant, openGlobalHistory, type HistoryResumeState } from './historyResume'

const grant = (id: string, realPath: string): WorkspaceGrant => ({ id, realPath, displayPath: realPath, source: 'recent-project', createdAt: 1 })
const history: HistorySessionDescriptor = { id: 'capability-b', uuid: 'history-1', title: 'Fixture', timestamp: 1 }
const record = (path: string, entry = history): SessionRecord => ({ key: entry.uuid, workspaceRealPath: path, title: entry.title, history: entry, state: 'historical', updatedAt: 1, isLive: false, isResumable: true })

describe('history workspace activation', () => {
  it('chooses the exact canonical project and resumes with the freshly activated grant', async () => {
    const state: HistoryResumeState = { currentWorkspace: null, historyLoading: false, recentWorkspaces: [
      { id: 'other', displayPath: '/synthetic/other/project' },
      { id: 'correct', displayPath: '/synthetic/right/project' }
    ], sessionRecords: [record('/synthetic/other/project', { ...history, id: 'wrong-capability' })] }
    const activate = vi.fn(async (id: string) => { state.currentWorkspace = grant(id, '/synthetic/right/project') })
    const load = vi.fn(async (id: string) => { expect(id).toBe('correct'); state.sessionRecords.push(record('/synthetic/right/project')) })
    const resume = vi.fn(async (info: HistorySessionDescriptor, workspace: string) => {
      expect(state.currentWorkspace?.id).toBe('correct')
      expect(info.id).toBe('capability-b')
      expect(workspace).toBe('/synthetic/right/project')
      return true
    })
    expect(await openGlobalHistory({ uuid: history.uuid, cwd: '/synthetic/right/project' }, { getState: () => state, activateWorkspace: activate, loadHistory: load, resume })).toBe('opened')
    expect(activate).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenCalledWith('correct')
    expect(resume).toHaveBeenCalledOnce()
  })
  it('resolves the grant from the current state immediately before resuming', () => {
    const state: HistoryResumeState = { currentWorkspace: null, historyLoading: false, recentWorkspaces: [], sessionRecords: [] }
    expect(historyResumeGrant(state, history, '/synthetic/right')).toEqual({ ok: false, error: 'project-not-added' })
    state.currentWorkspace = grant('fresh', '/synthetic/right')
    state.sessionRecords = [record('/synthetic/right')]
    expect(historyResumeGrant(state, history, '/synthetic/right')).toMatchObject({ ok: true, grant: { id: 'fresh' } })
    state.historyLoading = true
    expect(historyResumeGrant(state, history, '/synthetic/right')).toEqual({ ok: false, error: 'loading' })
  })
  it('does not claim success when the workspace changes or a resume fails', async () => {
    const state: HistoryResumeState = { currentWorkspace: grant('a', '/synthetic/a'), historyLoading: false, recentWorkspaces: [], sessionRecords: [record('/synthetic/a')] }
    const resume = vi.fn(async () => false)
    const deps = { getState: () => state, activateWorkspace: vi.fn(async () => {}), loadHistory: vi.fn(async () => {}), resume }
    expect(await openGlobalHistory({ uuid: history.uuid, cwd: '/synthetic/a' }, deps)).toBe('resume-failed')
    deps.loadHistory.mockImplementationOnce(async () => { state.currentWorkspace = grant('b', '/synthetic/b') })
    expect(await openGlobalHistory({ uuid: history.uuid, cwd: '/synthetic/a' }, deps)).toBe('history-unavailable')
    expect(resume).toHaveBeenCalledOnce()
  })
  it('reports loading, missing grants and stale cross-workspace records without starting a session', async () => {
    const state: HistoryResumeState = { currentWorkspace: null, historyLoading: true, recentWorkspaces: [], sessionRecords: [] }
    const deps = { getState: () => state, activateWorkspace: vi.fn(async () => {}), loadHistory: vi.fn(async () => {}), resume: vi.fn(async () => true) }
    expect(await openGlobalHistory({ uuid: history.uuid, cwd: '/synthetic/a' }, deps)).toBe('loading')
    state.historyLoading = false
    expect(await openGlobalHistory({ uuid: history.uuid, cwd: '/synthetic/a' }, deps)).toBe('project-not-added')
    state.currentWorkspace = grant('a', '/synthetic/a'); state.sessionRecords = [record('/synthetic/b')]
    expect(await openGlobalHistory({ uuid: history.uuid, cwd: '/synthetic/a' }, deps)).toBe('history-unavailable')
    expect(deps.resume).not.toHaveBeenCalled()
  })
})

describe('finishing an asynchronous history resume', () => {
  it('preserves the restored session and transcript without changing selection after a project switch', async () => {
    const original = grant('grant-a', '/synthetic/a')
    let current = original
    let selected = 'session-b'
    const saved: Array<{ session: string; messages: string[] }> = []
    const navigate = vi.fn()
    let resolveResume!: (value: { session: string; messages: string[] }) => void
    const pending = new Promise<{ session: string; messages: string[] }>(resolve => { resolveResume = resolve })
    const finish = pending.then(result => finishHistoryResume(original, {
      save: () => saved.push(result),
      currentWorkspace: () => current,
      select: () => { selected = result.session; navigate() }
    }))

    current = grant('grant-b', '/synthetic/b')
    resolveResume({ session: 'session-a', messages: ['restored message'] })
    expect(await finish).toBe(false)
    expect(saved).toEqual([{ session: 'session-a', messages: ['restored message'] }])
    expect(selected).toBe('session-b')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('selects only when the original grant is still current', () => {
    const original = grant('grant-a', '/synthetic/a')
    const save = vi.fn()
    const select = vi.fn()
    expect(finishHistoryResume(original, { save, currentWorkspace: () => original, select })).toBe(true)
    expect(select).toHaveBeenCalledOnce()
    // A newly issued grant for the same path is still a different activation.
    expect(finishHistoryResume(original, { save, currentWorkspace: () => grant('new-grant', original.realPath), select })).toBe(false)
    expect(select).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledTimes(2)
  })
})
