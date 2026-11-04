import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('shared project controls in Electron', () => {
  it('uses real sidebar and composer entries with synthetic project authority', { timeout: 60000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'projects-ui-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (options: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'Projects.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../shared') } })
      const cssPath = path.resolve(__dirname, '../index.css')
      const css = await require_('postcss')([require_('tailwindcss')(), require_('autoprefixer')()]).process(readFileSync(cssPath, 'utf8'), { from: cssPath })
      writeFileSync(path.join(dir, 'fixture.css'), css.css)
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'Projects.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      const diagnostics = `status=${result.status} signal=${result.signal} spawnError=${result.error?.message ?? 'none'}\n${result.stdout}\n${result.stderr}`
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, diagnostics).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, diagnostics).not.toHaveProperty('fatal')
      expect(result.error, diagnostics).toBeUndefined()
      expect(result.status, diagnostics).toBe(0)
      expect(data.defaultSelected).toBe('/synthetic/default')
      expect(data.defaultPresentation).toEqual({ hiddenInSidebar: true, composerText: 'No project', composerTitle: 'No project' })
      expect(data.defaultPicker).toEqual({ present: true, title: 'No project', privatePathVisible: false })
      expect(data.ime).toEqual({ prevented: true, open: true, creates: 0 })
      expect(data.cancelledDraft).toBe('中文项目')
      expect(data.failedDraft).toEqual({ name: '中文项目', error: true })
      expect(data.formCancelDraft).toBe('中文项目')
      expect(data.formEscapeDraft).toBe('中文项目')
      for (const key of ['sharedAfterSidebarCreate', 'sharedAfterComposerCreate', 'sharedSidebarImport', 'sharedComposerImport', 'archiveHidden', 'archiveHiddenInComposer', 'focusAfterEscape', 'restoredInComposer', 'beforeConfirmation', 'afterCancelDelete']) expect(data[key], key).toBe(true)
      for (const bounds of [data.sidebarBounds, data.composerBounds]) {
        expect(bounds.left).toBeGreaterThanOrEqual(8)
        expect(bounds.top).toBeGreaterThanOrEqual(8)
        expect(bounds.right).toBeLessThanOrEqual(bounds.width - 8)
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - 8)
      }
      expect(data.pathMenu).toMatchObject({ complete: true, editable: false, copied: true })
      expect(data.pathMenu.bottom).toBeLessThanOrEqual(data.pathMenu.height - 8)
      expect(data.afterDelete.current).toBe('/synthetic/default')
      expect(data.afterDelete.projects.some((row: { name: string }) => row.name === 'Sidebar created')).toBe(false)
      expect(data.afterDelete.sessions).not.toContain('project-session')
      expect(data.afterDelete.drafts).not.toContain('project-session')
      expect(data.composerDraft).toBe('Unsent optimization brief')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
