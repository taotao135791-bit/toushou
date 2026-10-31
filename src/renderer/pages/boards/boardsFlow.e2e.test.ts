import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('board creation flow in Electron', () => {
  it('opens created boards and hides board controls on Today', { timeout: 30000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'boards-flow-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (opts: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'boardsFlow.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, alias: { '@shared': path.resolve(__dirname, '../../../shared') } })
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'boardsFlow.harness.cjs'), dir], { encoding: 'utf8', timeout: 20000, env })
      const line = result.stdout?.split('\n').find(s => s.startsWith('E2E_RESULT '))
      expect(line, result.stderr).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      expect(data.initial).toMatchObject({ today: true, activeBoard: null, toolbar: false, menu: false })
      expect(data.created).toMatchObject({ today: false, activeBoard: 'TikTok panorama', toolbar: true, menu: true, ttNotice: true, noReading: false, connect: true })
      expect(data.created.saved[0]).toMatchObject({ name: 'TikTok panorama', types: expect.arrayContaining(['tt-reading', 'counter', 'chart-line']) })
      expect(data.created.saved[0]).toMatchObject({ masterScope: { range: 'last7' }, verifiedCards: 7 })
      expect(data.verified[0]).toContain('5')
      expect(data.verified[0]).not.toContain('700')
      expect(data.verified[0]).not.toContain('100')
      expect(data.failedReload).toContain('Waiting for a complete TikTok reading')
      expect(data.noSuccessfulAccounts).toEqual({ value: '—', failed: true, unattempted: true })
      expect(data.progress).toBe(true)
      expect(data.cancelled).toMatchObject({ notice: true })
      expect(data.cancelled.count).toBeGreaterThan(0)
      expect(data.unverified).toContain('Waiting for a complete TikTok reading')
      expect(data.unverified).not.toContain('700')
      expect(data.connect.route).toBe('/connections')
      expect(data.returned).toMatchObject({ today: true, activeBoard: null, toolbar: false, menu: false })
      expect(data.todayProgress).toBe(true)
      expect(data.todayCancelled).toBe(true)
      expect(data.blank).toMatchObject({ today: false, activeBoard: 'Blank fixture', toolbar: true, menu: true })
      expect(data.blank.saved[1]).toMatchObject({ name: 'Blank fixture', types: [] })
      expect(data.composed).toMatchObject({ today: false, activeBoard: 'Blank board', toolbar: true, menu: true })
      expect(data.composed.saved).toHaveLength(3)
      expect(data.googleVisible).toEqual({ scrolled: true, cardVisible: true, inputVisible: true, focused: true })
      expect(data.ttVisible).toEqual({ scrolled: true, cardVisible: true, inputVisible: true, focused: true })
      expect(data.switchedAway).toEqual({ today: true, focusedInConfig: false })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
