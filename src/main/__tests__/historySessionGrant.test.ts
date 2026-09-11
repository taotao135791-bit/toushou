import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// sessionHistory.ts reaches piSettings.ts for the default agent directory.
// Every test passes a dedicated agentDir, so keep this suite Electron/CLI-free.
vi.mock('../omp', () => ({
  detectCli: () => ({ command: 'pi', path: '/usr/local/bin/pi', available: true }),
  executableSearchDirs: () => []
}))

import {
  HistorySessionGrantContext,
  HistorySessionGrantManager
} from '../historySessionGrant'
import { HistorySessionFile, sessionDirFor } from '../sessionHistory'
import { expectSamePath } from './pathAssertions'

let agentDir: string
let workspaceA: string
let workspaceB: string
let now: number
let manager: HistorySessionGrantManager

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-history-agent-'))
  workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-history-a-'))
  workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-history-b-'))
  now = 1_000
  manager = new HistorySessionGrantManager({ agentDir, now: () => now, ttlMs: 100 })
})

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true })
  fs.rmSync(workspaceA, { recursive: true, force: true })
  fs.rmSync(workspaceB, { recursive: true, force: true })
})

function context(
  workspaceGrantId = 'workspace-a',
  ownerWebContentsId = 41,
  workspaceRealPath = fs.realpathSync(workspaceA)
): HistorySessionGrantContext {
  return { workspaceGrantId, workspaceRealPath, ownerWebContentsId }
}

function writeSession(workspace: string, name = 'session.jsonl'): string {
  const directory = sessionDirFor(workspace, agentDir)
  fs.mkdirSync(directory, { recursive: true })
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, '{"type":"session"}\n')
  return filePath
}

function history(filePath: string, uuid = 'session-uuid'): HistorySessionFile {
  return {
    uuid,
    filePath,
    title: 'Resume this session',
    timestamp: 123,
    cwd: workspaceA
  }
}

