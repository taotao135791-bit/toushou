import { describe, expect, it, vi } from 'vitest'

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

import { planBundledPackageAction } from '../bundledPackages'

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
