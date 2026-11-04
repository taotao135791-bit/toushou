import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('transcript reading position in Electron', () => {
  it('preserves session anchors and follows async growth only when pinned', { timeout: 60000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'transcript-scroll-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (options: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'transcriptScroll.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' })
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'transcriptScroll.harness.cjs'), dir], { encoding: 'utf8', timeout: 40000, env })
      expect(result.error).toBeUndefined()
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, result.stderr).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, result.stdout).not.toHaveProperty('fatal')
      expect(result.status).toBe(0)
      expect(data.first.bottom).toBeLessThanOrEqual(2)
      expect(data.reading.bottom).toBeGreaterThan(48)
      expect(data.reading.jump).toBe(true)
      expect(data.reading.anchor).not.toBeNull()
      expect(data.readingAfterGrowth.bottom).toBeGreaterThan(48)
      expect(Math.abs(data.readingAfterGrowth.anchor - data.reading.anchor)).toBeLessThanOrEqual(2)
      expect(data.second.bottom).toBeLessThanOrEqual(2)
      expect(data.pinnedAfterGrowth.bottom).toBeLessThanOrEqual(2)
      expect(data.restored.bottom).toBeGreaterThan(48)
      expect(Math.abs(data.restored.anchor - data.readingAfterGrowth.anchor)).toBeLessThanOrEqual(2)
      expect(data.afterImmediateScroll.bottom).toBeGreaterThan(48)
      expect(data.afterImmediateScroll.jump).toBe(true)
      expect(data.afterImmediateScroll.top).toBe(410)
      expect(data.longInitial.bottom, JSON.stringify(data)).toBeLessThanOrEqual(2)
      expect(data.longFirst.bottom, JSON.stringify(data)).toBeGreaterThan(48)
      expect(data.longSecond.bottom, JSON.stringify(data)).toBeGreaterThan(48)
      expect(data.longSecond.jump, JSON.stringify(data)).toBe(true)
      expect(data.firstVisible, JSON.stringify(data)).not.toBeNull()
      expect(data.visible, JSON.stringify(data)).not.toBeNull()
      expect(data.visible.id, JSON.stringify(data)).not.toBe(data.firstVisible)
      expect(data.longRestored.bottom, JSON.stringify(data)).toBeGreaterThan(48)
      expect(data.restoredAnchor, JSON.stringify(data)).not.toBeNull()
      expect(Math.abs(data.restoredAnchor - data.visible.offset), JSON.stringify(data)).toBeLessThanOrEqual(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
