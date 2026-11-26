import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalExistingPath } from './canonicalPath'
import { listAllSessions, listSessionHistory, ompSessionDirCandidatesFor } from './sessionHistory'
import { isSessionMoving, moveSessionJournal, withSessionMove } from './sessionProjectMove'
import { createSessionDeletionLocks } from './sessionDeletionLocks'

vi.mock('./piSettings', () => ({ defaultPiAgentDir: () => '/unused' }))

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const root = canonicalExistingPath(fs.mkdtempSync(path.join(os.tmpdir(), 'session-project-move-')))
  directories.push(root)
  const agentDir = path.join(root, 'agent')
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  fs.mkdirSync(source)
  fs.mkdirSync(target)
  const legacy = path.join(agentDir, 'sessions', 'old-layout')
  fs.mkdirSync(legacy, { recursive: true })
  const uuid = 'terminal-session-123'
  const file = path.join(legacy, `2026-11-01T01-02-03-456Z_${uuid}.jsonl`)
  const timestamp = '2026-11-01T01:02:03.456Z'
  const titleLine = '{"type":"title","title":"Synthetic history"}\r\n'
  const header = { type: 'session', id: uuid, timestamp, cwd: source, version: 3 }
  const body = '{"type":"custom","data":"' + '多模态'.repeat(70_000) + '"}\r\n' + '{"type":"message","message":{"role":"assistant","content":"[report](/synthetic/report.csv)"}}\n'
  fs.writeFileSync(file, titleLine + JSON.stringify(header) + '\r\n' + body)
  const prepare = vi.fn(async (_file: string) => true)
  return { uuid, source, target, agentDir, available: () => true, prepare, file, titleLine, header, body }
}

describe('workspace conversation move', () => {
  it('moves a legacy journal into the new workspace and preserves every record and the UUID', async () => {
    const f = fixture()
    const result = await moveSessionJournal(f)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [expectedDirectory] = ompSessionDirCandidatesFor(f.target, f.agentDir, canonicalExistingPath)
    expect(result).toEqual({ ok: true, sourceFile: f.file, filePath: path.join(expectedDirectory, path.basename(f.file)) })
    expect(f.prepare).toHaveBeenCalledWith(f.file)
    expect(fs.existsSync(f.file)).toBe(false)
    expect(fs.readFileSync(result.filePath, 'utf8')).toBe(f.titleLine + JSON.stringify({ ...f.header, cwd: f.target }) + '\r\n' + f.body)
    expect(await listSessionHistory(f.source, f.agentDir)).toEqual([])
    expect(await listSessionHistory(f.target, f.agentDir)).toMatchObject([{ uuid: f.uuid, cwd: f.target }])
    expect(await listAllSessions(f.agentDir)).toMatchObject([{ uuid: f.uuid, cwd: f.target }])
  })

  it('leaves a busy journal and an existing destination file byte-for-byte unchanged', async () => {
    const f = fixture()
    const original = fs.readFileSync(f.file)
    await expect(moveSessionJournal({ ...f, prepare: async () => false })).resolves.toEqual({ ok: false, error: 'busy' })
    expect(fs.readFileSync(f.file)).toEqual(original)
    const [directory] = ompSessionDirCandidatesFor(f.target, f.agentDir, canonicalExistingPath)
    fs.mkdirSync(directory, { recursive: true })
    const collision = path.join(directory, path.basename(f.file))
    fs.writeFileSync(collision, JSON.stringify({ ...f.header, id: 'another-session', cwd: f.target }) + '\n')
    const before = fs.readFileSync(collision)
    await expect(moveSessionJournal(f)).resolves.toEqual({ ok: false, error: 'conflict' })
    expect(fs.readFileSync(f.file)).toEqual(original)
    expect(fs.readFileSync(collision)).toEqual(before)
    expect(fs.readdirSync(directory)).toEqual([path.basename(f.file)])
  })

  it('preserves a journal changed by another writer while the runtime is stopping', async () => {
    const f = fixture()
    const suffix = '{"type":"custom","data":"late journal record"}\n'
    const recent = fs.readFileSync(f.file, 'utf8') + suffix
    await expect(moveSessionJournal({ ...f, prepare: async file => {
      fs.appendFileSync(file, suffix)
      return true
    } })).resolves.toEqual({ ok: false, error: 'busy' })
    expect(fs.readFileSync(f.file, 'utf8')).toBe(recent)
    expect(await listSessionHistory(f.target, f.agentDir)).toEqual([])
  })

  it('rejects a different source workspace and serializes duplicate moves against deletion', async () => {
    const f = fixture()
    await expect(moveSessionJournal({ ...f, source: f.target, target: f.source })).resolves.toEqual({ ok: false, error: 'not-found' })
    const locks = createSessionDeletionLocks(() => [], () => undefined)
    await withSessionMove(f.uuid, async () => {
      expect(isSessionMoving(f.uuid)).toBe(true)
      await expect(withSessionMove(f.uuid, async () => true)).resolves.toBe('busy')
      await expect(locks.runDeletion([f.uuid], async () => true)).resolves.toBe('locked')
    })
    expect(isSessionMoving(f.uuid)).toBe(false)
  })
})
