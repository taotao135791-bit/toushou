import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listProjectFiles } from '../projectFiles'

describe('listProjectFiles', () => {
  it('lists git-tracked + untracked files in this repo, excluding ignored dirs', async () => {
    const files = await listProjectFiles(process.cwd())
    expect(files.length).toBeGreaterThan(10)
    expect(files).toContain('package.json')
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
    expect(files.some((f) => f.startsWith('dist-electron/'))).toBe(false)
  })

  it('falls back to a capped walk outside git repos', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omp-pf-'))
    try {
      mkdirSync(path.join(dir, 'src'))
      mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true })
      writeFileSync(path.join(dir, 'a.txt'), 'a')
      writeFileSync(path.join(dir, 'src', 'b.ts'), 'b')
      writeFileSync(path.join(dir, 'node_modules', 'dep', 'c.js'), 'c')
      writeFileSync(path.join(dir, '.hidden'), 'h')
      const files = await listProjectFiles(dir)
      expect(files).toEqual(['a.txt', 'src/b.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
