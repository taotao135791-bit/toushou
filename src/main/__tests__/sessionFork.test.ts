import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ agentRoot: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.agentRoot } }))
import { assistantReplyKey } from '../assistantReplyKey'
import { mapAgentMessages } from '../messageMapping'
import { forkNumberedSessionFile, forkSessionFile } from '../sessionFork'
import { readSessionHistoryMetadata } from '../sessionHistory'
import { normalizeSessionTitleFile } from '../sessionNaming'

/** The sessions root layout is simulated under a temp agent dir; every call
 * passes it explicitly like the existing sessionHistory tests. */
let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'session-fork-root-'))
  state.agentRoot = root
  dir = path.join(root, 'sessions', '--d--work--')
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeSource(name: string, lines: Array<Record<string, unknown>>): string {
  const file = path.join(dir, name)
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { mode: 0o600 })
  return file
}

const msg = (role: string, text: string) => ({ type: 'message', message: { role, content: [{ type: 'text', text }] } })

function sessionFile(turns: number, title = 'WF 文案'): string {
  const lines: Array<Record<string, unknown>> = [
    { type: 'title', v: 1, title, source: 'user' },
    { type: 'session', version: 3, id: 'aaaaaaaa-0000-0000-0000-000000000001', timestamp: '2026-11-01T00:00:00.000Z', cwd: 'D:\\work' }
  ]
  for (let i = 1; i <= turns; i++) {
    lines.push(msg('user', `user ${i}`))
    lines.push({ type: 'model_change', id: `m${i}`, model: 'x' })
    lines.push(msg('assistant', `answer ${i}`))
  }
  return writeSource(`2026-11-01T00-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000001.jsonl`, lines)
}

describe('numbered reply titles', () => {
  it('reserves sibling numbers on disk across concurrent forks, nested forks and a restarted module', async () => {
    const file = sessionFile(1, '日报')
    const options = { agentDir: root, completeTurnsOnly: true }
    const original = readFileSync(file)
    const branches = await Promise.all([forkNumberedSessionFile(file, options), forkNumberedSessionFile(file, options)])
    expect(branches.map(branch => branch.title)).toEqual(['日报（1）', '日报（2）'])
    expect(readFileSync(file)).toEqual(original)
    vi.resetModules()
    const restarted = await import('../sessionFork')
    const nested = await restarted.forkNumberedSessionFile(branches[0].filePath, options)
    expect(nested.title).toBe('日报（3）')
    expect(await readSessionHistoryMetadata(nested.filePath)).toMatchObject({ title: '日报（3）', branchName: { base: '日报', title: '日报（3）' } })
    const rename = () => ({ live: [], overlays: new Map([[normalizeSessionTitleFile(nested.filePath), { title: '客户周报' }]]) })
    expect((await restarted.forkNumberedSessionFile(nested.filePath, options, { titles: rename })).title).toBe('客户周报（1）')
  })

  it('uses the visible renamed or restored source and avoids other live and persisted titles', async () => {
    const oldFile = sessionFile(1, '原本的日报')
    const current = writeSource('2026-11-02T00-00-00-000Z_bbbbbbbb-0000-0000-0000-000000000002.jsonl', [
      { type: 'session', id: 'b', cwd: 'D:\\work' }, msg('user', '第一条消息'), msg('assistant', '回答')
    ])
    const options = { agentDir: root }
    const titles = () => ({ overlays: new Map([[normalizeSessionTitleFile(oldFile), { title: '已重命名' }]]), live: ['已重命名（1）'] })
    expect((await forkNumberedSessionFile(current, options, { resumeFrom: oldFile, titles })).title).toBe('已重命名（2）')
    expect((await forkNumberedSessionFile(current, options, { liveTitle: '热会话' })).title).toBe('热会话（1）')
    expect((await forkNumberedSessionFile(current, options, { resumeFrom: oldFile })).title).toBe('原本的日报（1）')
    expect((await forkNumberedSessionFile(current, options)).title).toBe('第一条消息（1）')
  })

  it('treats a hand-authored numeric suffix as title text and preserves the ordinal on long Unicode names', async () => {
    const file = sessionFile(1, '季度（2）')
    expect((await forkNumberedSessionFile(file, { agentDir: root })).title).toBe('季度（2）（1）')
    const branch = await forkNumberedSessionFile(file, { agentDir: root }, { liveTitle: '📈投放'.repeat(25) })
    const bytes = readFileSync(branch.filePath)
    expect(bytes.indexOf(10) + 1).toBe(256)
    expect(branch.title).toMatch(/（1）$/)
    expect(branch.title).not.toContain('�')
    expect((await readSessionHistoryMetadata(branch.filePath))?.title).toBe(branch.title)
  })
})

