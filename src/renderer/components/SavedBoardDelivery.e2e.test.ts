import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('native board handoff in Electron', () => {
  it('verifies Main session authority, folds native writes, and opens the actual saved board without an iframe', { timeout: 60000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'saved-board-delivery-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      let build: { buildSync: (opts: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'savedBoardDelivery.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../shared') } })
      const env: Record<string, string | undefined> = { ...process.env, TZ: 'UTC' }; delete env.ELECTRON_RUN_AS_NODE
      const run = spawnSync(electron, [path.resolve(__dirname, 'savedBoardDelivery.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      const line = run.stdout?.split('\n').find(text => text.startsWith('E2E_RESULT '))
      expect(line, run.stderr).toBeDefined()
      const result = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(result, run.stdout).not.toHaveProperty('fatal')
      expect(result.unavailable.count).toBe(1)
      expect(result.unavailable.listCalls).toBe(0)
      expect(result.ready.count).toBe(1)
      expect(result.ready.text).toContain('Verified business view')
      expect(result.ready.text).not.toContain('UNTRUSTED TOOL TITLE')
      expect(result.ready.text).toContain('Saved · 1 module')
      expect(result.ready.iframes).toBe(0)
      expect(result.ready.listCalls).toBe(1)
      expect(result.route).toBe('/boards?board=synthetic-board&widget=native-table')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
