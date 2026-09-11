import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// sessionOrigins defaults its file into electron's userData; tests always
// inject an explicit path, but the module still imports electron at the top.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/toushou-origins-fallback' }
}))

import { SessionOriginIndex } from '../sessionOrigins'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'toushou-origins-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function jsonl(name: string): string {
  const filePath = path.join(dir, name)
  writeFileSync(filePath, '{"type":"session","id":"u","timestamp":1,"cwd":"/tmp"}\n')
  return filePath
}

function indexFile(): string {
  return path.join(dir, 'session-origins.json')
}

// record() persists write-through; flush() is the deterministic wait (a
// wall-clock sleep races slow CI disks).

describe('SessionOriginIndex', () => {
  it('records and looks up origins, surviving a reload', async () => {
    const file = jsonl('a.jsonl')
    const first = new SessionOriginIndex({ filePath: indexFile() })
    first.record(file, 'task')
    await first.flush()

    const second = new SessionOriginIndex({ filePath: indexFile() })
    await second.ready()
    expect(second.lookup(file)).toBe('task')
    expect(second.lookup(path.join(dir, 'missing.jsonl'))).toBeUndefined()
  })

  it('normalizes paths through realpath so aliases hit the same entry', async () => {
    const real = jsonl('b.jsonl')
    const aliased = path.join(dir, 'alias-of-b.jsonl')
    try {
      symlinkSync(real, aliased)
    } catch {
      // Windows without symlink privileges: nothing to prove here.
      return
    }
    const index = new SessionOriginIndex({ filePath: indexFile() })
    index.record(real, 'feishu')
    await index.flush()
    expect(index.lookup(aliased)).toBe('feishu')
  })

  it('prunes entries whose transcript file disappeared on persist', async () => {
    const file = jsonl('c.jsonl')
    const first = new SessionOriginIndex({ filePath: indexFile() })
    first.record(file, 'feishu')
    await first.flush()

    rmSync(file)
    const survivor = jsonl('d.jsonl')
    first.record(survivor, 'task')
    await first.flush()

    const second = new SessionOriginIndex({ filePath: indexFile() })
    await second.ready()
    expect(second.lookup(survivor)).toBe('task')
    expect(second.lookup(file)).toBeUndefined()
  })

  it('starts cleanly on a corrupt index file', async () => {
    writeFileSync(indexFile(), 'not json at all')
    const index = new SessionOriginIndex({ filePath: indexFile() })
    await index.ready()
    expect(index.lookup(jsonl('e.jsonl'))).toBeUndefined()
  })

  it('ignores invalid recorded paths and unknown origins on load', async () => {
    mkdirSync(dir, { recursive: true })
    const file = jsonl('f.jsonl')
    writeFileSync(
      indexFile(),
      JSON.stringify([
        { sessionFile: file, origin: 'browser', recordedAt: 1 },
        { sessionFile: '', origin: 'feishu', recordedAt: 2 },
        { sessionFile: 42, origin: 'task', recordedAt: 3 },
        'nonsense'
      ])
    )
    const index = new SessionOriginIndex({ filePath: indexFile() })
    await index.ready()
    expect(index.lookup(file)).toBeUndefined()
    // A later valid recording still lands.
    index.record(file, 'feishu')
    expect(index.lookup(file)).toBe('feishu')
  })
})