describe('HistorySessionGrantManager', () => {
  it('carries the annotated origin into minted descriptors', async () => {
    const badgedFile = writeSession(workspaceA, 'badged.jsonl')
    const plainFile = writeSession(workspaceA, 'plain.jsonl')
    const [badged, plain] = await manager.mintForWorkspace(
      [
        { ...history(badgedFile), origin: 'feishu' },
        history(plainFile, 'session-uuid-2')
      ],
      context()
    )
    expect(badged.origin).toBe('feishu')
    expect(plain).not.toHaveProperty('origin')
  })

  it('mints a path-free descriptor and resolves it only for the listing sender and workspace grant', async () => {
    const filePath = writeSession(workspaceA)
    const [descriptor] = await manager.mintForWorkspace([history(filePath)], context())

    expect(descriptor).toMatchObject({
      id: expect.stringMatching(/^history-session-[0-9a-f-]{36}$/),
      uuid: 'session-uuid',
      title: 'Resume this session',
      timestamp: 123
    })
    expect(descriptor).not.toHaveProperty('filePath')
    expect(descriptor).not.toHaveProperty('cwd')
    expectSamePath(await manager.resolve(descriptor.id, context()), fs.realpathSync(filePath))
    await expect(manager.resolve(descriptor.id, context('workspace-b'))).resolves.toBeNull()
    await expect(manager.resolve(descriptor.id, context('workspace-a', 42))).resolves.toBeNull()
    await expect(manager.resolve(descriptor.id, context('workspace-a', 41, fs.realpathSync(workspaceB)))).resolves.toBeNull()
  })

  it('never mints a capability for a session located in another workspace directory', async () => {
    const otherWorkspaceFile = writeSession(workspaceB)
    await expect(manager.mintForWorkspace([history(otherWorkspaceFile)], context())).resolves.toEqual([])
  })

  it('revokes the prior opaque id when the same renderer refreshes history', async () => {
    const filePath = writeSession(workspaceA)
    const [first] = await manager.mintForWorkspace([history(filePath)], context())
    const [refreshed] = await manager.mintForWorkspace([history(filePath)], context())

    expect(refreshed.id).not.toBe(first.id)
    await expect(manager.resolve(first.id, context())).resolves.toBeNull()
    expectSamePath(await manager.resolve(refreshed.id, context()), fs.realpathSync(filePath))
  })

  it('rejects a session-directory symlink that escapes the canonical agent sessions root', async () => {
    const expectedDirectory = sessionDirFor(workspaceA, agentDir)
    const outsideDirectory = path.join(agentDir, 'outside')
    fs.mkdirSync(path.dirname(expectedDirectory), { recursive: true })
    fs.mkdirSync(outsideDirectory)
    fs.symlinkSync(outsideDirectory, expectedDirectory)
    const escapedPath = path.join(expectedDirectory, 'escaped.jsonl')
    fs.writeFileSync(path.join(outsideDirectory, 'escaped.jsonl'), '{"type":"session"}\n')

    await expect(manager.mintForWorkspace([history(escapedPath)], context())).resolves.toEqual([])
  })

  it('revokes a grant when its canonical file identity changes', async () => {
    const filePath = writeSession(workspaceA)
    const [descriptor] = await manager.mintForWorkspace([history(filePath)], context())
    // Keep the original inode allocated so the replacement cannot reuse it.
    fs.renameSync(filePath, `${filePath}.original`)
    fs.writeFileSync(filePath, '{"type":"session","replacement":true}\n')

    let operationCalled = false
    await expect(
      manager.withResolved(descriptor.id, context(), async () => {
        operationCalled = true
        return true
      })
    ).resolves.toBeNull()
    expect(operationCalled).toBe(false)
    await expect(manager.resolve(descriptor.id, context())).resolves.toBeNull()
  })

  it('slides the TTL when every binding revalidates, but revokes by owner or workspace', async () => {
    const filePath = writeSession(workspaceA)
    const [expired] = await manager.mintForWorkspace([history(filePath)], context())
    now += 100
    // Pure TTL expiry no longer breaks a row the user can still open: the
    // full binding chain (owner/workspace/inode/uuid/dirs) revalidates, so
    // the capability slides forward and resolves.
    expectSamePath(await manager.resolve(expired.id, context()), fs.realpathSync(filePath))
    expectSamePath(await manager.resolve(expired.id, context()), fs.realpathSync(filePath))

    const [ownerRevoked] = await manager.mintForWorkspace([history(filePath)], context())
    manager.revokeOwner(41)
    await expect(manager.resolve(ownerRevoked.id, context())).resolves.toBeNull()

    const [workspaceRevoked] = await manager.mintForWorkspace([history(filePath)], context())
    manager.revokeWorkspace('workspace-a')
    await expect(manager.resolve(workspaceRevoked.id, context())).resolves.toBeNull()
  })

  it('deleteStale still sweeps an expired capability bound to the same session', async () => {
    const UUID = '01234567-89ab-cdef-0123-456789abcdef'
    const directory = sessionDirFor(workspaceA, agentDir)
    fs.mkdirSync(directory, { recursive: true })
    const filePath = path.join(directory, 'expired_delete.jsonl')
    fs.writeFileSync(filePath, `{"type":"session","id":"${UUID}"}\n`)
    const [expired] = await manager.mintForWorkspace([history(filePath, UUID)], context())
    now += 100
    await expect(manager.deleteStale(expired.id, context())).resolves.toBe(true)
    expect(fs.existsSync(filePath)).toBe(false)
    await expect(manager.resolve(expired.id, context())).resolves.toBeNull()
  })

  it('serializes a history capability through one revalidated Main-only operation', async () => {
    const filePath = writeSession(workspaceA)
    const [descriptor] = await manager.mintForWorkspace([history(filePath)], context())
    let release: (() => void) | undefined
    const first = manager.withResolved(descriptor.id, context(), async (resolvedFilePath) => {
      expectSamePath(resolvedFilePath, fs.realpathSync(filePath))
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return true
    })

    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(manager.withResolved(descriptor.id, context(), async () => true)).resolves.toBeNull()
    release?.()
    await expect(first).resolves.toBe(true)
  })
})

/**
 * omp resume rewrites the session file in place (fork bookkeeping): the row's
 * dev/ino identity drifts while the header uuid may or may not change. Resume
 * must self-heal on a same-uuid rewrite, and delete must still work through a
 * uuid sweep when the inode pin can no longer match.
 */
