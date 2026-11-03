import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WorkspaceGrant } from '@shared/types'
import { useAppStore } from './index'

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, cwd: '/synthetic/project', title: 'Named conversation', createdAt: 100,
  status: 'idle', ...extra
})
const workspace = (realPath: string): WorkspaceGrant => ({
  id: `grant:${realPath}`, realPath, displayPath: realPath, source: 'dialog', createdAt: 1
})

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(5_000)
  vi.stubGlobal('window', { electronAPI: {
    getSubagents: vi.fn().mockResolvedValue([]),
    getSessionState: vi.fn().mockResolvedValue(null),
    setSessionName: vi.fn().mockResolvedValue({ title: '投放日报 2', source: 'auto', revision: 1 })
  } })
  useAppStore.setState({
    sessions: [session('a'), session('b')], currentSessionId: 'a',
    sessionRecords: [], currentWorkspace: workspace('/synthetic/project'),
    recentProjects: [], unreadSessionIds: {}, messages: {}, executions: {}
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState({
    sessions: [], currentSessionId: null, currentWorkspace: null,
    sessionRecords: [], messages: {}, executions: {}, recentProjects: []
  })
})

describe('session activity', () => {
  it('preserves a Main-owned readonly lock across live registry refreshes', () => {
    const store = useAppStore.getState()
    store.addSession(session('analysis', { readonly: true }), true)
    store.addSession(session('analysis'), false)
    expect(useAppStore.getState().sessions.find(item => item.id === 'analysis')?.readonly).toBe(true)
  })

  it('accepts an original history timestamp even when the live registry row already exists', () => {
    const restored = session('a', { lastActivityAt: 50 })
    useAppStore.getState().addSession(restored, false)
    useAppStore.getState().setCurrentSessionId('a')
    expect(useAppStore.getState().sessions.find((s) => s.id === 'a')).toMatchObject({
      lastActivityAt: 50, pendingActivityAt: undefined
    })
    // A later live registry report cannot erase the original history time.
    useAppStore.getState().addSession(session('a'), false)
    expect(useAppStore.getState().sessions.find((s) => s.id === 'a')?.lastActivityAt).toBe(50)
  })

  it('defers activity of the open conversation until the user leaves it', () => {
    const store = useAppStore.getState()
    store.touchSession('a')
    store.setCurrentSessionId('a')
    expect(useAppStore.getState().sessions[0]).toMatchObject({ pendingActivityAt: 5_000 })
    expect(useAppStore.getState().sessions[0].lastActivityAt).toBeUndefined()
    store.setCurrentSessionId('b')
    expect(useAppStore.getState().sessions[0]).toMatchObject({
      lastActivityAt: 5_000, pendingActivityAt: undefined
    })
  })

  it('commits a background queued send immediately without another navigation', () => {
    useAppStore.getState().touchSession('b')
    expect(useAppStore.getState().sessions[1]).toMatchObject({
      lastActivityAt: 5_000, pendingActivityAt: undefined
    })
  })

  it('commits the previous row when a tool launch selects a newly-created session', () => {
    const store = useAppStore.getState()
    store.touchSession('a')
    store.addSession(session('tool-launch'), true)
    expect(useAppStore.getState().currentSessionId).toBe('tool-launch')
    expect(useAppStore.getState().sessions.find((s) => s.id === 'a')).toMatchObject({
      lastActivityAt: 5_000, pendingActivityAt: undefined
    })
  })

  it.each([null, workspace('/synthetic/other')])('commits pending activity when leaving the workspace: %s', (grant) => {
    const store = useAppStore.getState()
    store.touchSession('a')
    store.setCurrentWorkspace(grant)
    expect(useAppStore.getState().currentSessionId).toBeNull()
    expect(useAppStore.getState().sessions[0]).toMatchObject({
      lastActivityAt: 5_000, pendingActivityAt: undefined
    })
  })

  it('keeps the current row pending when reactivating the same workspace', () => {
    const store = useAppStore.getState()
    store.touchSession('a')
    store.setCurrentWorkspace(workspace('/synthetic/project'))
    expect(useAppStore.getState().currentSessionId).toBe('a')
    expect(useAppStore.getState().sessions[0].lastActivityAt).toBeUndefined()
  })
})

