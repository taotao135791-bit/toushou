import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('stable portaled menus in Electron', () => {
  it('keeps streamed rerenders, draft and pointer targets stable while responding to real geometry changes', { timeout: 45000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'menu-portal-ui-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (options: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'MenuPortal.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' })
      const cssPath = path.resolve(__dirname, '../index.css')
      const css = await require_('postcss')([require_('tailwindcss')(), require_('autoprefixer')()]).process(readFileSync(cssPath, 'utf8'), { from: cssPath })
      writeFileSync(path.join(dir, 'fixture.css'), css.css)
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'MenuPortal.harness.cjs'), dir], { encoding: 'utf8', timeout: 35000, env })
      expect(result.error).toBeUndefined()
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, JSON.stringify({ status: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code, stdoutBytes: result.stdout?.length ?? 0, stderrBytes: result.stderr?.length ?? 0 })).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      expect(result.status, JSON.stringify({ status: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code })).toBe(0)
      expect(data.streaming.state.stream).toBe(30)
      expect(data.streaming.state.refreshes).toBeGreaterThanOrEqual(30)
      expect(data.streaming.mutations).toEqual([])
      expect(data.streaming.bounds).toEqual(data.initial)
      expect(data.streaming.focused).toBe('menu-draft')
      expect(data.streaming.draft).toBe('中文草稿保持原样')
      expect(data.expanded.height).toBeGreaterThan(data.initial.height)
      expect(data.expanded.scrollHeight).toBeGreaterThan(data.expanded.clientHeight)
      expect(data.expandedFocus).toBe(true)
      for (const bounds of [data.initial, data.streaming.bounds, data.expanded, data.resized, data.moved]) {
        expect(bounds.left).toBeGreaterThanOrEqual(8)
        expect(bounds.top).toBeGreaterThanOrEqual(8)
        expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth - 8)
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight - 8)
      }
      expect(data.initial).toMatchObject({ viewportWidth: 1024, viewportHeight: 700 })
      expect(data.resized).toMatchObject({ viewportWidth: 800, viewportHeight: 540 })
      expect(data.ime).toEqual({ open: true, focus: 'menu-draft', draft: '中文草稿保持原样' })
      expect(data.escaped).toEqual({ focus: 'menu-trigger', closedWith: 30 })
      expect(data.repeated).toMatchObject({ open: false, clicks: 8, draft: '中文草稿保持原样' })
      expect(data.outsideClosed).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
