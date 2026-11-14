import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

describe('MCP list recovery in Electron', () => {
  it('shows a persistent read error, recovers on retry, and hides stale entries after a later failure', { timeout: 60000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-list-ui-'))
    try {
      const electronRoot = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(electronRoot, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(electronRoot, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(electronRoot, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let esbuild: { buildSync: (options: Record<string, unknown>) => unknown }
      try { esbuild = require_('esbuild') } catch { esbuild = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      esbuild.buildSync({
        stdin: { contents: fixture, resolveDir: __dirname, sourcefile: 'mcp-list-fixture.tsx', loader: 'tsx' },
        outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
        alias: { '@shared': path.resolve(__dirname, '../../shared') }, loader: { '.svg': 'dataurl', '.png': 'dataurl' }
      })
      const harness = path.join(dir, 'harness.cjs')
      writeFileSync(harness, harnessSource)
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [harness, dir], { encoding: 'utf8', timeout: 45000, env })
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, result.stderr).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).toEqual({ error: true, retainedWhileRetrying: true, recovered: true, laterFailure: true, recoveredAgain: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

const fixture = `
import { createRoot } from 'react-dom/client'
import McpConnectionsSection from './McpConnectionsSection'
import { useAppStore } from '../store'
const fixture: any = { calls: [] }
;(window as any).listFixture = fixture
;(window as any).electronAPI = {
  mcpList: () => new Promise((resolve, reject) => fixture.calls.push({resolve,reject})),
  mcpAdd: async () => ({ok:true,name:'synthetic-added'}),
  openExternalUrl: async () => true
}
useAppStore.setState({ language: 'en' })
createRoot(document.getElementById('root')!).render(<McpConnectionsSection />)
`

const harnessSource = `
const { app, BrowserWindow } = require('electron')
const path = require('node:path'), fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
 let win
 try {
  fs.writeFileSync(path.join(dir,'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
  win = new BrowserWindow({show:false,width:1024,height:700,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}})
  const wc = win.webContents
  wc.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_details, cb) => cb({cancel:true}))
  await win.loadFile(path.join(dir,'index.html'))
  const js = source => wc.executeJavaScript(source)
  const wait = async expression => { const deadline=Date.now()+5000; while (!await js(expression)) { if (Date.now()>deadline) throw new Error('Timed out: '+expression); await new Promise(r=>setTimeout(r,20)) } }
  const click = text => js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()')
  await wait('window.listFixture?.calls.length===1')
  await js("window.listFixture.calls[0].reject(new Error('private-internal-detail'))")
  await wait('!!document.querySelector("[role=alert]")')
  const error = await js('document.querySelector("[role=alert]").textContent.includes("existing configuration has not been changed") && !document.body.textContent.includes("private-internal-detail")')
  await click('Retry')
  await wait('window.listFixture.calls.length===2')
  const retainedWhileRetrying = await js('!!document.querySelector("[role=alert]") && [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Retrying…"&&b.disabled)')
  await js("window.listFixture.calls[1].resolve([{name:'synthetic-server',transport:'http',endpointMasked:'https://example.test/mcp',managed:true,enabled:true}])")
  await wait('document.body.textContent.includes("synthetic-server") && !document.querySelector("[role=alert]")')
  const recovered = true
  await click('Add server')
  await wait('window.listFixture.calls.length===3')
  await js("window.listFixture.calls[2].reject(new Error('synthetic'))")
  await wait('!!document.querySelector("[role=alert]")')
  const laterFailure = await js('!document.body.textContent.includes("synthetic-server") && document.querySelector("[role=alert]").textContent.includes("existing configuration has not been changed")')
  await click('Retry')
  await wait('window.listFixture.calls.length===4')
  await js("window.listFixture.calls[3].resolve([{name:'synthetic-server',transport:'http',endpointMasked:'https://example.test/mcp',managed:true,enabled:true}])")
  await wait('document.body.textContent.includes("synthetic-server") && !document.querySelector("[role=alert]")')
  console.log('E2E_RESULT '+JSON.stringify({error,retainedWhileRetrying,recovered,laterFailure,recoveredAgain:true}))
 } catch (error) { console.log('E2E_RESULT '+JSON.stringify({fatal:String(error)})); process.exitCode=1 }
 finally { win?.destroy(); app.quit() }
})
`