describe('HistorySessionGrantManager rewritten files', () => {
  const UUID = '01234567-89ab-cdef-0123-456789abcdef'

  function writeHeaderedSession(uuid: string, name: string): string {
    const directory = sessionDirFor(workspaceA, agentDir)
    fs.mkdirSync(directory, { recursive: true })
    const filePath = path.join(directory, name)
    fs.writeFileSync(filePath, `{"type":"session","id":"${uuid}"}\n`)
    return filePath
  }

  it('self-heals the identity when the runtime rewrites the file with the same uuid', async () => {
    const filePath = writeHeaderedSession(UUID, 'rewritten_same.jsonl')
    const [descriptor] = await manager.mintForWorkspace([history(filePath, UUID)], context())
    // Keep the old inode allocated, replace the file (fork rewrite).
    fs.renameSync(filePath, `${filePath}.original`)
    fs.writeFileSync(filePath, `{"type":"title","v":1}\n{"type":"session","id":"${UUID}"}\n`)

    await expectSamePath(await manager.resolve(descriptor.id, context()), fs.realpathSync(filePath))
  })

  it('still revokes when the rewrite carried a different uuid (superseded row)', async () => {
    const filePath = writeHeaderedSession(UUID, 'rewritten_new.jsonl')
    const [descriptor] = await manager.mintForWorkspace([history(filePath, UUID)], context())
    const nextUuid = '99999999-9999-9999-9999-999999999999'
    fs.renameSync(filePath, `${filePath}.original`)
    fs.writeFileSync(filePath, `{"type":"session","id":"${nextUuid}"}\n`)

    await expect(manager.resolve(descriptor.id, context())).resolves.toBeNull()
  })

  it('deleteStale removes a row whose file was rewritten in place', async () => {
    const filePath = writeHeaderedSession(UUID, 'stale_delete.jsonl')
    const [descriptor] = await manager.mintForWorkspace([history(filePath, UUID)], context())
    fs.rmSync(filePath)
    // withResolved fails (file gone); the uuid sweep must still retire the row.
    await expect(
      manager.withResolved(descriptor.id, context(), async () => true)
    ).resolves.toBeNull()
    await expect(manager.deleteStale(descriptor.id, context())).resolves.toBe(true)
    await expect(manager.resolve(descriptor.id, context())).resolves.toBeNull()
  })

  it('deleteStale still enforces the owner/workspace binding', async () => {
    const filePath = writeHeaderedSession(UUID, 'stale_binding.jsonl')
    const [descriptor] = await manager.mintForWorkspace([history(filePath, UUID)], context())
    fs.rmSync(filePath)
    await expect(manager.deleteStale(descriptor.id, context('workspace-b'))).resolves.toBe(false)
    await expect(manager.deleteStale(descriptor.id, context('workspace-a', 99))).resolves.toBe(false)
  })
})

/**
 * Workspace-independent delete: cross-project history rows carry only a uuid —
 * never a capability minted for the active workspace — so restoring-failed and
 * foreign-project rows must be deletable by uuid alone. The manager resolves
 * and deletes EVERY layout copy Main-side and revokes matching capabilities.
 */
describe('HistorySessionGrantManager.deleteByUuid', () => {
  const UUID = '01234567-89ab-cdef-0123-456789abcdef'

  function writeSessionWithHeader(workspace: string, uuid: string, name: string): string {
    const directory = sessionDirFor(workspace, agentDir)
    fs.mkdirSync(directory, { recursive: true })
    const filePath = path.join(directory, name)
    fs.writeFileSync(filePath, `{"type":"session","id":"${uuid}"}\n`)
    return filePath
  }

  it('deletes every layout copy across workspaces and revokes minted capabilities', async () => {
    const fileA = writeSessionWithHeader(workspaceA, UUID, `a_${UUID}.jsonl`)
    // A legacy-layout copy of the same durable session under ANOTHER
    // workspace's directory (e.g. after the project moved).
    const fileB = writeSessionWithHeader(workspaceB, UUID, `b_${UUID}.jsonl`)
    const [descriptor] = await manager.mintForWorkspace([history(fileA, UUID)], context())

    await expect(manager.deleteByUuid(UUID)).resolves.toBe(true)
    expect(fs.existsSync(fileA)).toBe(false)
    expect(fs.existsSync(fileB)).toBe(false)
    // The capability minted for the deleted session must not survive.
    await expect(manager.resolve(descriptor.id, context())).resolves.toBeNull()
  })

  it('reports success for a uuid that no longer resolves anywhere', async () => {
    await expect(manager.deleteByUuid(UUID)).resolves.toBe(true)
  })

  it('rejects malformed uuids without touching disk', async () => {
    const fileA = writeSessionWithHeader(workspaceA, UUID, `a_${UUID}.jsonl`)
    for (const bad of ['', '../escape', 'a/b', 'a'.repeat(200), 42, null]) {
      await expect(manager.deleteByUuid(bad)).resolves.toBe(false)
    }
    expect(fs.existsSync(fileA)).toBe(true)
  })

  it('keeps capabilities minted for other sessions when deleting by uuid', async () => {
    const fileA = writeSessionWithHeader(workspaceA, UUID, `a_${UUID}.jsonl`)
    const otherUuid = '99999999-9999-9999-9999-999999999999'
    const otherFile = writeSessionWithHeader(workspaceA, otherUuid, `other_${otherUuid}.jsonl`)
    // One mint for both files: a second mintForWorkspace call would revoke the
    // first batch regardless of any delete.
    const [descriptor, otherDescriptor] = await manager.mintForWorkspace(
      [history(fileA), history(otherFile, otherUuid)],
      context()
    )

    await expect(manager.deleteByUuid(UUID)).resolves.toBe(true)
    await expect(manager.resolve(descriptor.id, context())).resolves.toBeNull()
    // The unrelated session and its capability survive.
    expect(fs.existsSync(otherFile)).toBe(true)
    expectSamePath(await manager.resolve(otherDescriptor.id, context()), fs.realpathSync(otherFile))
  })
})
