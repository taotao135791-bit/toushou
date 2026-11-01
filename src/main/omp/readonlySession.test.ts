import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ writeApproval: vi.fn(), plan: vi.fn((..._args: unknown[]) => ({})), spawn: vi.fn(() => ({})) }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../store', () => ({ getStore: (key: string) => key === 'permissionMode' ? 'ask' : 'en', rememberRecentProject: vi.fn() }))
vi.mock('./OmpCapabilities', () => ({ detectCli: () => ({ available: true, command: 'synthetic' }), noteHandshake: vi.fn(), noteSessionState: vi.fn(), noteSubagentCapabilityOutcome: vi.fn(), invalidateCliCache: vi.fn(), executableSearchDirs: vi.fn(), getCapabilities: vi.fn() }))
vi.mock('./OmpProcess', () => ({ planSpawn: mocks.plan, spawnProcess: mocks.spawn, resolvePermissionMode: () => ({ approval: 'off' }), writeApprovalConfig: mocks.writeApproval, removeApprovalConfig: vi.fn() }))
vi.mock('./OmpSession', () => ({ OmpSession: class { constructor(public session: unknown) {} } }))
import { createSession, updateApprovalConfig } from './index'

describe('fixed readonly session', () => {
  it('marks the live session and refuses approval changes without changing the global profile', () => {
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
})
