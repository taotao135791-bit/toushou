import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  packaged: true,
  version: '2.0.2',
  adHoc: false,
  metadata: { status: 200, version: '2.0.2' },
  handlers: new Map<string, Array<(value?: any) => void>>(),
  send: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  get: vi.fn(),
  open: vi.fn()
}))
const emit = (event: string, value?: unknown) => { for (const handler of mocks.handlers.get(event) ?? []) handler(value) }
vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.packaged }, getVersion: () => mocks.version },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
  shell: { openExternal: mocks.open }
}))
vi.mock('node:child_process', () => ({
  spawnSync: () => ({ stdout: '', stderr: mocks.adHoc ? 'Signature=adhoc' : 'TeamIdentifier=SYNTHETIC' }),
  execFile: vi.fn(), spawn: vi.fn()
}))
vi.mock('electron-updater', () => ({ autoUpdater: {
  on: (event: string, callback: (value?: unknown) => void) => { mocks.handlers.set(event, [...(mocks.handlers.get(event) ?? []), callback]) },
  checkForUpdates: mocks.check, downloadUpdate: mocks.download, quitAndInstall: mocks.install,
  autoDownload: true, autoInstallOnAppQuit: true
} }))
vi.mock('node:https', () => ({ default: { get: mocks.get } }))

