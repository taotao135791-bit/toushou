import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('custom widget palettes in actual renderer CSS', () => {
  it('applies local content, table and funnel colors in both themes without recoloring errors or other cards', { timeout: 60000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'widget-palette-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      let build: { buildSync: (opts: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'widgetPalette.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../../shared') } })
      const postcss = require_('postcss'), tailwindcss = require_('tailwindcss'), autoprefixer = require_('autoprefixer')
      const source = path.resolve(__dirname, '../../index.css')
      const css = await postcss([tailwindcss(require_(path.resolve(__dirname, '../../../../tailwind.config.js'))), autoprefixer]).process(readFileSync(source, 'utf8'), { from: source })
      writeFileSync(path.join(dir, 'fixture.css'), css.css)
      const env: Record<string, string | undefined> = { ...process.env, TZ: 'UTC' }; delete env.ELECTRON_RUN_AS_NODE
      const run = spawnSync(electron, [path.resolve(__dirname, 'widgetPalette.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      const line = run.stdout?.split('\n').find(text => text.startsWith('E2E_RESULT '))
      expect(line, run.stderr).toBeDefined()
      const result = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(result, run.stdout).not.toHaveProperty('fatal')
      for (const theme of ['light', 'dark']) {
        for (const [palette, surface, foreground, accent] of [['navy', 'rgb(19, 36, 53)', 'rgb(232, 242, 252)', 'rgba(32, 160, 128, 0.5)'], ['paper', 'rgb(244, 234, 223)', 'rgb(36, 52, 68)', 'rgba(192, 80, 48, 0.5)']]) {
          const cards = result[theme][palette]
          for (const type of ['counter', 'note', 'table', 'funnel']) expect(cards[type].background).toBe(surface)
          expect(cards.counter.text).toBe(foreground)
          expect(cards.table.header).toBe(surface)
          expect(cards.table.cell).toBe(foreground)
          expect(cards.table.rowBorder).toBe(palette === 'navy' ? 'rgb(64, 80, 96)' : 'rgb(176, 160, 144)')
          expect(cards.funnel.bar).toBe(accent)
          expect(cards.note.status).not.toBe(foreground)
          expect(cards.note.dim).not.toBe(result[theme].default.note.dim)
        }
        expect(result[theme].automatic.counter.background).toBe('rgb(119, 119, 119)')
        expect(result[theme].automatic.counter.text).toBe('rgb(0, 0, 0)')
      }
      expect(result.light.default.counter.text).toBe('rgb(32, 32, 32)')
      expect(result.dark.default.counter.text).toBe('rgb(237, 237, 237)')
      expect(result.light.navy).toEqual(result.dark.navy)
      expect(result.light.paper).toEqual(result.dark.paper)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
