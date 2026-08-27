import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// sessionHistory.ts imports ./piSettings, which imports ./omp for CLI
// detection — tests always pass an explicit agentDir, so stub it out
// electron-free (same pattern as piSettings.test.ts).
vi.mock('../omp', () => ({
  detectCli: () => ({ command: 'pi', path: '/usr/local/bin/pi', available: true }),
  executableSearchDirs: () => []
}))

import {
  sessionDirFor,
  currentSessionDirFor,
  listSessionHistory,
  deleteSessionFile,
  isSessionFilePath
} from '../sessionHistory'

let agentDir: string
let projectDir: string

beforeEach(() => {
  agentDir = mkdtempSync(path.join(tmpdir(), 'omp-agent-'))
  projectDir = mkdtempSync(path.join(tmpdir(), 'omp-project-'))
})

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

/** pi's encoding: --<realpath with leading / stripped, [/\\:] → - --> */
function expectedDirName(cwd: string): string {
  return `--${realpathSync(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

function sessionHeader(id: string, timestamp: string | number): string {
  return JSON.stringify({ type: 'session', id, timestamp, cwd: projectDir })
}

function userMessage(text: string): string {
  return JSON.stringify({
    type: 'message',
    id: 'm1',
    parentId: null,
    timestamp: '2025-01-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] }
  })
}

function assistantMessage(text: string): string {
  return JSON.stringify({
    type: 'message',
    id: 'm2',
    parentId: 'm1',
    timestamp: '2025-01-01T00:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
}

/** Write a session file into this project's encoded sessions dir. */
function writeSessionFile(name: string, lines: string[]): string {
  const dir = sessionDirFor(projectDir, agentDir)
  mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, name)
  writeFileSync(filePath, lines.join('\n') + '\n')
  return filePath
}

describe('sessionDirFor', () => {
  it('encodes the realpath of the project dir like pi does', () => {
    expect(sessionDirFor(projectDir, agentDir)).toBe(
      path.join(agentDir, 'sessions', expectedDirName(projectDir))
    )
  })

  it('strips the leading slash and replaces separators and colons', () => {
    // /a/b/c → --a-b-c--
    const dir = sessionDirFor(projectDir, agentDir)
    expect(path.basename(dir)).toMatch(/^--.+--$/)
    expect(path.basename(dir)).not.toContain('/')
  })
})

describe('listSessionHistory', () => {
  it('returns [] when the session directory does not exist', async () => {
    expect(await listSessionHistory(projectDir, agentDir)).toEqual([])
  })

  it('lists sessions newest first with titles from the first user message', async () => {
    writeSessionFile('older_uuid-a.jsonl', [
      sessionHeader('uuid-a', '2025-01-01T00:00:00.000Z'),
      userMessage('fix the login bug'),
      assistantMessage('looking into it')
    ])
    writeSessionFile('newer_uuid-b.jsonl', [
      sessionHeader('uuid-b', '2025-01-03T00:00:00.000Z'),
      userMessage('add dark mode')
    ])

    const list = await listSessionHistory(projectDir, agentDir)
    expect(list.map((s) => s.uuid)).toEqual(['uuid-b', 'uuid-a'])
    expect(list[0].title).toBe('add dark mode')
    expect(list[1].title).toBe('fix the login bug')
    expect(list[1].timestamp).toBe(Date.parse('2025-01-01T00:00:00.000Z'))
    expect(list[1].cwd).toBe(projectDir)
    expect(list[1].filePath.endsWith('.jsonl')).toBe(true)
  })

  it('supports numeric epoch timestamps', async () => {
    writeSessionFile('epoch_uuid-n.jsonl', [
      sessionHeader('uuid-n', 1735689600000),
      userMessage('epoch session')
    ])
    const list = await listSessionHistory(projectDir, agentDir)
    expect(list[0].timestamp).toBe(1735689600000)
  })

  it('parses current-omp files with a title line before the session header', async () => {
    // omp 17 prepends {"type":"title",…} — the header is on line 2.
    writeSessionFile('current_uuid-c.jsonl', [
      JSON.stringify({ type: 'title', v: '1', title: '', updatedAt: '2025-01-02T00:00:00.000Z' }),
      sessionHeader('uuid-c', '2025-01-02T00:00:00.000Z'),
      JSON.stringify({ type: 'model_change', id: 'x', parentId: null, model: 'deepseek/x' }),
      userMessage('current runtime session')
    ])
    const list = await listSessionHistory(projectDir, agentDir)
    expect(list).toHaveLength(1)
    expect(list[0].uuid).toBe('uuid-c')
    expect(list[0].title).toBe('current runtime session')
  })

  it('discovers the current home-relative OMP directory layout', async () => {
    const dir = currentSessionDirFor(projectDir, agentDir)
    mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, 'current-layout_uuid-r.jsonl')
    writeFileSync(filePath, [sessionHeader('uuid-r', '2025-01-04T00:00:00.000Z'), userMessage('resume me')].join('\n') + '\n')

    const list = await listSessionHistory(projectDir, agentDir)
    expect(list.map((s) => s.uuid)).toEqual(['uuid-r'])
    expect(list[0].filePath).toBe(filePath)
  })

  it('truncates long titles to 80 chars and collapses whitespace', async () => {
    const long = `line one\nline two   ${'x'.repeat(100)}`
    writeSessionFile('long_uuid-l.jsonl', [
      sessionHeader('uuid-l', '2025-01-01T00:00:00.000Z'),
      userMessage(long)
    ])
    const list = await listSessionHistory(projectDir, agentDir)
    expect(list[0].title).toBe(long.replace(/\s+/g, ' ').slice(0, 80))
    expect(list[0].title).toHaveLength(80)
  })

  it("uses 'Untitled' when there is no user message", async () => {
    writeSessionFile('empty_uuid-u.jsonl', [
      sessionHeader('uuid-u', '2025-01-01T00:00:00.000Z'),
      assistantMessage('I said something unprompted')
    ])
    const list = await listSessionHistory(projectDir, agentDir)
    expect(list[0].title).toBe('Untitled')
  })

  it('skips corrupt files and non-jsonl files', async () => {
    writeSessionFile('good_uuid-g.jsonl', [
      sessionHeader('uuid-g', '2025-01-01T00:00:00.000Z'),
      userMessage('good session')
    ])
    writeSessionFile('broken_uuid-x.jsonl', ['{not json', userMessage('unreachable')])
    writeSessionFile('README.txt', [sessionHeader('uuid-t', '2025-01-01T00:00:00.000Z')])

    const list = await listSessionHistory(projectDir, agentDir)
    expect(list.map((s) => s.uuid)).toEqual(['uuid-g'])
  })

  it('ignores files without a session header', async () => {
    writeSessionFile('stray_uuid-s.jsonl', [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [] } })
    ])
    expect(await listSessionHistory(projectDir, agentDir)).toEqual([])
  })
})

describe('isSessionFilePath / deleteSessionFile', () => {
  it('deletes a session file inside the sessions root', async () => {
    const filePath = writeSessionFile('del_uuid-d.jsonl', [
      sessionHeader('uuid-d', '2025-01-01T00:00:00.000Z')
    ])
    expect(isSessionFilePath(filePath, agentDir)).toBe(true)
    expect(await deleteSessionFile(filePath, agentDir)).toBe(true)
    expect(existsSync(filePath)).toBe(false)
  })

  it('refuses paths outside the sessions root', async () => {
    const outside = path.join(projectDir, 'keep.jsonl')
    writeFileSync(outside, '{}')
    expect(isSessionFilePath(outside, agentDir)).toBe(false)
    expect(await deleteSessionFile(outside, agentDir)).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })

  it('refuses non-jsonl files inside the sessions root', async () => {
    const dir = sessionDirFor(projectDir, agentDir)
    mkdirSync(dir, { recursive: true })
    const inside = path.join(dir, 'notes.txt')
    writeFileSync(inside, 'x')
    expect(await deleteSessionFile(inside, agentDir)).toBe(false)
    expect(existsSync(inside)).toBe(true)
  })

  it('refuses traversal out of the root', async () => {
    const root = path.join(agentDir, 'sessions')
    mkdirSync(root, { recursive: true })
    const escape = path.join(root, '..', 'escape.jsonl')
    writeFileSync(path.join(agentDir, 'escape.jsonl'), '{}')
    expect(await deleteSessionFile(escape, agentDir)).toBe(false)
    expect(existsSync(path.join(agentDir, 'escape.jsonl'))).toBe(true)
  })

  it('returns false for a missing file inside the root', async () => {
    const ghost = path.join(agentDir, 'sessions', expectedDirName(projectDir), 'ghost.jsonl')
    expect(isSessionFilePath(ghost, agentDir)).toBe(true)
    expect(await deleteSessionFile(ghost, agentDir)).toBe(false)
  })

  it('refuses a session symlink whose target escapes the sessions root', () => {
    const dir = sessionDirFor(projectDir, agentDir)
    mkdirSync(dir, { recursive: true })
    // A real file OUTSIDE the sessions root (in the project dir), linked into it.
    const outside = path.join(projectDir, 'outside.jsonl')
    writeFileSync(outside, '{"type":"session"}')
    const link = path.join(dir, 'evil.jsonl')
    symlinkSync(outside, link)
    // The symlink resolves outside the sessions root → must be rejected.
    expect(isSessionFilePath(link, agentDir)).toBe(false)
    // The outside target is untouched.
    expect(existsSync(outside)).toBe(true)
  })
})
