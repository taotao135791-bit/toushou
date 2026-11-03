import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('ChatPanel background metadata rendering', () => {
  it('ignores 200 background changes while current conversation updates remain live', { timeout: 60000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-panel-perf-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (options: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'ChatPanelPerf.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@shared': path.resolve(__dirname, '../../shared') } })
      const cssPath = path.resolve(__dirname, '../index.css')
      const css = await require_('postcss')([require_('tailwindcss')(), require_('autoprefixer')()]).process(readFileSync(cssPath, 'utf8'), { from: cssPath })
      writeFileSync(path.join(dir, 'fixture.css'), css.css)
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'ChatPanelPerf.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, result.stderr).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      console.info('CHAT_PANEL_PERF ' + JSON.stringify(data))
      expect(data.background.commits, JSON.stringify(data)).toBe(0)
      expect(data.background.header).toContain('Current conversation')
      expect(data.renamed.title).toBe(true)
      expect(data.renamed.commits).toBeGreaterThan(data.background.commits)
      expect(data.status).toBeGreaterThan(data.renamed.commits)
      expect(data.permission).toBe(true)
      expect(data.content).toEqual({ message: true, error: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
