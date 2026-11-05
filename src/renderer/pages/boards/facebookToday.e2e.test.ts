import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require_ = createRequire(import.meta.url)
describe('Facebook today account workflow', () => {
  it('hides legacy browser controls and sends no web reads', { timeout: 40000 }, () => {
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
      expect(result.after).toEqual([])
      expect(result.text).toContain('旧网页读数已暂停')
      expect(result.text).toContain('前往 Meta Ads 连接')
      expect(result.text).not.toContain('打开浏览器')
      expect(result.text).not.toContain('巡检全部已添加账户')

    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
