import { describe, expect, it, vi } from 'vitest'
import { createProjectVolumeIdResolver } from './projectVolumeIdentity'

const uuid = '12345678-1234-ABCD-9876-1234567890AB'
const otherUuid = '22345678-1234-abcd-9876-1234567890ab'
const df = 'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1000 400 600 40% /System/Volumes/Data\n'
const plist = (id = uuid) => `<?xml version="1.0"?><plist version="1.0"><dict><key>VolumeUUID</key><string>${id}</string></dict></plist>`

describe('persistent project volume identity', () => {
  it('queries the containing local disk with bounded argument-only commands and normalizes its UUID', () => {
    const exec = vi.fn().mockReturnValueOnce(df).mockReturnValueOnce(plist())
    const get = createProjectVolumeIdResolver({ platform: 'darwin', exec })
    expect(get('/synthetic/folder with spaces', 123)).toBe(uuid.toLowerCase())
    expect(exec.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['/bin/df', ['-P', '/synthetic/folder with spaces']],
      ['/usr/sbin/diskutil', ['info', '-plist', '/dev/disk3s5']]
    ])
    for (const [, , options] of exec.mock.calls) {
      expect(options).toMatchObject({ encoding: 'utf8', timeout: 1500, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { LC_ALL: 'C' } })
      expect(options.shell).toBeUndefined()
    }
  })
  it('does not launch disk commands on other platforms or for malformed input', () => {
    const exec = vi.fn()
    for (const platform of ['linux', 'win32'] as const) expect(createProjectVolumeIdResolver({ platform, exec })('/synthetic/project', 1)).toBeNull()
    const get = createProjectVolumeIdResolver({ platform: 'darwin', exec })
    for (const value of ['relative', '/synthetic/\nproject', '/synthetic/\0project']) expect(get(value, 1)).toBeNull()
    for (const dev of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(get('/synthetic/project', dev)).toBeNull()
    expect(exec).not.toHaveBeenCalled()
  })
  it('refuses network filesystems, malformed device nodes and ambiguous df records', () => {
    for (const output of [
      df.replace('/dev/disk3s5', 'server:/share'),
      df.replace('/dev/disk3s5', '/dev/disk3s5;echo'),
      df.replace('/dev/disk3s5', '/dev/rdisk3s5'),
      df.replace('/dev/disk3s5', '/dev/disk3/../disk4'),
      `${df}/dev/disk4 1000 400 600 40% /Volumes/Other\n`,
      'Filesystem Mounted on\n/dev/disk3s5 /System/Volumes/Data\n'
    ]) {
      const exec = vi.fn().mockReturnValue(output)
      expect(createProjectVolumeIdResolver({ platform: 'darwin', exec })('/synthetic/project', 1)).toBeNull()
      expect(exec).toHaveBeenCalledTimes(1)
    }
  })
  it('fails closed for absent, malformed or duplicate volume UUIDs and diskutil errors', () => {
    for (const output of [
      '<plist><dict></dict></plist>', plist('not-a-uuid'),
      plist().replace('</dict>', `<key>VolumeUUID</key><string>${otherUuid}</string></dict>`),
      plist().replace('<dict>', '<dict><key>Error</key><true/>')
    ]) {
      const exec = vi.fn().mockReturnValueOnce(df).mockReturnValueOnce(output)
      expect(createProjectVolumeIdResolver({ platform: 'darwin', exec })('/synthetic/project', 1)).toBeNull()
    }
  })
  it('caches successful identities per device and replaces them after a forced check', () => {
    const exec = vi.fn().mockReturnValueOnce(df).mockReturnValueOnce(plist()).mockReturnValueOnce(df).mockReturnValueOnce(plist(otherUuid))
    const get = createProjectVolumeIdResolver({ platform: 'darwin', exec })
    expect(get('/synthetic/first', 1)).toBe(uuid.toLowerCase())
    expect(get('/synthetic/second', 1)).toBe(uuid.toLowerCase())
    expect(exec).toHaveBeenCalledTimes(2)
    expect(get('/synthetic/second', 1, true)).toBe(otherUuid)
    expect(get('/synthetic/first', 1)).toBe(otherUuid)
    expect(exec).toHaveBeenCalledTimes(4)
  })
  it('briefly caches failures without retaining an old successful identity after a failed forced check', () => {
    let time = 0
    const exec = vi.fn().mockReturnValueOnce(df).mockReturnValueOnce(plist()).mockImplementationOnce(() => { throw new Error('timeout') }).mockReturnValueOnce(df).mockReturnValueOnce(plist(otherUuid))
    const get = createProjectVolumeIdResolver({ platform: 'darwin', exec, now: () => time })
    expect(get('/synthetic/project', 1)).toBe(uuid.toLowerCase())
    expect(get('/synthetic/project', 1, true)).toBeNull()
    expect(get('/synthetic/project', 1)).toBeNull()
    expect(exec).toHaveBeenCalledTimes(3)
    time = 2000
    expect(get('/synthetic/project', 1)).toBe(otherUuid)
    expect(exec).toHaveBeenCalledTimes(5)
  })
  it('isolates distinct devices and lets a forced lookup bypass the failure cache', () => {
    const exec = vi.fn().mockImplementationOnce(() => { throw new Error('maxBuffer exceeded') }).mockReturnValueOnce(df).mockReturnValueOnce(plist()).mockReturnValueOnce(df).mockReturnValueOnce(plist(otherUuid))
    const get = createProjectVolumeIdResolver({ platform: 'darwin', exec })
    expect(get('/synthetic/project', 1)).toBeNull()
    expect(get('/synthetic/project', 1)).toBeNull()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(get('/synthetic/project', 1, true)).toBe(uuid.toLowerCase())
    expect(get('/synthetic/other', 2)).toBe(otherUuid)
  })
})
