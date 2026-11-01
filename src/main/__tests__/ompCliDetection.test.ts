import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { spawnCommand } from '../command'
import {
  executableCandidateNames,
  executableSearchDirs,
  findExecutableInDirs,
  probeCliVersion
} from '../omp/OmpCapabilities'

const tempRoots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-detect-'))
  tempRoots.push(dir)
  return dir
}

/** Write a candidate file with exec bits so POSIX X_OK checks pass in CI. */
function writeCandidate(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const full = path.join(dir, name)
  writeFileSync(full, '', { mode: 0o755 })
  return full
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('executableCandidateNames', () => {
  it('uses only the bare name on POSIX platforms', () => {
    expect(executableCandidateNames('omp', 'darwin')).toEqual(['omp'])
    expect(executableCandidateNames('omp', 'linux')).toEqual(['omp'])
  })

  it('prefers Windows executables and npm shims over the POSIX bare-name shim', () => {
    expect(executableCandidateNames('omp', 'win32')).toEqual(['omp.exe', 'omp.com', 'omp.cmd', 'omp.bat', 'omp'])
  })
})

describe('findExecutableInDirs on win32', () => {
  it('finds omp.exe when no bare omp exists', () => {
    const dir = tempDir()
    const exe = writeCandidate(dir, 'omp.exe')
    expect(findExecutableInDirs('omp', [dir], 'win32')).toBe(exe)
  })

  it('prefers the native executable when both exist', () => {
    const dir = tempDir()
    writeCandidate(dir, 'omp')
    const exe = writeCandidate(dir, 'omp.exe')
    expect(findExecutableInDirs('omp', [dir], 'win32')).toBe(exe)
  })

  it('detects npm command shims, while preferring native executables', () => {
    const dir = tempDir()
    const cmd = writeCandidate(dir, 'omp.cmd')
    writeCandidate(dir, 'omp')
    writeCandidate(dir, 'omp.bat')
    expect(findExecutableInDirs('omp', [dir], 'win32')).toBe(cmd)
    const exe = writeCandidate(dir, 'omp.exe')
    expect(findExecutableInDirs('omp', [dir], 'win32')).toBe(exe)
  })

  it('searches directories in order', () => {
    const first = tempDir()
    const second = tempDir()
    const expected = writeCandidate(second, 'omp.exe')
    expect(findExecutableInDirs('omp', [first, second], 'win32')).toBe(expected)
  })
})

describe('findExecutableInDirs on POSIX', () => {
  it('finds the bare name', () => {
    const dir = tempDir()
    const bare = writeCandidate(dir, 'omp')
    expect(findExecutableInDirs('omp', [dir], 'darwin')).toBe(bare)
  })

  it('ignores .exe files', () => {
    const dir = tempDir()
    writeCandidate(dir, 'omp.exe')
    expect(findExecutableInDirs('omp', [dir], 'darwin')).toBeNull()
  })
})

describe('executableSearchDirs', () => {
  it('includes the omp installer default dir on win32', () => {
    const dirs = executableSearchDirs('win32', { PATH: '', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })
    // path.join uses the host's separator, so compare normalized forms —
    // this test must pass on POSIX CI runners too.
    const normalized = dirs.map((dir) => dir.replace(/\\/g, '/'))
    expect(normalized).toContain('C:/Users/a/AppData/Local/omp')
  })

  it('does not add the win32 default dir on POSIX', () => {
    const dirs = executableSearchDirs('darwin', { PATH: '' })
    const normalized = dirs.map((dir) => dir.replace(/\\/g, '/'))
    expect(normalized.some((dir) => dir.endsWith('/omp'))).toBe(false)
  })
})


describe('version probe for detected Windows shims', () => {
  it('passes the exact path containing spaces to the command wrapper with a fixed version argument', async () => {
    const dir = path.join(tempDir(), 'folder with spaces')
    const cmd = writeCandidate(dir, 'omp.cmd')
    const stdout = new EventEmitter(), stderr = new EventEmitter()
    const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn() })
    const run = vi.fn(() => { queueMicrotask(() => { stdout.emit('data', Buffer.from('omp v17.2.7')); child.emit('close', 0) }); return child })
    const found = findExecutableInDirs('omp', [dir], 'win32')
    expect(found).toBe(cmd)
    expect(await probeCliVersion({command:'omp',path:found!,available:true}, run as unknown as typeof spawnCommand)).toBe('17.2.7')
    expect(run).toHaveBeenCalledWith(cmd, ['--version'], expect.objectContaining({stdio:['ignore','pipe','pipe']}))
  })
  it('prefers the CLI stdout version even when a stderr runtime warning arrives first', async () => {
    const stdout = new EventEmitter(), stderr = new EventEmitter()
    const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn() })
    const run = vi.fn(() => { queueMicrotask(() => { stderr.emit('data', Buffer.from('warning from Bun 1.3.14')); stdout.emit('data', Buffer.from('omp v17.2.12')); child.emit('close', 0) }); return child })
    expect(await probeCliVersion({ command: 'omp', path: '/synthetic/omp', available: true }, run as unknown as typeof spawnCommand)).toBe('17.2.12')
  })
  it.skipIf(process.platform !== 'win32')('executes a real command shim at a path containing spaces', async () => {
    const dir = path.join(tempDir(), 'folder with spaces')
    mkdirSync(dir, {recursive:true})
    const cmd = path.join(dir, 'omp.cmd')
    writeFileSync(cmd, '@echo off\r\necho omp v17.2.7\r\n')
    writeFileSync(path.join(dir, 'omp'), '#!/bin/sh\nexit 1\n')
    const found = findExecutableInDirs('omp', [dir], 'win32')
    expect(found).toBe(cmd)
    expect(await probeCliVersion({command:'omp',path:found!,available:true})).toBe('17.2.7')
  })
  it('ignores relative PATH entries during automatic discovery', () => {
    const dirs = executableSearchDirs(process.platform, { PATH: ['.', 'relative', process.cwd(), path.resolve(tempDir())].join(path.delimiter) })
    expect(dirs).not.toContain('.')
    expect(dirs).not.toContain('relative')
    expect(dirs).not.toContain(process.cwd())
  })
  it.skipIf(process.platform !== 'win32')('ignores the current working directory even with different path casing', () => {
    const dirs = executableSearchDirs('win32', { PATH: process.cwd().toUpperCase() })
    expect(dirs.map(dir => path.resolve(dir).toLowerCase())).not.toContain(path.resolve(process.cwd()).toLowerCase())
  })
})