describe('canonical automatic titles', () => {
  it('uses the actual title allocated by Main rather than the requested text', async () => {
    useAppStore.setState({
      sessions: [session('a', { title: 'project' })],
      messages: { a: [{ id: 'first', role: 'user', content: '投放日报' }] }
    })
    await useAppStore.getState().maybeNameSession('a')
    expect(window.electronAPI.setSessionName).toHaveBeenCalledWith('a', '投放日报', { source: 'auto' })
    expect(useAppStore.getState().sessions[0].title).toBe('投放日报 2')
  })

  it('retains the existing title when naming fails', async () => {
    vi.mocked(window.electronAPI.setSessionName).mockResolvedValue(null)
    useAppStore.setState({
      sessions: [session('a', { title: 'project' })],
      messages: { a: [{ id: 'first', role: 'user', content: '投放日报' }] }
    })
    await useAppStore.getState().maybeNameSession('a')
    expect(useAppStore.getState().sessions[0].title).toBe('project')
  })
})

describe('evolving and manual topic protection', () => {
  it('shows a safe intent immediately while the host response is pending', async () => {
    let resolve!: (result: { title: string; source: 'auto'; revision: number } | null) => void
    vi.mocked(window.electronAPI.setSessionName).mockImplementation(() => new Promise((done) => { resolve = done }))
    useAppStore.setState({ sessions: [session('a', { title: 'project' })], messages: { a: [{ id: 'first', role: 'user', content: '请分析TikTok广告主7123456789012345678的成本' }] } })
    const naming = useAppStore.getState().maybeNameSession('a')
    expect(useAppStore.getState().sessions[0]).toMatchObject({ title: 'TikTok投放分析', titleSource: 'auto' })
    resolve({ title: 'TikTok成本诊断', source: 'auto', revision: 1 })
    await naming
    expect(useAppStore.getState().sessions[0].title).toBe('TikTok成本诊断')
  })

  it('accepts later semantic updates and ignores older events', () => {
    useAppStore.setState({ sessions: [session('a', { title: 'TikTok投放分析', titleSource: 'auto', titleRevision: 1 })] })
    useAppStore.getState().applySessionEvent({ type: 'title_changed', sessionId: 'a', title: '成本趋势看板', source: 'auto', revision: 3 })
    useAppStore.getState().applySessionEvent({ type: 'title_changed', sessionId: 'a', title: '旧的分析', source: 'auto', revision: 2 })
    expect(useAppStore.getState().sessions[0]).toMatchObject({ title: '成本趋势看板', titleRevision: 3 })
  })

  it('never replaces a manual rename with a late first-send response or model event', async () => {
    let resolve!: (result: { title: string; source: 'auto'; revision: number } | null) => void
    vi.mocked(window.electronAPI.setSessionName).mockImplementation(() => new Promise((done) => { resolve = done }))
    useAppStore.setState({ sessions: [session('a', { title: 'project' })], messages: { a: [{ id: 'first', role: 'user', content: '投放日报' }] } })
    const naming = useAppStore.getState().maybeNameSession('a')
    useAppStore.getState().setSessionTitle('a', '我的日报')
    resolve({ title: '投放日报 2', source: 'auto', revision: 1 })
    await naming
    useAppStore.getState().applySessionEvent({ type: 'title_changed', sessionId: 'a', title: '自动主题', source: 'auto', revision: 2 })
    expect(useAppStore.getState().sessions[0]).toMatchObject({ title: '我的日报', titleSource: 'manual' })
  })

  it('does not let a slow fallback response overwrite a fast semantic update', async () => {
    let resolve!: (result: { title: string; source: 'auto'; revision: number } | null) => void
    vi.mocked(window.electronAPI.setSessionName).mockImplementation(() => new Promise((done) => { resolve = done }))
    useAppStore.setState({ sessions: [session('a', { title: 'project' })], messages: { a: [{ id: 'first', role: 'user', content: '投放日报' }] } })
    const naming = useAppStore.getState().maybeNameSession('a')
    useAppStore.getState().applySessionEvent({ type: 'title_changed', sessionId: 'a', title: '转化成本周报', source: 'auto', revision: 1 })
    resolve({ title: '投放日报 2', source: 'auto', revision: 1 })
    await naming
    expect(useAppStore.getState().sessions[0].title).toBe('转化成本周报')
  })

  it('preserves topic metadata when a registry refresh omits it', () => {
    useAppStore.setState({ sessions: [session('a', { title: '我的主题', titleSource: 'manual', titleRevision: 4 })] })
    useAppStore.getState().addSession(session('a', { title: 'project' }), false)
    expect(useAppStore.getState().sessions[0]).toMatchObject({ title: '我的主题', titleSource: 'manual', titleRevision: 4 })
  })
})
