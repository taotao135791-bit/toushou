import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require_ = createRequire(import.meta.url)
describe('Facebook today account workflow', () => {
  it('reads explicit scopes, isolates failures, saves scope, stops batches and rejects stale dates', { timeout: 40000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'facebook-today-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const binary = process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, process.platform === 'win32' ? 'dist/electron.exe' : 'dist/electron')
      let build: { buildSync: (opts: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'facebookToday.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../../shared') } })
      const css = spawnSync(process.execPath, [require_.resolve('tailwindcss/lib/cli.js'), '-i', 'src/renderer/index.css', '-o', path.join(dir, 'fixture.css')], { cwd: path.resolve(__dirname, '../../../..'), encoding: 'utf8', timeout: 15000 })
      expect(css.status, css.stderr).toBe(0)
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const run = spawnSync(binary, [path.resolve(__dirname, 'facebookToday.harness.cjs'), dir], { encoding: 'utf8', timeout: 30000, env })
      const line = run.stdout.split('\n').find(line => line.startsWith('E2E_RESULT '))
      expect(line, run.stderr).toBeDefined()
      const result = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(result, run.stderr).not.toHaveProperty('fatal')
      expect(result.initial).toEqual({ calls: [], articles: 0 })
      expect(result.single.calls).toEqual(['123456'])
      expect(result.single.articles).toBe(1)
      expect(result.single.text).toContain('25')
      expect(result.searchClearedSelection).toBe(true)
      expect(result.batch.calls).toEqual(['123456', '123456', '234567', '345678'])
      expect(result.batch.articles).toBe(3)
      expect(result.snapshot.accounts.map((a: { accountId: string; status: string }) => [a.accountId, a.status])).toEqual([['123456', 'ok'], ['234567', 'failed'], ['345678', 'ok']])
      expect(result.stopped.calls).toEqual(['123456'])
      expect(result.stopped.text).toContain('本次尚未读取')
      expect(result.blocked).toEqual(['123456'])
      expect(result.changed).toEqual({ calls: ['123456'], articles: 0 })
      if (process.env.FB_TODAY_PREVIEW) copyFileSync(path.join(dir, 'preview.png'), process.env.FB_TODAY_PREVIEW)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
