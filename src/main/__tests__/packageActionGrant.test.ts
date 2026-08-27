import { beforeEach, describe, expect, it } from 'vitest'
import { PackageInfo, PackageManagerProfile } from '../../shared/types'
import {
  matchesPackageActionTarget,
  PackageActionGrantManager
} from '../packageActionGrant'

let now: number
let grants: PackageActionGrantManager

const owner = 41
const otherOwner = 42
const profile: PackageManagerProfile = 'current'

function packageRow(overrides: Partial<PackageInfo> = {}): PackageInfo {
  return {
    source: 'git:github.com/acme/private-plugin',
    commandSource: 'private-plugin@acme-marketplace',
    scope: 'project',
    kind: 'marketplace',
    name: 'Private plugin',
    description: 'Runs project checks',
    version: '1.2.3',
    enabled: true,
    path: '/Users/example/.omp/agent/plugins/private-plugin',
    resources: [{ type: 'extension', name: 'check' }],
    pinned: false,
    canUpdate: true,
    ...overrides
  }
}

function snapshot(rows: PackageInfo[] = [packageRow()], ownerWebContentsId = owner) {
  return grants.mintSnapshot(rows, { ownerWebContentsId, profile })
}

beforeEach(() => {
  now = 1_000
  grants = new PackageActionGrantManager({ now: () => now, ttlMs: 100 })
})

describe('PackageActionGrantManager', () => {
  it('maps a Main-only package row to a path-free opaque descriptor', () => {
    const [descriptor] = snapshot()

    expect(descriptor).toEqual({
      id: expect.stringMatching(/^package-action-[0-9a-f-]{36}$/),
      kind: 'marketplace',
      name: 'Private plugin',
      description: 'Runs project checks',
      version: '1.2.3',
      enabled: true,
      resources: [{ type: 'extension', name: 'check' }],
      pinned: false,
      canUpdate: true
    })
    expect(descriptor).not.toHaveProperty('source')
    expect(descriptor).not.toHaveProperty('commandSource')
    expect(descriptor).not.toHaveProperty('scope')
    expect(descriptor).not.toHaveProperty('profile')
    expect(descriptor).not.toHaveProperty('path')
    expect(JSON.stringify(descriptor)).not.toContain('/Users/example')
  })

  it('keeps the raw command target Main-only and copies returned data', () => {
    const input = packageRow()
    const [descriptor] = snapshot([input])
    descriptor.resources[0].name = 'renderer-mutated'

    const lease = grants.claimPackageAction(descriptor.id, owner)

    expect(lease?.descriptor.resources).toEqual([{ type: 'extension', name: 'check' }])
    expect(lease?.target).toEqual({
      source: 'git:github.com/acme/private-plugin',
      commandSource: 'private-plugin@acme-marketplace',
      scope: 'project',
      profile: 'current'
    })
    input.resources[0].name = 'main-input-mutated'
    expect(lease?.target.source).toBe('git:github.com/acme/private-plugin')
    grants.finishPackageAction(lease!.id, false)
  })

  it('derives an installed-badge key without exposing a git URL or credentials', () => {
    const [descriptor] = snapshot([
      packageRow({
        source: 'https://token:secret@github.com/acme/check-plugin.git@v1',
        commandSource: undefined,
        kind: 'git'
      })
    ])

    expect(descriptor.marketplaceKey).toBe('github:acme/check-plugin')
    expect(JSON.stringify(descriptor)).not.toContain('token')
    expect(JSON.stringify(descriptor)).not.toContain('secret')
    expect(JSON.stringify(descriptor)).not.toContain('github.com')
  })

  it('binds descriptors to the renderer that listed them', () => {
    const [descriptor] = snapshot()

    expect(grants.claimPackageAction(descriptor.id, otherOwner)).toBeNull()
    expect(grants.claimPackageAction(descriptor.id, owner)).not.toBeNull()
  })

  it('expires descriptors and revokes all descriptors for a destroyed renderer', () => {
    const [expiring] = snapshot()
    now += 100
    expect(grants.claimPackageAction(expiring.id, owner)).toBeNull()

    const [owned] = snapshot()
    const [other] = snapshot([packageRow({ source: 'npm:other' })], otherOwner)
    grants.revokeOwner(owner)

    expect(grants.claimPackageAction(owned.id, owner)).toBeNull()
    expect(grants.claimPackageAction(other.id, otherOwner)).not.toBeNull()
  })

  it('allows only one in-flight action, permits failure retry, and consumes success', () => {
    const [descriptor] = snapshot()
    const first = grants.claimPackageAction(descriptor.id, owner)

    expect(first).not.toBeNull()
    expect(grants.claimPackageAction(descriptor.id, owner)).toBeNull()

    grants.finishPackageAction(first!.id, false)
    const retry = grants.claimPackageAction(descriptor.id, owner)
    expect(retry).not.toBeNull()

    grants.finishPackageAction(retry!.id, true)
    expect(grants.claimPackageAction(descriptor.id, owner)).toBeNull()
  })

  it('revokes stale ids when a package-list refresh replaces the snapshot', () => {
    const [first] = snapshot([packageRow({ source: 'npm:first', commandSource: undefined })])
    const [second] = snapshot([packageRow({ source: 'npm:second', commandSource: undefined })])

    expect(grants.claimPackageAction(first.id, owner)).toBeNull()
    const lease = grants.claimPackageAction(second.id, owner)
    expect(lease?.target.source).toBe('npm:second')
  })

  it('requires exact profile, source, command source, and scope during revalidation', () => {
    const [descriptor] = snapshot()
    const lease = grants.claimPackageAction(descriptor.id, owner)
    const current = packageRow()

    expect(matchesPackageActionTarget(lease!.target, current, 'current')).toBe(true)
    expect(
      matchesPackageActionTarget(lease!.target, { ...current, scope: 'user' }, 'current')
    ).toBe(false)
    expect(
      matchesPackageActionTarget(lease!.target, { ...current, commandSource: 'other' }, 'current')
    ).toBe(false)
    expect(matchesPackageActionTarget(lease!.target, current, 'legacy')).toBe(false)

    grants.finishPackageAction(lease!.id, false)
  })
})
