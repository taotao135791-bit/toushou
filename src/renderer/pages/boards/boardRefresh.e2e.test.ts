import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('board date refresh in Electron', () => {
  it('keeps date changes manual, refreshes only on demand, and labels partial today AF', { timeout: 60000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'board-refresh-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      let build: { buildSync: (opts: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'boardRefresh.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../../shared') } })
      const env: NodeJS.ProcessEnv = { ...process.env, TZ: 'UTC' }; delete env.ELECTRON_RUN_AS_NODE
      const run = spawnSync(electron, [path.resolve(__dirname, 'boardRefresh.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      const line = run.stdout?.split('\n').find(text => text.startsWith('E2E_RESULT '))
      expect(line, run.stderr).toBeDefined()
      const result = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(result, run.stdout).not.toHaveProperty('fatal')
      expect(result.opened.af).toHaveLength(1)
      expect(result.opened.media).toHaveLength(1)
      expect(result.opened.media[0].range).toBe('7')
      expect(result.opened.af[0].datasetIds).toEqual(['af-bound'])
      expect(result.opened.text).toContain('1 fixed modules')
      expect(result.opened.text).not.toContain('All modules follow the master')
      expect(result.opened.text).toContain('Last 7 days')
      expect(result.opened.text).not.toContain('Last 30 days)')
      expect(result.opened.text).toContain(result.opened.af[0].start)
      expect(result.opened.text).toContain(result.opened.af[0].end)
      expect(result.yesterdayOnly.media).toHaveLength(result.opened.media.length)
      expect(result.yesterdayOnly.af).toHaveLength(result.opened.af.length)
      expect(result.yesterdayOnly.text).toContain('Date range changed. Refresh to load data for the new range.')
      expect(result.yesterdayOnly.card).toContain('—')
      expect(result.yesterdayPending.text).toContain('Updating AF')
      expect(result.yesterday.media.map((entry: { range: string }) => entry.range)).toEqual(['7', 'yd'])
      expect(result.yesterday.af).toHaveLength(2)
      expect(result.yesterday.af[1].start).toBe(result.yesterday.af[1].end)
      expect(result.yesterday.card).toContain('2')
      expect(result.todayOnly.media).toHaveLength(result.yesterday.media.length)
      expect(result.todayOnly.af).toHaveLength(result.yesterday.af.length)
      expect(result.todayOnly.text).toContain('Date range changed. Refresh to load data for the new range.')
      expect(result.todayPending.text).toContain('Updating AF')
      expect(result.today.media.map((entry: { range: string }) => entry.range)).toEqual(['7', 'yd', '1'])
      expect(result.today.af).toHaveLength(3)
      expect(result.today.card).toContain('3')
      expect(result.today.text).toContain('AF today is partial data up to now.')
      expect(result.unbound.text).toContain('AF refresh is not connected')
      expect(result.unbound.text).toContain('Connect refresh')
      expect(result.unbound.card).toContain('—')
      expect(result.empty.text).toContain('No AF data for this range')
      expect(result.empty.card).toContain('—')
      expect(result.metaSelection.account).toBe('')
      expect(result.metaSelection.options).toContain('act_123')
      expect(result.metaSelection.card).not.toContain('30')
      expect(result.metaReady.calls).toBe(result.metaSelection.calls + 1)
      expect(result.metaReady.directSummary).toBe(0)
      expect(result.metaReady.card).toContain('30')
      expect(result.metaReady.text).toContain('Synthetic Meta')
      expect(result.metaFailed.card).not.toContain('30')
      expect(result.metaFailed.text).toContain('did not complete')
      expect(result.metaDisconnected.card).not.toContain('30')
      expect(result.metaDisconnected.text).toContain('Meta disconnected')
      expect(result.metaDisconnected.directSummary).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
