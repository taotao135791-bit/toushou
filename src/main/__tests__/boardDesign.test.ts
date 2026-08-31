import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// boardDesign.ts resolves its default file through electron's app.getPath and
// reveals it through shell; tests mostly inject an explicit file instead.
let userDataDir: string
const showItemInFolder = vi.fn()
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  shell: { showItemInFolder: (...args: unknown[]) => showItemInFolder(...args) }
}))

import {
  boardDesignFile,
  readBoardDesign,
  revealBoardDesign,
  saveBoardDesign,
  stopBoardDesignWatch,
  watchBoardDesign
} from '../boardDesign'
import { BOARD_DESIGN_MAX_BYTES, DEFAULT_BOARD_DESIGN_MARKDOWN, formatBoardDesign } from '../../shared/boardDesign'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'omp-board-design-'))
  userDataDir = dir
  file = path.join(dir, 'board-design.md')
})

afterEach(() => {
  stopBoardDesignWatch()
  rmSync(dir, { recursive: true, force: true })
})

describe('readBoardDesign', () => {
  it('returns the unpersisted template when the file is missing', () => {
    const doc = readBoardDesign(file)
    expect(doc.path).toBe(file)
    expect(doc.markdown).toBe(DEFAULT_BOARD_DESIGN_MARKDOWN)
    expect(doc.spec).toEqual({ board: {}, widget: {} })
    expect(doc.issues).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('resolves the default file under userData', () => {
    expect(boardDesignFile()).toBe(path.join(dir, 'board-design.md'))
  })
})

describe('saveBoardDesign', () => {
  it('writes a valid document and reads it back', () => {
    const markdown = '## board\nbackground: #101014\ngrid: dots\n\n## widget\nradius: 12\nshadow: strong\n'
    const result = saveBoardDesign(markdown, file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec).toEqual({
      board: { background: '#101014', grid: 'dots' },
      widget: { radius: 12, shadow: 'strong' }
    })
    expect(readFileSync(file, 'utf-8')).toBe(markdown)
    expect(readBoardDesign(file).spec).toEqual(result.spec)
  })

  it('refuses a document with parse errors and does not touch the file', () => {
    writeFileSync(file, '## widget\nradius: 10\n')
    const before = readFileSync(file, 'utf-8')
    const result = saveBoardDesign('## widget\nradius: 99\nbogus line\n', file)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('invalid-design')
    expect(result.issues.some((issue) => issue.level === 'error')).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('rejects non-string or oversize input', () => {
    expect(saveBoardDesign(42, file)).toEqual({ ok: false, error: 'invalid-request', issues: [] })
    const oversize = saveBoardDesign('x'.repeat(BOARD_DESIGN_MAX_BYTES + 1), file)
    expect(oversize.ok).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('round-trips a formatted spec', () => {
    const spec = { board: { grid: 'lines' as const }, widget: { accent: '#7aa2f7', padding: 20 } }
    const result = saveBoardDesign(formatBoardDesign(spec), file)
    expect(result.ok).toBe(true)
    expect(readBoardDesign(file).spec).toEqual(spec)
  })
})

describe('revealBoardDesign', () => {
  it('writes the template first when the file is missing, then reveals it', () => {
    expect(revealBoardDesign(file)).toBe(true)
    expect(showItemInFolder).toHaveBeenCalledWith(file)
    expect(readFileSync(file, 'utf-8')).toBe(DEFAULT_BOARD_DESIGN_MARKDOWN)
  })
})

describe('watchBoardDesign', () => {
  it('broadcasts external edits and skips its own saves', async () => {
    writeFileSync(file, '## widget\nradius: 10\n')
    const onChange = vi.fn()
    watchBoardDesign(onChange, file)

    // An in-app save must not echo back through the watcher.
    expect(saveBoardDesign('## widget\nradius: 14\n', file).ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(onChange).not.toHaveBeenCalled()

    // An external edit does broadcast the freshly parsed spec.
    writeFileSync(file, '## board\ngrid: dots\n')
    await vi.waitFor(
      () => {
        expect(onChange).toHaveBeenCalledTimes(1)
      },
      { timeout: 3000 }
    )
    expect(onChange).toHaveBeenCalledWith({ spec: { board: { grid: 'dots' }, widget: {} }, issues: [] })
  }, 10_000)
})
