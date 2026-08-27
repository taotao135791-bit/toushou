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

  it('clears only the snapshot consumed by a successful session creation', async () => {
    const createSession = vi.fn().mockResolvedValue(session)
    vi.stubGlobal('window', {
      electronAPI: {
        createSession,
        getSessionState: vi.fn().mockResolvedValue(null),
        getSubagents: vi.fn().mockResolvedValue(null)
      }
    })

    await expect(createSessionForCurrentProject()).resolves.toBe(session.id)

    expect(useAppStore.getState()).toMatchObject({
      pendingModel: null,
      pendingThinking: null,
      currentSessionId: session.id
    })
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
})
