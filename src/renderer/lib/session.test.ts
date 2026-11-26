import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WorkspaceGrant } from '@shared/types'
import { useAppStore } from '../store'
import { createSessionForCurrentProject } from './session'

const workspace: WorkspaceGrant = {
  id: 'workspace-test',
  realPath: '/tmp/workspace-test',
  displayPath: '/tmp/workspace-test',
  source: 'dialog',
  createdAt: 1
}

const session: Session = {
  id: 'session-test',
  cwd: workspace.realPath,
  title: 'workspace-test',
  createdAt: 2,
  status: 'idle'
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

beforeEach(() => {
  useAppStore.setState({
    currentWorkspace: workspace,
    currentSessionId: null,
    sessions: [],
    sessionRecords: [],
    pendingModel: 'deepseek/deepseek-v4-flash',
    pendingThinking: 'high'
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({
    currentWorkspace: null,
    currentSessionId: null,
    sessions: [],
    sessionRecords: [],
    pendingModel: null,
    pendingThinking: null
  })
})

describe('createSessionForCurrentProject', () => {
  it('keeps the draft and model choices when the default folder needs confirmation', async () => {
    useAppStore.setState({ currentWorkspace: null, composerDrafts: { __new__: { text: 'Unsent draft', images: [] } } })
    const createSession = vi.fn()
    vi.stubGlobal('window', { electronAPI: { getDefaultWorkspace: vi.fn().mockResolvedValue(null), createSession } })
    expect(await createSessionForCurrentProject()).toBeNull()
    expect(createSession).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({ currentWorkspace: null, pendingModel: 'deepseek/deepseek-v4-flash', pendingThinking: 'high', composerDrafts: { __new__: { text: 'Unsent draft' } } })
  })
  it('keeps next-session overrides when Main rejects session creation', async () => {
    const createSession = vi.fn().mockRejectedValue(new Error('grant unavailable'))
    vi.stubGlobal('window', { electronAPI: { createSession } })

    await expect(createSessionForCurrentProject()).rejects.toThrow('grant unavailable')

    expect(createSession).toHaveBeenCalledWith(workspace.id, {
      modelSelector: 'deepseek/deepseek-v4-flash',
      thinkingLevel: 'high'
    })
    expect(useAppStore.getState()).toMatchObject({
      pendingModel: 'deepseek/deepseek-v4-flash',
      pendingThinking: 'high'
    })
  })

  it('reuses the last explicit choice for consecutive new conversations', async () => {
    const createSession = vi.fn().mockResolvedValue(session)
    vi.stubGlobal('window', {
      electronAPI: {
        createSession,
        getSessionState: vi.fn().mockResolvedValue(null),
        getSubagents: vi.fn().mockResolvedValue(null)
      }
    })

    await expect(createSessionForCurrentProject()).resolves.toBe(session.id)

    useAppStore.setState({ currentSessionId: null })
    await expect(createSessionForCurrentProject()).resolves.toBe(session.id)
    expect(createSession.mock.calls).toEqual(Array.from({ length: 2 }, () => [
      workspace.id, { modelSelector: 'deepseek/deepseek-v4-flash', thinkingLevel: 'high' }
    ]))
  })

 it('does not erase a newer picker choice made while creation is in flight', async () => {
    const pendingCreate = deferred<Session>()
    vi.stubGlobal('window', {
      electronAPI: {
        createSession: vi.fn().mockReturnValue(pendingCreate.promise),
        getSessionState: vi.fn().mockResolvedValue(null),
        getSubagents: vi.fn().mockResolvedValue(null)
      }
    })

    const creating = createSessionForCurrentProject()
    useAppStore.getState().setPendingModel('openai/gpt-5')
    useAppStore.getState().setPendingThinking('low')
    pendingCreate.resolve(session)

    await expect(creating).resolves.toBe(session.id)
    expect(useAppStore.getState()).toMatchObject({
      pendingModel: 'openai/gpt-5',
      pendingThinking: 'low'
    })
  })

  it('uses runtime defaults on first launch and restores the saved choice on restart', async () => {
    const createSession = vi.fn().mockResolvedValue(session)
    let stored: { model: string | null; thinking: string | null } | null = null
    vi.stubGlobal('window', { electronAPI: {
      createSession,
      getSessionState: vi.fn().mockResolvedValue(null),
      getSubagents: vi.fn().mockResolvedValue(null),
      getStore: vi.fn(async () => stored),
      setStore: vi.fn(async (_key, value) => { stored = value; return true })
    } })
    useAppStore.setState({ pendingModel: null, pendingThinking: null })
    await createSessionForCurrentProject()
    expect(createSession).toHaveBeenLastCalledWith(workspace.id, {})
    useAppStore.getState().setPendingModel('openai/gpt-5')
    useAppStore.getState().setPendingThinking('medium')
    useAppStore.setState({ currentSessionId: null, pendingModel: null, pendingThinking: null })
    await useAppStore.getState().loadChatPreferences()
    await createSessionForCurrentProject()
    expect(createSession).toHaveBeenLastCalledWith(workspace.id, { modelSelector: 'openai/gpt-5', thinkingLevel: 'medium' })
  })

  it('remembers live choices only after the runtime accepts them', async () => {
    const getSessionState = vi.fn().mockResolvedValue({ model: { provider: 'openai', id: 'gpt-5' }, thinkingLevel: 'medium' })
    const setSessionModel = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const setThinkingLevel = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', { electronAPI: { getSessionState, setSessionModel, setThinkingLevel } })
    useAppStore.setState({ currentSessionId: session.id })
    const state = useAppStore.getState()
    expect(await state.setCurrentSessionModel('openai', 'missing')).toBe(false)
    expect(state.getSessionOverrides()).toEqual({ modelSelector: 'deepseek/deepseek-v4-flash', thinkingLevel: 'high' })
    expect(await state.setCurrentSessionModel('openai', 'gpt-5')).toBe(true)
    expect(state.getSessionOverrides()).toEqual({ modelSelector: 'openai/gpt-5', thinkingLevel: 'medium' })
    expect(await state.setCurrentSessionThinking('auto')).toBe(true)
    expect(state.getSessionOverrides()).toEqual({ modelSelector: 'openai/gpt-5', thinkingLevel: 'auto' })
  })

  it('anchors to the default workspace when no project is selected', async () => {
    useAppStore.setState({ currentWorkspace: null })
    const defaultGrant: WorkspaceGrant = {
      id: 'grant-default',
      realPath: '/tmp/toushou-default',
      displayPath: '/tmp/toushou-default',
      source: 'default',
      createdAt: 3
    }
    const createSession = vi.fn().mockResolvedValue(session)
    const getDefaultWorkspace = vi.fn().mockResolvedValue(defaultGrant)
    vi.stubGlobal('window', {
      electronAPI: {
        createSession,
        getDefaultWorkspace,
        listRecentWorkspaces: vi.fn().mockResolvedValue([]),
        getSessionState: vi.fn().mockResolvedValue(null),
        getSubagents: vi.fn().mockResolvedValue(null)
      }
    })

    await expect(createSessionForCurrentProject()).resolves.toBe(session.id)

    expect(getDefaultWorkspace).toHaveBeenCalledOnce()
    expect(createSession).toHaveBeenCalledWith('grant-default', expect.any(Object))
    expect(useAppStore.getState().currentWorkspace?.id).toBe('grant-default')
    expect(useAppStore.getState().currentSessionId).toBe(session.id)
  })

  it('preserves a slow created session for its first prompt without taking a newer selection', async () => {
    const pending = deferred<Session>()
    vi.stubGlobal('window', { electronAPI: {
      createSession: vi.fn(() => pending.promise), getSessionState: vi.fn().mockResolvedValue(null), getSubagents: vi.fn().mockResolvedValue([])
    } })
    const creating = createSessionForCurrentProject()
    useAppStore.getState().setCurrentSessionId('newer-session')
    pending.resolve(session)
    expect(await creating).toBe(session.id)
    expect(useAppStore.getState().currentSessionId).toBe('newer-session')
    expect(useAppStore.getState().sessions.some(item => item.id === session.id)).toBe(true)
  })
})
