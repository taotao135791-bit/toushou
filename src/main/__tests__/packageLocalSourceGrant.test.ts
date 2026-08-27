import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PackageLocalSourceGrantManager } from '../packageLocalSourceGrant'

let root: string
let now: number
let grants: PackageLocalSourceGrantManager

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-package-source-'))
  now = 1_000
  grants = new PackageLocalSourceGrantManager({ now: () => now, ttlMs: 100 })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function makeFile(name = 'plugin.ts'): string {
  const file = path.join(root, name)
  fs.writeFileSync(file, 'export default {}')
  return file
}

describe('PackageLocalSourceGrantManager', () => {
  it('returns a path-free descriptor for a native local source selection', async () => {
    const file = makeFile()
    const grant = await grants.mint(file, 41)

    expect(grant).toEqual({
      id: expect.stringMatching(/^package-local-source-[0-9a-f-]{36}$/),
      purpose: 'package-local-install',
      name: 'plugin.ts',
      kind: 'file',
      createdAt: 1_000
    })
    expect(JSON.stringify(grant)).not.toContain(root)
  })

  it('binds a selection to its renderer and leases only one install at a time', async () => {
    const grant = await grants.mint(makeFile(), 41)
    const first = await grants.claim(grant!.id, 41)

    expect(await grants.claim(grant!.id, 42)).toBeNull()
    expect(await grants.claim(grant!.id, 41)).toBeNull()
    expect(await grants.resolveClaimedPath(first!.id, 41)).toContain('plugin.ts')

    grants.finish(first!.id, false)
    expect(await grants.claim(grant!.id, 41)).not.toBeNull()
  })

  it('rejects a source replaced after it was selected or while awaiting confirmation', async () => {
    const file = makeFile()
    const grant = await grants.mint(file, 41)
    const lease = await grants.claim(grant!.id, 41)
    fs.renameSync(file, `${file}.old`)
    fs.writeFileSync(file, 'replacement')

    await expect(grants.resolveClaimedPath(lease!.id, 41)).resolves.toBeNull()
    grants.finish(lease!.id, false)
    await expect(grants.claim(grant!.id, 41)).resolves.toBeNull()
  })

  it('expires, replaces prior owner selections, and revokes on owner teardown', async () => {
    const first = await grants.mint(makeFile('first.ts'), 41)
    const second = await grants.mint(makeFile('second.ts'), 41)
    await expect(grants.claim(first!.id, 41)).resolves.toBeNull()

    now += 100
    await expect(grants.claim(second!.id, 41)).resolves.toBeNull()

    const active = await grants.mint(makeFile('active.ts'), 41)
    grants.revokeOwner(41)
    await expect(grants.claim(active!.id, 41)).resolves.toBeNull()
  })

  it('keeps a selected directory canonical and Main-only', async () => {
    const directory = path.join(root, 'plugin-dir')
    fs.mkdirSync(directory)
    const grant = await grants.mint(directory, 41)
    const lease = await grants.claim(grant!.id, 41)

    expect(grant).toMatchObject({ name: 'plugin-dir', kind: 'directory' })
    expect(await grants.resolveClaimedPath(lease!.id, 41)).toBe(fs.realpathSync(directory))
  })
})
