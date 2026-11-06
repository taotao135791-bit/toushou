import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('source-backed table and funnel in Electron', () => {
  it('pages and sorts the actual daily rows and preserves business stages across date changes and refresh', { timeout: 60000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'business-data-widgets-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      let build: { buildSync: (opts: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'businessDataWidgets.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../../shared') } })
      const env: Record<string, string | undefined> = { ...process.env, TZ: 'UTC' }; delete env.ELECTRON_RUN_AS_NODE
      const run = spawnSync(electron, [path.resolve(__dirname, 'businessDataWidgets.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      const line = run.stdout?.split('\n').find(text => text.startsWith('E2E_RESULT '))
      expect(line, run.stderr).toBeDefined()
      const result = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(result, run.stdout).not.toHaveProperty('fatal')
      expect(result.first.rows).toEqual(Array.from({ length: 5 }, (_value, index) => ['2026-11-01', String(index)]))
      expect(result.first.table).toContain('1–5 of 12 rows')
      expect(result.next.rows[0]).toEqual(['2026-11-01', '5'])
      expect(result.next.table).toContain('6–10 of 12 rows')
      expect(result.sorted.rows[0]).toEqual(['2026-11-01', '11'])
      expect(result.first.stageLabels).toEqual(['Trial', 'Reach', 'Completed'])
      expect(result.first.stages[0]).toContain('15')
      expect(result.first.stages[1]).toContain('66')
      expect(result.first.stages[2]).toContain('—')
      expect(result.first.stages[2]).not.toMatch(/\b0\b/)
      expect(result.secondDay.rows).toEqual([['2026-11-02', '999']])
      expect(result.secondDay.stages[0]).toContain('3')
      expect(result.refreshed.stages[0]).toContain('4')
      expect(result.failed.rows).toEqual([])
      expect(result.failed.table).toContain('Update failed')
      expect(result.failed.stages[0]).toContain('Update failed')
      expect(result.failed.stages[0]).toContain('—')
      expect(result.empty.rows).toEqual([])
      expect(result.empty.table).toContain('No data for this range')
      expect(result.empty.stages.every((stage: string) => stage.includes('—'))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
