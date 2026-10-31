import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require_ = createRequire(import.meta.url)
describe('modal boundary with a real Electron browser view', () => {
  it('parks and restores the view and traps focus across nested dialogs', { timeout: 30000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'modal-e2e-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (opts: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'modalBoundary.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@shared': path.resolve(__dirname, '../../shared') } })
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'modalBoundary.harness.cjs'), dir], { encoding: 'utf8', timeout: 20000, env })
      const line = result.stdout?.split('\n').find(s => s.startsWith('E2E_RESULT '))
      expect(line, result.stderr).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      expect(data.tt.mixed).not.toContain('EXPENSE_TOP_SHOULD_HIDE')
      expect(data.tt.mixed).toContain('Dataset synchronization failed')
      expect(data.tt.mixed).toContain('2026-10-31')
      expect(data.tt.mixed).toContain('2026-10-30')
      expect(data.tt.backup).toContain('TikTok 报表（旧数据备份）')
      expect(data.tt.modelsAlert).toContain('Could not read the model pool')
      expect(data.metrics.unknown).toContain('—')
      expect(data.metrics.chart).toBeTruthy()
      expect(data.metrics.ctr).toContain('10')
      expect(data).toMatchObject({ hidden: true, fullViewport: true, focusInside: true, tabTrap: true, nestedHidden: true, staysHidden: true, parentStillOpen: true, restored: true, focusRestored: true })
      const shown = data.calls.filter((call: {kind:string}) => call.kind === 'show')
      expect(shown).toHaveLength(2)
      expect(shown[1].url).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
