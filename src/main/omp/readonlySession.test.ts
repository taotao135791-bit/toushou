import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const mocks = vi.hoisted(() => ({ writeApproval: vi.fn(), plan: vi.fn((..._args: unknown[]) => ({})), spawn: vi.fn(() => ({})), prompt: vi.fn(() => true), registerBuild: vi.fn(), revokeBuild: vi.fn(), gone: undefined as undefined | (() => void) }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../store', () => ({ getStore: (key: string) => key === 'permissionMode' ? 'ask' : 'en', rememberRecentProject: vi.fn() }))
vi.mock('./OmpCapabilities', () => ({ detectCli: () => ({ available: true, command: 'synthetic' }), noteHandshake: vi.fn(), noteSessionState: vi.fn(), noteSubagentCapabilityOutcome: vi.fn(), invalidateCliCache: vi.fn(), executableSearchDirs: vi.fn(), getCapabilities: vi.fn() }))
vi.mock('./OmpProcess', () => ({ planSpawn: mocks.plan, spawnProcess: mocks.spawn, resolvePermissionMode: () => ({ approval: 'off' }), writeApprovalConfig: mocks.writeApproval, removeApprovalConfig: vi.fn() }))
vi.mock('../boardBuilds', () => ({ registerBoardBuildTurn: mocks.registerBuild, revokeBoardBuildSession: mocks.revokeBuild }))
vi.mock('./OmpSession', () => ({ OmpSession: class { sendPrompt = mocks.prompt; constructor(public session: unknown, _proc: unknown, hooks: { onGone: () => void }) { mocks.gone = hooks.onGone } } }))
import { createSession, getSession, sendMessage, updateApprovalConfig } from './index'
import { beginRuntimePreparation, isRuntimePreparing } from '../runtimePreparationGate'

describe('fixed readonly session', () => {
  it('never spawns during nested installation and relinking, and recovers when both settle', async () => {
    mocks.spawn.mockImplementation(() => new EventEmitter())
    mocks.spawn.mockClear()
    const finishInstall = beginRuntimePreparation()
    const finishRelink = beginRuntimePreparation()
    const events: unknown[] = []
    try {
      expect(createSession(process.cwd(), event => events.push(event)).status).toBe('error')
      finishInstall()
      finishInstall() // A repeated cleanup must not release the relink lease.
      expect(isRuntimePreparing()).toBe(true)
      expect(createSession(process.cwd(), event => events.push(event), { origin: 'task' }).status).toBe('error')
      expect(createSession(process.cwd(), event => events.push(event), { origin: 'feishu' }).status).toBe('error')
      expect(mocks.spawn).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(events).toHaveLength(3))
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', recoverable: true })]))
    } finally {
      finishInstall()
      finishRelink()
    }
    expect(isRuntimePreparing()).toBe(false)
    expect(createSession(process.cwd(), () => {}).status).toBe('idle')
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('marks the live session and refuses approval changes without changing the global profile', () => {
    mocks.spawn.mockImplementation(() => new EventEmitter())
    const session = createSession(process.cwd(), () => {}, { permissionMode: 'readonly' })
    expect(session.readonly).toBe(true)
    expect(mocks.plan.mock.calls.at(-1)?.[2]).toMatchObject({ permissionMode: 'readonly' })
    expect(updateApprovalConfig(session.id, 'full')).toBe(false)
    expect(updateApprovalConfig(session.id, 'ask')).toBe(false)
    expect(mocks.writeApproval).not.toHaveBeenCalled()
    const normal = createSession(process.cwd(), () => {})
    expect(normal.readonly).toBeUndefined()
    expect(updateApprovalConfig(normal.id, 'ask')).toBe(true)
    expect(mocks.writeApproval).toHaveBeenCalledOnce()
  })
  it('publishes restored manual title metadata at session creation', () => {
    mocks.spawn.mockImplementation(() => new EventEmitter())
    const session = createSession(process.cwd(), () => {}, {
      resumeSessionPath: '/synthetic/session.jsonl', initialTitle: '人工保留主题',
      initialTitleMetadata: { source: 'manual', revision: 7 }
    })
    expect(session).toMatchObject({ title:'人工保留主题', titleSource:'manual', titleRevision:7 })
    expect(getSession(session.id)).toMatchObject({ titleSource:'manual', titleRevision:7 })
  })

  it('freezes only accepted original user turns and revokes their drafts when the session exits', () => {
    mocks.spawn.mockImplementation(() => new EventEmitter())
    mocks.registerBuild.mockClear(); mocks.revokeBuild.mockClear()
    const session = createSession(process.cwd(), () => {})
    const text = '只做素材或广告 ID 明细，不能用活动代替；日期跟随日报。'
    expect(sendMessage(session.id, text)).toBe(true)
    expect(mocks.registerBuild).toHaveBeenCalledWith(session.id, process.cwd(), text)
    mocks.prompt.mockReturnValueOnce(false)
    expect(sendMessage(session.id, '未发送的修改')).toBe(false)
    expect(sendMessage('missing-session', '未发送')).toBe(false)
    expect(mocks.registerBuild).toHaveBeenCalledTimes(1)
    mocks.gone?.()
    expect(mocks.revokeBuild).toHaveBeenCalledWith(session.id)
  })

})