let updater: typeof import('../updater')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.packaged = true
  mocks.version = '2.0.2'
  mocks.adHoc = false
  mocks.metadata = { status: 200, version: '2.0.2' }
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  mocks.check.mockImplementation(async () => { emit('checking-for-update'); emit('update-not-available') })
  mocks.download.mockResolvedValue([])
  mocks.get.mockImplementation((_url, _options, callback) => {
    const listeners = new Map<string, (value?: unknown) => void>()
    const response = {
      statusCode: mocks.metadata.status, headers: {}, setEncoding: vi.fn(), resume: vi.fn(),
      on: (event: string, handler: (value?: unknown) => void) => { listeners.set(event, handler) }
    }
    void Promise.resolve().then(() => {
      callback(response)
      listeners.get('data')?.(JSON.stringify({ version: mocks.metadata.version, files: [{ url: `TouShou-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip` }] }))
      listeners.get('end')?.()
    })
    return { on: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() }
  })
  updater = await import('../updater')
})
afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', platform)
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('startup update checks', () => {
  it.each(['darwin', 'win32'] as const)('keeps the beta %s profile off every stable updater entry point', async platform => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    vi.stubEnv('TOUSHOU_RELEASE_CHANNEL', 'beta')
    mocks.version = '2.4.0-beta.1'
    updater.initUpdater()
    expect(mocks.handlers.size).toBe(0)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(await updater.updaterCheck(false)).toEqual({ status: 'idle' })
    expect(await updater.updaterCheck()).toMatchObject({ status: 'error', operation: 'check', message: expect.stringContaining('Beta') })
    expect(await updater.updaterDownload()).toMatchObject({ status: 'error', operation: 'download' })
    updater.updaterQuitAndInstall()
    expect(updater.getUpdaterStatus()).toMatchObject({ status: 'error', operation: 'install' })
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
    await updater.updaterOpenReleasePage()
    expect(mocks.open).toHaveBeenCalledWith('https://github.com/taotao135791-bit/toushou/releases/tag/beta-v2.4.0-beta.1')
  })

  it('also blocks stable update actions by the packaged beta version if its environment flag is missing', async () => {
    mocks.version = '2.4.0-beta.2'
    expect(await updater.updaterDownload()).toMatchObject({ status: 'error', operation: 'download' })
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('checks every packaged launch and periodically without downloading or announcing no update', async () => {
    updater.initUpdater()
    updater.initUpdater()
    await vi.advanceTimersByTimeAsync(9999)
    expect(mocks.check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.check).toHaveBeenCalledTimes(1)
    expect(updater.getUpdaterStatus()).toEqual({ status: 'idle' })
    expect(mocks.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(mocks.check).toHaveBeenCalledTimes(2)
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
    const { autoUpdater } = await import('electron-updater')
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('keeps a failed background check quiet but reports a manual failure', async () => {
    mocks.check.mockImplementation(async () => { emit('checking-for-update'); emit('error', new Error('HTTP 503')); throw new Error('HTTP 503') })
    updater.initUpdater()
    await vi.advanceTimersByTimeAsync(10000)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(updater.getUpdaterStatus()).toEqual({ status: 'idle' })
    expect(await updater.updaterCheck()).toMatchObject({ status: 'error', operation: 'check', message: 'HTTP 503' })
  })

  it('retries a transient startup failure without showing its intermediate error', async () => {
    mocks.check.mockImplementationOnce(async () => { emit('error', new Error('net::ERR_NETWORK_CHANGED')); throw new Error('net::ERR_NETWORK_CHANGED') })
    updater.initUpdater()
    await vi.advanceTimersByTimeAsync(10000)
    expect(mocks.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.check).toHaveBeenCalledTimes(2)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(updater.getUpdaterStatus()).toEqual({ status: 'idle' })
  })

  it('announces a new release and retains it through older metadata or a failed check', async () => {
    mocks.check.mockImplementation(async () => { emit('checking-for-update'); emit('update-available', { version: '2.1.0' }) })
    updater.initUpdater()
    await vi.advanceTimersByTimeAsync(10000)
    expect(updater.getUpdaterStatus()).toEqual({ status: 'available', version: '2.1.0' })
    mocks.check.mockImplementation(async () => { emit('checking-for-update'); emit('update-not-available') })
    expect(await updater.updaterCheck()).toEqual({ status: 'available', version: '2.1.0' })
    mocks.check.mockImplementation(async () => { emit('update-available', { version: '2.0.3' }) })
    expect(await updater.updaterCheck()).toEqual({ status: 'available', version: '2.1.0' })
    mocks.check.mockRejectedValue(new Error('HTTP 503'))
    expect(await updater.updaterCheck()).toMatchObject({ status: 'error', operation: 'check' })
    expect(updater.getUpdaterStatus()).toEqual({ status: 'available', version: '2.1.0' })
  })

  it('lets a manual check join the startup request and receive its result', async () => {
    let finish!: () => void
    mocks.check.mockImplementation(() => new Promise<void>(resolve => { emit('checking-for-update'); finish = () => { emit('update-not-available'); resolve() } }))
    updater.initUpdater()
    await vi.advanceTimersByTimeAsync(10000)
    const manual = updater.updaterCheck()
    expect(updater.getUpdaterStatus()).toEqual({ status: 'checking' })
    finish()
    expect(await manual).toEqual({ status: 'none' })
    expect(mocks.check).toHaveBeenCalledTimes(1)
  })

  it('does not let a late check replace a user download or its downloaded state', async () => {
    updater.initUpdater()
    emit('update-available', { version: '2.1.0' })
    let finishCheck!: () => void
    mocks.check.mockImplementation(() => new Promise<void>(resolve => { finishCheck = () => { emit('update-not-available'); resolve() } }))
    const checking = updater.updaterCheck()
    let finishDownload!: () => void
    mocks.download.mockImplementation(() => new Promise<void>(resolve => { finishDownload = () => { emit('update-downloaded', { version: '2.1.0' }); resolve() } }))
    const downloading = updater.updaterDownload()
    emit('download-progress', { percent: 45 })
    emit('error', new Error('Late check failure'))
    finishCheck()
    expect(await checking).toEqual({ status: 'progress', percent: 45 })
    finishDownload()
    expect(await downloading).toEqual({ status: 'downloaded', version: '2.1.0' })
    expect(await updater.updaterCheck()).toEqual({ status: 'downloaded', version: '2.1.0' })
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('identifies an explicitly requested download failure', async () => {
    updater.initUpdater()
    mocks.download.mockRejectedValue(new Error('HTTP 503'))
    expect(await updater.updaterDownload()).toMatchObject({ status: 'error', operation: 'download' })
  })

  it('reports an explicitly requested install failure', () => {
    updater.initUpdater()
    emit('update-downloaded', { version: '2.1.0' })
    updater.updaterQuitAndInstall()
    emit('error', new Error('Synthetic installation failure'))
    expect(updater.getUpdaterStatus()).toMatchObject({ status: 'error', operation: 'install' })
  })

  it.each([['2.0.2', 200, false], ['2.1.0', 503, false], ['2.1.0', 200, true]] as const)('checks unsigned macOS builds silently (%s / HTTP %s)', async (version, status, available) => {
    mocks.adHoc = true
    mocks.metadata = { version, status }
    updater.initUpdater()
    await vi.advanceTimersByTimeAsync(10000)
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(updater.getUpdaterStatus()).toEqual(available ? { status: 'available', version } : { status: 'idle' })
    expect(mocks.send).toHaveBeenCalledTimes(available ? 1 : 0)
    if (!available) expect(await updater.updaterCheck()).toMatchObject({ status: status === 200 ? 'none' : 'error' })
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('does not initialize or check updates in development', async () => {
    mocks.packaged = false
    updater.initUpdater()
    await vi.advanceTimersByTimeAsync(10000)
    expect(await updater.updaterCheck()).toEqual({ status: 'dev' })
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
  })
})
