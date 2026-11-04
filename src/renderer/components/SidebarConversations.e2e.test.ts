import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
describe('project conversations in the real Sidebar', () => {
  it('keeps both entry points, scope and scroll stable across focus scans and late restores', { timeout: 60000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sidebar-conversations-'))
    try {
      const root = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(root, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let build: { buildSync: (options: Record<string, unknown>) => unknown }
      try { build = require_('esbuild') } catch { build = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      build.buildSync({ entryPoints: [path.resolve(__dirname, 'SidebarConversations.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../shared') } })
      const cssPath = path.resolve(__dirname, '../index.css')
      const css = await require_('postcss')([require_('tailwindcss')(), require_('autoprefixer')()]).process(readFileSync(cssPath, 'utf8'), { from: cssPath })
      writeFileSync(path.join(dir, 'fixture.css'), css.css)
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [path.resolve(__dirname, 'SidebarConversations.harness.cjs'), dir], { encoding: 'utf8', timeout: 45000, env })
      const diagnostics = `status=${result.status} signal=${result.signal} spawnError=${result.error?.message ?? 'none'}\n${result.stdout}\n${result.stderr}`
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, diagnostics).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, diagnostics).not.toHaveProperty('fatal')
      expect(result.error, diagnostics).toBeUndefined()
      expect(result.status, diagnostics).toBe(0)
      expect(result.stdout, diagnostics).not.toMatch(/RENDERER Uncaught/)
      expect(data.defaultHidden).toBe(true)
      expect(data.duplicateTitlesKept).toBe(2)
      expect(data.after).toMatchObject({ ...data.before, sameNode: true, animated: false })
      expect(data.pinKeyboard).toEqual({ snapshot: { current: 'live-a', workspace: '/synthetic/client-a/project' }, activations: 0, resumes: 0 })
      expect(data.actionMenuCount).toBe(4)
      expect(data.deleteKeyboard).toEqual({ snapshot: { current: 'live-a', workspace: '/synthetic/client-a/project' }, resumes: 0, deletes: 0 })
      expect(data.centerMouse).toMatchObject({ snapshot: { current: 'live-b', workspace: '/synthetic/client-b/project' }, pinned: ['live-b'], deletes: 0, bounds: data.beforeHover })
      expect(data.oneClickHistory).toEqual({ snapshot: { current: 'resumed-00000000-0000-4000-8000-000000000004', workspace: '/synthetic/client-b/project' }, targetReads: 1, resumes: 1 })
      expect(data.afterProjectSelect.snapshot).toEqual({ current: 'live-b', workspace: '/synthetic/client-b/project' })
      expect(data.afterProjectSelect.expanded).toBe('true')
      expect(data.noExtraActivation).toBe(true)
      expect(data.afterLateResume.snapshot).toEqual({ current: 'live-a', workspace: '/synthetic/client-a/project' })
      expect(data.afterLateResume.projectCount).toBe(17)
      expect(data.afterLateResume.allCount).toBe(20)
      expect(data.afterLateResume.expanded).toBe('true')
      expect(data.afterLateResume.resumes).toHaveLength(2)
      expect(data.afterLateResume.resumes[1]).toMatchObject({ grantId: 'grant-alpha', cwd: '/synthetic/client-a/project' })
      expect(data.archivedSemantics).toEqual({ outerRole: null, primaryHasNested: 0 })
      expect(data.allRowsSemantic).toBe(true)
      expect(data.globalNewChat).toEqual({ current: null, workspace: '/synthetic/client-a/project' })
      expect(data.lateActivation).toEqual({ current: null, workspace: '/synthetic/client-a/project' })
      expect(data.composerWins).toEqual({ snapshot: { current: null, workspace: '/synthetic/TouShou workspace' }, queuedTargetResumed: false })
      expect(data.firstSend).toEqual({ snapshot: { current: 'created-1', workspace: '/synthetic/TouShou workspace' }, sent: { id: 'created-1', text: 'Synthetic first prompt' } })
      expect(data.lateCreate).toEqual({ snapshot: { current: 'live-b', workspace: '/synthetic/client-b/project' }, sent: { id: 'created-2', text: 'Synthetic background prompt' } })
      expect(data.firstArchive).toEqual({ open: true, text: 'Click again to archive the running session', kills: 0 })
      expect(data.resetArchive).toBe('Archive')
      expect(data.finalArchive).toEqual({ open: false, snapshot: { current: 'live-b', workspace: '/synthetic/client-b/project' }, kills: ['live-a'] })
      expect(data.fullTitle).toBe('Beta live conversation')
      expect(data.nativeKeyboardClicks).toEqual(Array(9).fill(1))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
