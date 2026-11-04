import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

describe('AppsFlyer connection card in Electron', () => {
  it('handles pushed status, cancellation, failed actions and disconnect without a real account', { timeout: 60000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'appsflyer-card-'))
    try {
      const electronRoot = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(electronRoot, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(electronRoot, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(electronRoot, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let esbuild: { buildSync: (options: Record<string, unknown>) => unknown }
      try { esbuild = require_('esbuild') } catch { esbuild = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      esbuild.buildSync({
        stdin: { contents: fixture, resolveDir: __dirname, sourcefile: 'appsflyer-fixture.tsx', loader: 'tsx' },
        outfile: path.join(dir, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
        alias: { '@shared': path.resolve(__dirname, '../../shared') }, loader: { '.png': 'dataurl', '.svg': 'dataurl' }
      })
      const harness = path.join(dir, 'harness.cjs')
      writeFileSync(harness, harnessSource)
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(electron, [harness, dir], { encoding: 'utf8', timeout: 45000, env })
      const line = result.stdout?.split('\n').find(value => value.startsWith('E2E_RESULT '))
      expect(line, result.stderr).toBeDefined()
      const data = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      expect(data).toEqual({ staleInitialIgnored: true, cancelledPendingBegin: true, lateBeginIgnored: true, failureReleased: true, retryConnected: true, failedDisconnectRetry: true, disconnected: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

const fixture = `
import { createRoot } from 'react-dom/client'
import AppsFlyerConnectionCard from './AppsFlyerConnectionCard'
import { useAppStore } from '../store'
const snap = (status: string) => ({ definition: { id:'appsflyer',kind:'oauth',label:'AppsFlyer',description:'',capabilities:['mcp'] }, status, connected: status === 'connected', ...(status === 'waiting_for_user' ? {authorizationUrl:'https://example.test/authorize'} : {}) })
const fixture: any = { listener: null, initial: null, beginResolve: null, beginFails: false, disconnectFails: false, begins: 0, cancels: 0, disconnects: 0,
 emit(status: string) { fixture.listener(snap(status)) } }
;(window as any).cardFixture = fixture
;(window as any).electronAPI = {
 onAppsFlyerStatus: (listener: any) => { fixture.listener = listener; return () => { fixture.listener = null } },
 appsflyerStatus: () => new Promise(resolve => { fixture.initial = resolve }),
 appsflyerBegin: () => { fixture.begins++; if (fixture.beginFails) return Promise.reject(new Error('synthetic')); return new Promise(resolve => { fixture.beginResolve = resolve }) },
 appsflyerCancel: async () => { fixture.cancels++; fixture.emit('disconnected'); return snap('disconnected') },
 appsflyerDisconnect: async () => { fixture.disconnects++; if (fixture.disconnectFails) throw new Error('synthetic'); fixture.emit('disconnected'); return snap('disconnected') },
 appsflyerOpenUrl: async () => false
}
useAppStore.setState({ language: 'en' })
createRoot(document.getElementById('root')!).render(<AppsFlyerConnectionCard />)
`

const harnessSource = `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const dir = process.argv[2]
app.setPath('userData', path.join(dir, 'profile'))
app.whenReady().then(async () => {
 let win
 try {
  fs.writeFileSync(path.join(dir,'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
  win = new BrowserWindow({show:false, width:1024,height:700,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}})
  const wc = win.webContents
  wc.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_details, cb) => cb({cancel:true}))
  await win.loadFile(path.join(dir,'index.html'))
  wc.on('console-message', (_event, _level, message) => console.log('RENDERER '+message))
  const js = async source => { try { return await wc.executeJavaScript(source) } catch (error) { throw new Error(source+': '+String(error)) } }
  const wait = async expression => { const deadline = Date.now()+5000; while (!await js(expression)) { if (Date.now()>deadline) throw new Error('Timed out: '+expression); await new Promise(r => setTimeout(r,20)) } }
  const click = text => js('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === '+JSON.stringify(text)+').click()')
  await wait('!!window.cardFixture?.listener && !!window.cardFixture?.initial')
  await js("window.cardFixture.emit('disconnected'); window.cardFixture.initial({definition:{id:'appsflyer'},status:'connected',connected:true})")
  await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Connect AppsFlyer")&&!b.disabled)')
  const staleInitialIgnored = !await js('document.body.textContent.includes("Authorized. You can")')
  await click('Connect AppsFlyer')
  await wait('window.cardFixture.begins===1 && !!window.cardFixture.beginResolve')
  await js("window.cardFixture.emit('waiting_for_user')")
  await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Cancel"&&!b.disabled)')
  await click('Cancel')
  await wait('window.cardFixture.cancels===1 && [...document.querySelectorAll("button")].some(b=>b.textContent.includes("Connect AppsFlyer")&&!b.disabled)')
  const cancelledPendingBegin = true
  await js("window.cardFixture.beginResolve({definition:{id:'appsflyer'},status:'waiting_for_user',connected:false})")
  await new Promise(r=>setTimeout(r,50))
  const lateBeginIgnored = await js('document.body.textContent.includes("Connect AppsFlyer") && !document.body.textContent.includes("Complete authorization")')
  await js('window.cardFixture.beginFails=true')
  await click('Connect AppsFlyer')
  await wait('document.body.textContent.includes("Could not complete this action") && document.querySelector("section").getAttribute("aria-busy")==="false"')
  const failureReleased = await js('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Try again"&&!b.disabled)')
  await js('window.cardFixture.beginFails=false')
  await click('Try again')
  await wait('window.cardFixture.begins===3')
  await js("window.cardFixture.emit('waiting_for_user')")
  await wait('document.body.textContent.includes("Complete authorization")')
  await js("window.cardFixture.emit('connected')")
  await wait('document.body.textContent.includes("Authorized. You can")')
  await js("window.cardFixture.beginResolve({definition:{id:'appsflyer'},status:'waiting_for_user',connected:false,authorizationUrl:'https://example.test/authorize'})")
  await new Promise(r=>setTimeout(r,50))
  const retryConnected = await js('document.body.textContent.includes("Authorized. You can")')
  await js('window.cardFixture.disconnectFails=true')
  await click('Disconnect')
  await wait('document.body.textContent.includes("Could not complete this action") && [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Disconnect"&&!b.disabled)')
  const failedDisconnectRetry = true
  await js('window.cardFixture.disconnectFails=false')
  await click('Disconnect')
  await wait('window.cardFixture.disconnects===2 && [...document.querySelectorAll("button")].some(b=>b.textContent.includes("Connect AppsFlyer")&&!b.disabled)')
  const disconnected = true
  console.log('E2E_RESULT '+JSON.stringify({staleInitialIgnored,cancelledPendingBegin,lateBeginIgnored,failureReleased,retryConnected,failedDisconnectRetry,disconnected}))
 } catch (error) { console.log('E2E_RESULT '+JSON.stringify({fatal:String(error)})); process.exitCode=1 }
 finally { win?.destroy(); app.quit() }
})
`
