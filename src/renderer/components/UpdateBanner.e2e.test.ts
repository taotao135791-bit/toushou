import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('startup update notification in Electron', () => {
  it('quietly checks, shows new versions, and keeps download and installation explicit', { timeout: 45000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'updater-banner-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (options: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'UpdateBanner.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../shared') } })
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'UpdateBanner.harness.cjs'), dir], { encoding: 'utf8', timeout: 35000, env })
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, result.stderr).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      expect(data.quiet).toEqual(['', '', ''])
      expect(data.afterLateSnapshot).toContain('2.1.0')
      expect(data.downloadsBeforeClick).toBe(0)
      expect(data.dismissedSameVersion).toBe('')
      expect(data.progress).toContain('42%')
      expect(data.ready).toContain('2.2.0')
      expect(data.installsBeforeClick).toBe(0)
      expect(data.installsAfterClick).toBe(1)
      expect(data.downloadError).toContain('Update failed')
      expect(data.remounted).toContain('2.3.0')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
