import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
it('files live and historical conversations, then restores project placement in fresh Electron processes', { timeout: 45000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sidebar-project-filing-'))
  try {
    let esbuild: { buildSync(options: Record<string, unknown>): void }
    try { esbuild = require_('esbuild') } catch { esbuild = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
    esbuild.buildSync({ entryPoints: [path.join(__dirname, 'SidebarProjectFiling.fixture.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl' }, alias: { '@shared': path.resolve(__dirname, '../../shared') } })
    esbuild.buildSync({ stdin: { contents: "export { fileSidebarConversation } from './sessionProjectFiling'; export { getStore } from './store'", resolveDir: path.resolve(__dirname, '../../main') }, outfile: path.join(dir, 'filing.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron', require_.resolve('electron-store')], alias: { 'electron-store': require_.resolve('electron-store') } })
    const sourceCss = path.resolve(__dirname, '../index.css')
    const css = await require_('postcss')([require_('tailwindcss')(), require_('autoprefixer')()]).process(readFileSync(sourceCss, 'utf8'), { from: sourceCss })
    writeFileSync(path.join(dir, 'app.css'), css.css)
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
    writeFileSync(path.join(dir, 'bridge.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('filingBridge',{read:()=>ipcRenderer.invoke('read'),file:(...args)=>ipcRenderer.invoke('file',...args)})")
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron: string = require_('electron')
    for (const phase of ['save', 'cold', 'reopen', 'scrollbar']) {
      const run = spawnSync(electron, [path.join(__dirname, 'SidebarProjectFiling.harness.cjs'), dir, phase], { env, encoding: 'utf8', timeout: 12000 })
      expect(run.error, run.stdout + run.stderr).toBeUndefined()
      expect(run.status, run.stdout + run.stderr).toBe(0)
      expect(run.stdout).toContain('FILING_OK ' + phase)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
