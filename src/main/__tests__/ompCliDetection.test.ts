import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  executableCandidateNames,
  executableSearchDirs,
  findExecutableInDirs
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

  it('tries Windows executable extensions after the bare name', () => {
    expect(executableCandidateNames('omp', 'win32')).toEqual(['omp', 'omp.exe', 'omp.com'])
  })
})

describe('findExecutableInDirs on win32', () => {
  it('finds omp.exe when no bare omp exists', () => {
    const dir = tempDir()
    const exe = writeCandidate(dir, 'omp.exe')
    expect(findExecutableInDirs('omp', [dir], 'win32')).toBe(exe)
  })

  it('prefers the bare name when both exist', () => {
    const dir = tempDir()
    const bare = writeCandidate(dir, 'omp')
    writeCandidate(dir, 'omp.exe')
    expect(findExecutableInDirs('omp', [dir], 'win32')).toBe(bare)
  })

  it('does not match shell-script shims spawn cannot launch', () => {
    const dir = tempDir()
    writeCandidate(dir, 'omp.cmd')
    expect(findExecutableInDirs('omp', [dir], 'win32')).toBeNull()
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
    expect(dirs).toContain('C:\\Users\\a\\AppData\\Local\\omp')
  })

  it('does not add the win32 default dir on POSIX', () => {
    const dirs = executableSearchDirs('darwin', { PATH: '' })
    expect(dirs.some((dir) => dir.endsWith('omp'))).toBe(false)
  })
})
