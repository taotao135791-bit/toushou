import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), sync: vi.fn(), cross: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.sync }))
vi.mock('cross-spawn', () => ({ default: Object.assign(mocks.cross, { sync: vi.fn() }) }))
import { spawnCommand } from '../command'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.clearAllMocks() })
describe('Windows CLI cancellation', () => {
  it('falls back to native kill when taskkill reports failure without throwing', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const kill = vi.fn().mockReturnValue(true)
    mocks.cross.mockReturnValue({ pid: 123, kill }); mocks.sync.mockReturnValue({ status: 1 })
    const child = spawnCommand('C:\\CLI Path\\omp.cmd', ['--mode', 'json'], {})
    expect(child.kill('SIGTERM')).toBe(true)
    expect(mocks.sync).toHaveBeenCalledWith('taskkill', ['/pid', '123', '/t', '/f'], { stdio: 'ignore' })
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })
  it('terminates the command tree without a second kill when taskkill succeeds', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const kill = vi.fn()
    mocks.cross.mockReturnValue({ pid: 456, kill }); mocks.sync.mockReturnValue({ status: 0 })
    expect(spawnCommand('C:\\CLI Path\\omp.bat', [], {}).kill()).toBe(true)
    expect(kill).not.toHaveBeenCalled()
  })
})
