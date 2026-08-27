import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OperationGrantManager } from '../operationGrant'

describe('OperationGrantManager', () => {
  let base: string
  let now: number
  let grants: OperationGrantManager
  const owner = 101
  const otherOwner = 202

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-operation-grant-'))
    now = 1_000
    grants = new OperationGrantManager({ now: () => now, ttlMs: 100 })
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('mints an opaque one-use grant for a picked dataset file', async () => {
    const report = path.join(base, 'report.csv')
    fs.writeFileSync(report, 'metric\n1\n')

    const grant = await grants.mintBoardDatasetFile(report, owner)

    expect(grant).toMatchObject({ purpose: 'board-dataset-import', name: 'report.csv', createdAt: now })
    expect(grant).not.toHaveProperty('realPath')
    expect(grant).not.toHaveProperty('path')
    // A raw path is never a capability, even when it names the selected file.
    expect(await grants.consumeBoardDatasetFile(report, owner)).toBeNull()
    expect(await grants.consumeBoardDatasetFile(grant?.id, otherOwner)).toBeNull()
    expect(await grants.consumeBoardDatasetFile(grant?.id, owner)).toBe(fs.realpathSync(report))
    expect(await grants.consumeBoardDatasetFile(grant?.id, owner)).toBeNull()
  })

  it('rejects non-files and refuses a selected file that was replaced before use', async () => {
    const dir = path.join(base, 'not-a-file')
    fs.mkdirSync(dir)
    expect(await grants.mintBoardDatasetFile(dir, owner)).toBeNull()

    const report = path.join(base, 'report.csv')
    const replacement = path.join(base, 'replacement.csv')
    fs.writeFileSync(report, 'metric\n1\n')
    const grant = await grants.mintBoardDatasetFile(report, owner)
    fs.renameSync(report, replacement)
    fs.writeFileSync(report, 'metric\n999\n')

    expect(await grants.consumeBoardDatasetFile(grant?.id, owner)).toBeNull()
  })

  it('leases a picked scaffold directory and consumes it only after success', async () => {
    const parent = path.join(base, 'plugins')
    fs.mkdirSync(parent)
    const grant = await grants.mintPluginScaffoldDirectory(parent, owner)

    expect(grant).toMatchObject({ purpose: 'plugin-scaffold', name: 'plugins', createdAt: now })
    expect(grant).not.toHaveProperty('realPath')
    expect(grant).not.toHaveProperty('displayPath')
    expect(await grants.claimPluginScaffoldDirectory(parent, owner)).toBeNull()
    expect(await grants.claimPluginScaffoldDirectory(grant?.id, otherOwner)).toBeNull()
    const first = await grants.claimPluginScaffoldDirectory(grant?.id, owner)
    expect(first).toEqual({ id: grant?.id, parentDir: fs.realpathSync(parent) })
    expect(await grants.claimPluginScaffoldDirectory(grant?.id, owner)).toBeNull()

    grants.finishPluginScaffoldDirectory(first!.id, false)
    const retry = await grants.claimPluginScaffoldDirectory(grant?.id, owner)
    expect(retry).toEqual({ id: grant?.id, parentDir: fs.realpathSync(parent) })
    grants.finishPluginScaffoldDirectory(retry!.id, true)
    expect(await grants.claimPluginScaffoldDirectory(grant?.id, owner)).toBeNull()
  })

  it('permits only one concurrent scaffold claim for the same directory grant', async () => {
    const parent = path.join(base, 'plugins')
    fs.mkdirSync(parent)
    const grant = await grants.mintPluginScaffoldDirectory(parent, owner)

    const claims = await Promise.all([
      grants.claimPluginScaffoldDirectory(grant?.id, owner),
      grants.claimPluginScaffoldDirectory(grant?.id, owner)
    ])
    const acquired = claims.filter((claim): claim is NonNullable<typeof claim> => claim !== null)

    expect(acquired).toHaveLength(1)
    grants.finishPluginScaffoldDirectory(acquired[0].id, false)
  })

  it('keeps at most one pending grant of each purpose per renderer and revokes them on teardown', async () => {
    const report = path.join(base, 'report.csv')
    const firstParent = path.join(base, 'first')
    const secondParent = path.join(base, 'second')
    fs.writeFileSync(report, 'metric\n1\n')
    fs.mkdirSync(firstParent)
    fs.mkdirSync(secondParent)

    const firstFile = await grants.mintBoardDatasetFile(report, owner)
    const secondFile = await grants.mintBoardDatasetFile(report, owner)
    expect(await grants.consumeBoardDatasetFile(firstFile?.id, owner)).toBeNull()
    expect(await grants.consumeBoardDatasetFile(secondFile?.id, owner)).toBe(fs.realpathSync(report))

    const firstDirectory = await grants.mintPluginScaffoldDirectory(firstParent, owner)
    const secondDirectory = await grants.mintPluginScaffoldDirectory(secondParent, owner)
    expect(await grants.claimPluginScaffoldDirectory(firstDirectory?.id, owner)).toBeNull()
    grants.revokeOwner(owner)
    expect(await grants.claimPluginScaffoldDirectory(secondDirectory?.id, owner)).toBeNull()
  })

  it('expires grants and rejects ids outside their operation scope', async () => {
    const report = path.join(base, 'report.csv')
    const parent = path.join(base, 'plugins')
    fs.writeFileSync(report, 'metric\n1\n')
    fs.mkdirSync(parent)
    const file = await grants.mintBoardDatasetFile(report, owner)
    const directory = await grants.mintPluginScaffoldDirectory(parent, owner)

    expect(await grants.claimPluginScaffoldDirectory(file?.id, owner)).toBeNull()
    expect(await grants.consumeBoardDatasetFile(directory?.id, owner)).toBeNull()

    now += 100
    expect(await grants.consumeBoardDatasetFile(file?.id, owner)).toBeNull()
    expect(await grants.claimPluginScaffoldDirectory(directory?.id, owner)).toBeNull()
  })

  it('keeps scaffold outputs opaque, owner-bound, replaceable, and revalidated before reveal', async () => {
    const first = path.join(base, 'first-plugin')
    const replacement = path.join(base, 'replacement-plugin')
    fs.mkdirSync(first)
    fs.mkdirSync(replacement)

    const output = await grants.mintPluginScaffoldOutput(first, owner)
    expect(output).toMatchObject({ name: 'first-plugin', createdAt: now })
    expect(output).not.toHaveProperty('realPath')
    expect(output).not.toHaveProperty('path')
    expect(await grants.revealPluginScaffoldOutput(output?.id, otherOwner)).toBeNull()
    expect(await grants.revealPluginScaffoldOutput(output?.id, owner)).toBe(fs.realpathSync(first))

    const newer = await grants.mintPluginScaffoldOutput(replacement, owner)
    expect(await grants.revealPluginScaffoldOutput(output?.id, owner)).toBeNull()
    expect(await grants.revealPluginScaffoldOutput(newer?.id, owner)).toBe(fs.realpathSync(replacement))

    fs.renameSync(replacement, path.join(base, 'replacement-old'))
    fs.mkdirSync(replacement)
    expect(await grants.revealPluginScaffoldOutput(newer?.id, owner)).toBeNull()
  })

  it('leases a scaffold output for install, supports retry, consumes success, and expires', async () => {
    const plugin = path.join(base, 'plugin')
    fs.mkdirSync(plugin)
    const output = await grants.mintPluginScaffoldOutput(plugin, owner)

    const claims = await Promise.all([
      grants.claimPluginScaffoldOutputInstall(output?.id, owner),
      grants.claimPluginScaffoldOutputInstall(output?.id, owner)
    ])
    const acquired = claims.filter((claim): claim is NonNullable<typeof claim> => claim !== null)
    expect(acquired).toHaveLength(1)
    expect(await grants.claimPluginScaffoldOutputInstall(output?.id, otherOwner)).toBeNull()

    grants.finishPluginScaffoldOutputInstall(acquired[0].id, false)
    const retry = await grants.claimPluginScaffoldOutputInstall(output?.id, owner)
    expect(retry).toEqual({ id: output?.id, dir: fs.realpathSync(plugin) })
    grants.finishPluginScaffoldOutputInstall(retry!.id, true)
    expect(await grants.claimPluginScaffoldOutputInstall(output?.id, owner)).toBeNull()

    const expiring = await grants.mintPluginScaffoldOutput(plugin, owner)
    now += 100
    expect(await grants.revealPluginScaffoldOutput(expiring?.id, owner)).toBeNull()
  })
})
