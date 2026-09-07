import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

// The module under test must never touch a real shell: spawn and
// shell.showItemInFolder are both mocked at the boundary.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({ shell: { showItemInFolder: vi.fn() } }))

import { spawn } from 'node:child_process'
import { shell } from 'electron'
import { isOpenWorkspaceTarget, openWorkspaceInRequest, openWorkspaceInTarget } from '../openWorkspaceIn'

const spawnMock = vi.mocked(spawn)
const showItemInFolderMock = vi.mocked(shell.showItemInFolder)

const DIR = '/tmp/omp-open-in-proj'
/** Grant lookup standing in for ipc.ts's requireGrant. */
type GrantLookup = (id: unknown) => { realPath: string } | null
const defaultLookup: GrantLookup = () => ({ realPath: DIR })
const lookup = vi.fn<GrantLookup>(defaultLookup)

/** Process exit/spawn behaviour for one fake child. */
interface FakeBehavior {
  error?: string
  code?: number
}

function fakeChild(behavior: FakeBehavior = {}): ChildProcess {
  const child = new EventEmitter() as unknown as EventEmitter & ChildProcess
  child.unref = vi.fn()
  // Test hygiene: an eager or misrouted fake child must never blow up the
  // worker with an unhandled 'error' — production code owns the real handler.
  child.on('error', () => {})
  queueMicrotask(() => {
    if (behavior.error) child.emit('error', new Error(behavior.error))
    else if (behavior.code !== undefined) child.emit('close', behavior.code)
  })
  return child
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  spawnMock.mockReset()
  showItemInFolderMock.mockReset()
  lookup.mockReset()
  lookup.mockImplementation(defaultLookup)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
})

describe('isOpenWorkspaceTarget', () => {
  it('accepts exactly the three shipped targets', () => {
    expect(isOpenWorkspaceTarget('finder')).toBe(true)
    expect(isOpenWorkspaceTarget('terminal')).toBe(true)
    expect(isOpenWorkspaceTarget('editor')).toBe(true)
  })

  it('rejects everything else without narrowing', () => {
    for (const value of ['registry', 'FINDER', '', 42, null, undefined, {}]) {
      expect(isOpenWorkspaceTarget(value)).toBe(false)
    }
  })
})

describe('openWorkspaceInRequest validation', () => {
  it('rejects an unknown target before any grant lookup or spawn', async () => {
    setPlatform('darwin')
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'registry')
    expect(result).toEqual({ ok: false, reason: 'invalid-target' })
    expect(lookup).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(showItemInFolderMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown workspace id without spawning', async () => {
    setPlatform('darwin')
    lookup.mockReturnValue(null)
    const result = await openWorkspaceInRequest(lookup, 'revoked-grant', 'finder')
    expect(result).toEqual({ ok: false, reason: 'invalid-workspace' })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(showItemInFolderMock).not.toHaveBeenCalled()
  })

  it('rejects a non-string workspace id without spawning', async () => {
    setPlatform('darwin')
    // The stub mirrors requireGrant's contract: only a well-formed known id
    // resolves; anything else (42, objects, '') must come back as null.
    lookup.mockImplementation((id) => (typeof id === 'string' && id ? { realPath: DIR } : null))
    const result = await openWorkspaceInRequest(lookup, 42, 'terminal')
    expect(result).toEqual({ ok: false, reason: 'invalid-workspace' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects an empty realPath', async () => {
    setPlatform('darwin')
    const result = await openWorkspaceInTarget('', 'finder')
    expect(result).toEqual({ ok: false, reason: 'invalid-workspace' })
    expect(showItemInFolderMock).not.toHaveBeenCalled()
  })
})

describe('openWorkspaceInRequest finder', () => {
  it('reveals the granted real path without spawning', async () => {
    setPlatform('darwin')
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'finder')
    expect(result).toEqual({ ok: true })
    expect(showItemInFolderMock).toHaveBeenCalledWith(DIR)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('openWorkspaceInRequest terminal', () => {
  it('spawns `open -a Terminal` on macOS, detached and unrefed', async () => {
    setPlatform('darwin')
    const child = fakeChild({ code: 0 })
    spawnMock.mockReturnValue(child)
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'terminal')
    expect(result).toEqual({ ok: true })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['-a', 'Terminal', DIR],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    )
    expect(child.unref).toHaveBeenCalled()
  })

  it('reports terminal-missing when the macOS launcher exits non-zero', async () => {
    setPlatform('darwin')
    spawnMock.mockReturnValue(fakeChild({ code: 1 }))
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'terminal')
    expect(result).toEqual({ ok: false, reason: 'terminal-missing' })
  })

  it('opens a cmd window cd-ed into the workspace on Windows', async () => {
    setPlatform('win32')
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'terminal')
    expect(result).toEqual({ ok: true })
    expect(spawnMock).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '', 'cmd', '/K', `cd /d ${DIR}`],
      expect.objectContaining({ detached: true })
    )
    expect(child.unref).toHaveBeenCalled()
  })

  it('falls back down the linux terminal chain on spawn failure', async () => {
    setPlatform('linux')
    spawnMock.mockImplementation((command: string) =>
      command === 'x-terminal-emulator' ? fakeChild({ error: 'spawn ENOENT' }) : fakeChild({ code: 0 })
    )
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'terminal')
    expect(result).toEqual({ ok: true })
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'x-terminal-emulator',
      ['--working-directory', DIR],
      expect.anything()
    )
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'gnome-terminal',
      [`--working-directory=${DIR}`],
      expect.anything()
    )
  })

  it('reports terminal-missing when every linux candidate is missing', async () => {
    setPlatform('linux')
    spawnMock.mockImplementation(() => fakeChild({ error: 'spawn ENOENT' }))
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'terminal')
    expect(result).toEqual({ ok: false, reason: 'terminal-missing' })
    expect(spawnMock).toHaveBeenCalledTimes(4)
  })
})

describe('openWorkspaceInRequest editor', () => {
  it('spawns `open -a Visual Studio Code` on macOS', async () => {
    setPlatform('darwin')
    spawnMock.mockReturnValue(fakeChild({ code: 0 }))
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'editor')
    expect(result).toEqual({ ok: true })
    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['-a', 'Visual Studio Code', DIR],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    )
  })

  it('reports editor-missing when VS Code is not installed (non-zero exit)', async () => {
    setPlatform('darwin')
    spawnMock.mockReturnValue(fakeChild({ code: 1 }))
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'editor')
    expect(result).toEqual({ ok: false, reason: 'editor-missing' })
  })

  it('reports editor-missing when the linux `code` binary cannot spawn', async () => {
    setPlatform('linux')
    spawnMock.mockReturnValue(fakeChild({ error: 'spawn ENOENT' }))
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'editor')
    expect(result).toEqual({ ok: false, reason: 'editor-missing' })
    expect(spawnMock).toHaveBeenCalledWith('code', [DIR], expect.anything())
  })

  it('routes through cmd on Windows where `code` is a .cmd shim', async () => {
    setPlatform('win32')
    spawnMock.mockReturnValue(fakeChild({ code: 0 }))
    const result = await openWorkspaceInRequest(lookup, 'grant-1', 'editor')
    expect(result).toEqual({ ok: true })
    expect(spawnMock).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'code', DIR],
      expect.objectContaining({ detached: true })
    )
  })
})
