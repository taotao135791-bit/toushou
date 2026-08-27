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
    await expect(manager.resolve(descriptor.id, context())).resolves.toBe(fs.realpathSync(filePath))
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
    await expect(manager.resolve(refreshed.id, context())).resolves.toBe(fs.realpathSync(filePath))
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

  it('expires and revokes grants by owner or workspace', async () => {
    const filePath = writeSession(workspaceA)
    const [expired] = await manager.mintForWorkspace([history(filePath)], context())
    now += 100
    await expect(manager.resolve(expired.id, context())).resolves.toBeNull()

    const [ownerRevoked] = await manager.mintForWorkspace([history(filePath)], context())
    manager.revokeOwner(41)
    await expect(manager.resolve(ownerRevoked.id, context())).resolves.toBeNull()

    const [workspaceRevoked] = await manager.mintForWorkspace([history(filePath)], context())
    manager.revokeWorkspace('workspace-a')
    await expect(manager.resolve(workspaceRevoked.id, context())).resolves.toBeNull()
  })

  it('serializes a history capability through one revalidated Main-only operation', async () => {
    const filePath = writeSession(workspaceA)
    const [descriptor] = await manager.mintForWorkspace([history(filePath)], context())
    let release: (() => void) | undefined
    const first = manager.withResolved(descriptor.id, context(), async (resolvedFilePath) => {
      expect(resolvedFilePath).toBe(fs.realpathSync(filePath))
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
