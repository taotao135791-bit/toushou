import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const startup = vi.hoisted(() => ({
  events: [] as string[],
  ensure: vi.fn<() => Promise<{ ok: boolean; failed: string[] }>>(),
  windows: vi.fn(),
  registerIpc: vi.fn(),
  feishu: vi.fn(),
  updater: vi.fn(),
  ready: Promise.resolve()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: (callback: () => Promise<void>) => { startup.ready = Promise.resolve().then(callback) } }),
    on: vi.fn(),
    getVersion: () => '0.0.0-test',
    getPath: () => '/synthetic-startup-profile',
    setAppUserModelId: vi.fn()
  },
  BrowserWindow: class {
    static getAllWindows = () => []
    webContents = {}
    constructor() { startup.windows(); startup.events.push('window') }
    on() {}
    loadFile() {}
  },
  shell: { openExternal: vi.fn() }
}))
vi.mock('node:fs', () => ({ readdirSync: () => [], unlinkSync: vi.fn() }))
vi.mock('../store', () => ({ getStore: vi.fn(), setStore: vi.fn(), applyFirstRunDefaults: vi.fn() }))
vi.mock('../bundledPackages', () => ({ ensureBundledPackages: startup.ensure }))
vi.mock('../ipc', () => ({
  registerIpc: () => { startup.registerIpc(); startup.events.push('ipc-and-scheduler') },
  shutdownSessionsForQuit: vi.fn()
}))
vi.mock('../browserUse', () => ({ initBrowserUseBridge: async () => { startup.events.push('browser-bridge') } }))
vi.mock('../integrations/feishu/feishuBridge', () => ({ initFeishuBridge: async () => {} }))
vi.mock('../tasksBridge', () => ({ initTasksBridge: async () => {} }))
vi.mock('../tiktokBridge', () => ({ initTiktokBridge: async () => {} }))
vi.mock('../boardsBridge', () => ({ initBoardsBridge: async () => {} }))
vi.mock('../adsCopyBridge', () => ({ initAdsCopyBridge: async () => {} }))
vi.mock('../sessionTopicBridge', () => ({ initSessionTopicBridge: async () => {} }))
vi.mock('../kernelSkill', () => ({ ensureKernelSkill: () => ({ ok: true }) }))
vi.mock('../htmlBoards', () => ({ pruneOrphanedHtmlBoards: () => ({ ok: true }) }))
vi.mock('../htmlBoardAi', () => ({ cancelOwnerHtmlBoardAiEdits: vi.fn() }))
vi.mock('../piSettings', () => ({ syncMachineSkills: vi.fn() }))
vi.mock('../omp', () => ({ detectCli: () => ({ command: 'omp' }) }))
vi.mock('../updater', () => ({ initUpdater: startup.updater }))
vi.mock('../navigation', () => ({ installNavigationGuards: vi.fn() }))
vi.mock('../integrations/feishu/FeishuConnectionManager', () => ({
  feishuConnectionManager: { initialize: () => { startup.feishu(); startup.events.push('feishu-connect'); return Promise.resolve() } }
}))
vi.mock('../integrations/tiktok/TikTokRefreshService', () => ({ tiktokReportService: { restoreFromSettings: vi.fn() } }))
vi.mock('../lib/logger', () => ({ installFileLogging: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  startup.events.length = 0
  startup.ensure.mockReset()
  startup.windows.mockClear()
  startup.registerIpc.mockClear()
  startup.feishu.mockClear()
  startup.updater.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => { vi.restoreAllMocks() })

describe('Main startup bundled resource readiness', () => {
  it('holds interactive, scheduled and Feishu session entry points until relinking settles', async () => {
    let finish!: (result: { ok: boolean; failed: string[] }) => void
    const pending = new Promise<{ ok: boolean; failed: string[] }>(resolve => { finish = resolve })
    startup.ensure.mockImplementation(() => { startup.events.push('packages-start'); return pending })

    await import('../index')
    await vi.waitFor(() => expect(startup.ensure).toHaveBeenCalledOnce())
    expect(startup.registerIpc).not.toHaveBeenCalled()
    expect(startup.windows).not.toHaveBeenCalled()
    expect(startup.feishu).not.toHaveBeenCalled()

    startup.events.push('packages-ready')
    finish({ ok: true, failed: [] })
    await startup.ready

    expect(startup.events).toEqual(['browser-bridge', 'packages-start', 'packages-ready', 'ipc-and-scheduler', 'window', 'feishu-connect'])
    expect(startup.updater).toHaveBeenCalledOnce()
  })

  it('reports a failed preparation and keeps the general GUI available after the attempt', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('synthetic package probe unavailable')
    startup.ensure.mockRejectedValue(failure)

    await import('../index')
    await startup.ready

    expect(warning).toHaveBeenCalledWith('[bundled-packages] startup preparation failed', failure)
    expect(startup.registerIpc).toHaveBeenCalledOnce()
    expect(startup.windows).toHaveBeenCalledOnce()
    expect(startup.feishu).toHaveBeenCalledOnce()
  })

  it('warns when the bounded preparation resolves incomplete without disabling general sessions', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    startup.ensure.mockResolvedValue({ ok: false, failed: ['toushou-boards-toolkit'] })

    await import('../index')
    await startup.ready

    expect(warning).toHaveBeenCalledWith('[bundled-packages] startup preparation incomplete', ['toushou-boards-toolkit'])
    expect(startup.registerIpc).toHaveBeenCalledOnce()
    expect(startup.windows).toHaveBeenCalledOnce()
  })
})
