import { describe, expect, it, vi, beforeEach } from 'vitest'

// The runner shells out to the CLI and touches the electron store; only the
// pure planner is under test here.
vi.mock('../packages', () => ({
  listPackages: vi.fn(async () => []),
  linkLocalPackage: vi.fn(async () => ({ ok: true }))
}))
vi.mock('../store', () => ({
  getStore: vi.fn(() => undefined),
  setStore: vi.fn()
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => './'
  }
}))

import { listPackages, linkLocalPackage } from '../packages'
import { getStore, setStore } from '../store'
import {
  BUNDLED_PACKAGES,
  ensureBundledPackages,
  planBundledPackageAction,
  readBundledPackageVersion
} from '../bundledPackages'

const mockList = vi.mocked(listPackages)
const mockLink = vi.mocked(linkLocalPackage)
const mockGet = vi.mocked(getStore)
const mockSet = vi.mocked(setStore)

describe('planBundledPackageAction', () => {
  it('links a package the app has never linked and the runtime does not list', () => {
    expect(
      planBundledPackageAction({ installed: false, userRemoved: false }, '0.1.0')
    ).toBe('link')
  })

  it('skips when the runtime lists the linked version', () => {
    expect(
      planBundledPackageAction(
        { installed: true, linkedVersion: '0.1.0', userRemoved: false },
        '0.1.0'
      )
    ).toBe('skip')
  })

  it('stamps a newer bundled version without re-linking when the package is present', () => {
    expect(
      planBundledPackageAction(
        { installed: true, linkedVersion: '0.1.0', userRemoved: false },
        '0.2.0'
      )
    ).toBe('mark')
    // Also when the stamp is missing entirely (package was installed by hand).
    expect(planBundledPackageAction({ installed: true, userRemoved: false }, '0.1.0')).toBe('mark')
  })

  it('records user removal when a previously linked package disappears', () => {
    expect(
      planBundledPackageAction(
        { installed: false, linkedVersion: '0.1.0', userRemoved: false },
        '0.1.0'
      )
    ).toBe('note-removed')
  })

  it('never re-adds a package the user removed', () => {
    expect(
      planBundledPackageAction(
        { installed: false, linkedVersion: '0.1.0', userRemoved: true },
        '0.2.0'
      )
    ).toBe('skip')
  })

  it('does nothing when the bundled manifest is unreadable', () => {
    expect(planBundledPackageAction({ installed: false, userRemoved: false }, null)).toBe('skip')
    expect(
      planBundledPackageAction({ installed: true, linkedVersion: '0.1.0', userRemoved: false }, null)
    ).toBe('skip')
  })
})

describe('ensureBundledPackages', () => {
  const firstPkg = BUNDLED_PACKAGES[0]
  const firstVersion = readBundledPackageVersion(firstPkg.resourceDir)

  beforeEach(() => {
    mockList.mockReset()
    mockGet.mockReset().mockReturnValue(undefined as never)
    mockSet.mockReset()
  })

  it('never infers removal from a failed package listing', async () => {
    // Cold-start CLI timeout: the listing throws. Previously every bundled
    // package was stamped userRemoved=true by this path.
    mockList.mockRejectedValue(new Error('spawn timeout'))
    mockGet.mockReturnValue({
      [firstPkg.name]: { version: firstVersion ?? '0.1.0', userRemoved: false }
    })
    await ensureBundledPackages()
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('still records removal when a listing succeeds without the package', async () => {
    mockList.mockResolvedValue([])
    mockGet.mockReturnValue({
      [firstPkg.name]: { version: firstVersion ?? '0.1.0', userRemoved: false }
    })
    await ensureBundledPackages()
    expect(mockSet).toHaveBeenCalledTimes(1)
    const record = mockSet.mock.calls[0][1] as Record<string, { userRemoved: boolean }>
    expect(record[firstPkg.name].userRemoved).toBe(true)
  })

  it('links a package the successful listing does not know yet', async () => {
    mockList.mockResolvedValue([])
    mockGet.mockReturnValue(undefined as never)
    await ensureBundledPackages()
    const record = mockSet.mock.calls[0][1] as Record<string, { userRemoved: boolean }>
    expect(record[firstPkg.name].userRemoved).toBe(false)
  })

  it('relinks our own stale link when the bundle carries a newer toolkit', async () => {
    // The old 'stamp-only' behavior left agents running stale tools forever.
    mockLink.mockClear()
    mockList.mockResolvedValue([{ name: firstPkg.name } as never])
    mockGet.mockReturnValue({
      [firstPkg.name]: { version: '0.0.1', userRemoved: false }
    })
    await ensureBundledPackages()
    expect(mockLink).toHaveBeenCalled()
    const record = mockSet.mock.calls[0][1] as Record<string, { version: string }>
    expect(record[firstPkg.name].version).toBe(firstVersion)
  })

  it('never touches a same-named package the app did not link itself', async () => {
    mockLink.mockClear()
    mockList.mockResolvedValue([{ name: firstPkg.name } as never])
    // No record = someone else installed this name; a relink would stomp it.
    mockGet.mockReturnValue(undefined as never)
    await ensureBundledPackages()
    const firstPath = JSON.stringify(firstPkg.resourceDir)
    expect(mockLink.mock.calls.some((call) => JSON.stringify(call[0]).includes(firstPath))).toBe(false)
  })
})