describe('forkSessionFile', () => {
  it('duplicates the whole conversation with a fresh uuid and a suffixed title', async () => {
    const source = sessionFile(3)
    const fork = await forkSessionFile(source, { titleSuffix: '（副本）', agentDir: root })
    expect(fork.keptUserTurns).toBe(3)
    expect(fork.uuid).not.toBe('aaaaaaaa-0000-0000-0000-000000000001')
    const text = readFileSync(fork.filePath, 'utf8')
    const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({ type: 'title', title: 'WF 文案（副本）' })
    expect(lines[1]).toMatchObject({ type: 'session', id: fork.uuid })
    expect(lines.filter((line) => (line.message as { role?: string } | undefined)?.role === 'user')).toHaveLength(3)
    // The source keeps every turn untouched.
    const sourceLines = readFileSync(source, 'utf8').split('\n').filter(Boolean)
    expect(sourceLines).toHaveLength(2 + 3 * 3)
  })

  it('branches through the exact clicked assistant response, including repeated legacy replies in one turn', async () => {
    const repeated = msg('assistant', 'Same answer')
    const other = msg('assistant', 'Second answer')
    const key = assistantReplyKey(repeated.message)!
    const source = sessionFile(1)
    const tail = [repeated, other, repeated, msg('user', 'Later prompt')]
    writeFileSync(source, readFileSync(source, 'utf8') + tail.map(row => JSON.stringify(row)).join('\n') + '\n')
    const original = readFileSync(source, 'utf8')
    const visible = mapAgentMessages(tail.map(row => row.message))
    expect(visible.map(row => row.replyKey)).toEqual([key, assistantReplyKey(other.message), key, undefined])
    for (const occurrence of [1, 2]) {
      const fork = await forkSessionFile(source, { agentDir: root, reply: { key, occurrence, total: 2 } })
      const text = readFileSync(fork.filePath, 'utf8')
      expect(JSON.parse(text.trimEnd().split('\n').at(-1)!)).toEqual(repeated)
      expect(text.includes('Second answer')).toBe(occurrence === 2)
      expect(text).not.toContain('Later prompt')
      expect(readFileSync(source, 'utf8')).toBe(original)
    }
    await expect(forkSessionFile(source, { agentDir: root, reply: { key, occurrence: 1, total: 1 } })).rejects.toThrow('reply-not-found')
  })

  it('truncates at a complete turn boundary and drops the dangling next-turn records', async () => {
    const source = sessionFile(3)
    // A trailing record belonging to a 4th turn that never finished.
    const withDangling = readFileSync(source, 'utf8') + JSON.stringify({ type: 'progress', label: 'half-done' }) + '\n'
    writeFileSync(source, withDangling, { mode: 0o600 })
    const fork = await forkSessionFile(source, { keepUserTurns: 2, titleSuffix: '（分支）', agentDir: root })
    expect(fork.keptUserTurns).toBe(2)
    const lines = readFileSync(fork.filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    const users = lines.filter((line) => (line.message as { role?: string } | undefined)?.role === 'user')
    expect(users).toHaveLength(2)
    // Turn 2's assistant reply survived; turn 3 and the dangling record are gone.
    expect(lines.some((line) => JSON.stringify(line).includes('answer 2'))).toBe(true)
    expect(lines.some((line) => JSON.stringify(line).includes('user 3'))).toBe(false)
    expect(lines.some((line) => line.type === 'progress')).toBe(false)
  })

  it('rejects files outside the sessions root and sessions with no user turns', async () => {
    await expect(forkSessionFile(path.join(tmpdir(), 'outside.jsonl'), { agentDir: root })).rejects.toThrow('not-a-session-file')
    const empty = writeSource('2026-11-02T00-00-00-000Z_bbbbbbbb-0000-0000-0000-000000000002.jsonl', [
      { type: 'session', version: 3, id: 'b', timestamp: '2026-11-02T00:00:00.000Z', cwd: 'D:\\work' }
    ])
    await expect(forkSessionFile(empty, { agentDir: root })).rejects.toThrow('no-user-turns')
  })

  it('does not treat steering messages as turn boundaries', async () => {
    const source = writeSource('2026-11-03T00-00-00-000Z_cccccccc-0000-0000-0000-000000000003.jsonl', [
      { type: 'session', version: 3, id: 'c', timestamp: '2026-11-03T00:00:00.000Z', cwd: 'D:\work' },
      msg('user', 'turn one'),
      msg('assistant', 'answer one'),
      // Steering belongs to turn one; counting it would cut the fork early.
      { type: 'message', message: { role: 'user', steering: true, content: [{ type: 'text', text: 'steer note' }] } },
      msg('user', 'turn two'),
      msg('assistant', 'answer two')
    ])
    const fork = await forkSessionFile(source, { keepUserTurns: 2, agentDir: root })
    expect(fork.keptUserTurns).toBe(2)
    const text = readFileSync(fork.filePath, 'utf8')
    expect(text).toContain('answer one')
    expect(text).toContain('steer note')
    expect(text).toContain('answer two')
  })

  it('clamps keepUserTurns beyond the conversation to a full copy', async () => {
    const source = sessionFile(2)
    const fork = await forkSessionFile(source, { keepUserTurns: 99, agentDir: root })
    expect(fork.keptUserTurns).toBe(2)
  })

  it('completeTurnsOnly drops a trailing unanswered turn but keeps everything complete', async () => {
    // Two finished turns plus a third whose user message was sent while the
    // assistant is still streaming (progress records, no assistant message).
    const source = writeSource('2026-11-04T00-00-00-000Z_dddddddd-0000-0000-0000-000000000004.jsonl', [
      { type: 'session', version: 3, id: 'd', timestamp: '2026-11-04T00:00:00.000Z', cwd: 'D:\work' },
      msg('user', 'turn one'),
      msg('assistant', 'answer one'),
      msg('user', 'turn two'),
      msg('assistant', 'answer two'),
      msg('user', 'turn three'),
      { type: 'progress', label: 'streaming' }
    ])
    const fork = await forkSessionFile(source, { completeTurnsOnly: true, titleSuffix: '（分支）', agentDir: root })
    expect(fork.keptUserTurns).toBe(2)
    const text = readFileSync(fork.filePath, 'utf8')
    expect(text).toContain('answer two')
    expect(text).not.toContain('turn three')
    expect(text).not.toContain('progress')
  })

  it('completeTurnsOnly is a no-op when the last turn is already answered', async () => {
    const source = sessionFile(3)
    const fork = await forkSessionFile(source, { completeTurnsOnly: true, agentDir: root })
    expect(fork.keptUserTurns).toBe(3)
    expect(readFileSync(fork.filePath, 'utf8')).toContain('answer 3')
  })

  it.each(['toolUse', 'aborted', 'error', undefined])('drops a trailing non-final assistant record (%s)', async (stopReason) => {
    const source = sessionFile(1)
    const toolCall = { type: 'toolCall', id: 'call1', name: 'read', arguments: {} }
    const content = stopReason === 'aborted' || stopReason === 'error' ? [{ type: 'text', text: 'partial reply' }] : [toolCall]
    const tail = [msg('user', 'next prompt'), { type: 'message', message: { role: 'assistant', stopReason, content } }]
    writeFileSync(source, readFileSync(source, 'utf8') + tail.map(record => JSON.stringify(record)).join('\n') + '\n')

    const fork = await forkSessionFile(source, { completeTurnsOnly: true, agentDir: root })
    expect(fork.keptUserTurns).toBe(1)
    expect(readFileSync(fork.filePath, 'utf8')).not.toContain('next prompt')
    await expect(forkSessionFile(source, { keepUserTurns: 2, agentDir: root })).rejects.toThrow('incomplete-turn')
  })

  it('retains a finished turn that previously used a tool', async () => {
    const source = sessionFile(1)
    const tail = [
      msg('user', 'next prompt'),
      { type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call1', name: 'read', arguments: {} }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'call1', content: [] } },
      { type: 'message', message: { ...msg('assistant', 'finished reply').message, stopReason: 'stop' } }
    ]
    writeFileSync(source, readFileSync(source, 'utf8') + tail.map(record => JSON.stringify(record)).join('\n') + '\n')

    const fork = await forkSessionFile(source, { completeTurnsOnly: true, agentDir: root })
    expect(fork.keptUserTurns).toBe(2)
    expect(readFileSync(fork.filePath, 'utf8')).toContain('finished reply')
  })

  it('completeTurnsOnly rejects a source whose only turn is unanswered', async () => {
    const source = writeSource('2026-11-05T00-00-00-000Z_eeeeeeee-0000-0000-0000-000000000005.jsonl', [
      { type: 'session', version: 3, id: 'e', timestamp: '2026-11-05T00:00:00.000Z', cwd: 'D:\work' },
      msg('user', 'only turn'),
      { type: 'progress', label: 'streaming' }
    ])
    await expect(forkSessionFile(source, { completeTurnsOnly: true, agentDir: root })).rejects.toThrow('no-user-turns')
  })
})
