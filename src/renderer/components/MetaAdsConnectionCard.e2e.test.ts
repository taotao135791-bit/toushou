import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

describe('MetaAds connection card in Electron', () => {
  it('handles pushed status, cancellation, failed actions and disconnect without a real account', { timeout: 60000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'metaAds-card-'))
    try {
      const electronRoot = path.dirname(require_.resolve('electron/package.json'))
      const electron = process.platform === 'win32' ? path.join(electronRoot, 'dist/electron.exe') : process.platform === 'darwin' ? path.join(electronRoot, 'dist/Electron.app/Contents/MacOS/Electron') : path.join(electronRoot, 'dist/electron')
      if (!existsSync(electron)) throw new Error('Electron unavailable')
      let esbuild: { buildSync: (options: Record<string, unknown>) => unknown }
      try { esbuild = require_('esbuild') } catch { esbuild = require_(path.join(path.dirname(require_.resolve('vite/package.json')), '..', 'esbuild')) }
      esbuild.buildSync({
        stdin: { contents: fixture, resolveDir: __dirname, sourcefile: 'metaAds-fixture.tsx', loader: 'tsx' },
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
      expect(data, `${result.stdout}\n${result.stderr}`).not.toHaveProperty('fatal')
      expect(data).toEqual({ staleInitialIgnored: true, cancelledPendingBegin: true, lateBeginIgnored: true, failureReleased: true, retryConnected: true, failedDisconnectRetry: true, disconnected: true, noDeveloperForm: true, statusFailureRecoverable: true, staleMainExplained: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

const fixture = `
import { createRoot } from 'react-dom/client'
import MetaAdsConnectionCard from './MetaAdsConnectionCard'
import { useAppStore } from '../store'
const snap = (status: string) => ({ definition: { id:'metaAds',kind:'oauth',label:'MetaAds',description:'',capabilities:['mcp'] }, status, connected: status === 'connected', ...(status === 'waiting_for_user' ? {authorizationUrl:'https://example.test/authorize'} : {}) })
const fixture: any = { listener: null, initial: null, beginResolve: null, beginFails: false, disconnectFails: false, begins: 0, cancels: 0, disconnects: 0,
 emit(status: string) { fixture.listener(snap(status)) } }
;(window as any).cardFixture = fixture
;(window as any).electronAPI = {
 onMetaAdsStatus: (listener: any) => { fixture.listener = listener; return () => { fixture.listener = null } },
 metaAdsStatus: () => new Promise((resolve, reject) => { fixture.initial = resolve; fixture.initialReject = reject }),
 metaAdsBegin: () => { fixture.begins++; if (fixture.beginFails) return Promise.reject(new Error('synthetic')); return new Promise(resolve => { fixture.beginResolve = resolve }) },
 metaAdsCancel: async () => { fixture.cancels++; fixture.emit('disconnected'); return snap('disconnected') },
 metaAdsDisconnect: async () => { fixture.disconnects++; if (fixture.disconnectFails) throw new Error('synthetic'); fixture.emit('disconnected'); return snap('disconnected') },
 metaAdsOpenUrl: async () => false
}
useAppStore.setState({ language: 'en' })
const root = createRoot(document.getElementById('root')!)
let mount = 0
fixture.remount = () => { fixture.initial = null; fixture.listener = null; root.render(<MetaAdsConnectionCard key={++mount} />) }
fixture.remount()
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
  await js("window.cardFixture.emit('disconnected'); window.cardFixture.initial({definition:{id:'metaAds'},status:'connected',connected:true})")
  await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Connect Meta")&&!b.disabled)')
  const staleInitialIgnored = !await js('document.body.textContent.includes("Connected. You can")')
  await click('Connect Meta')
  await wait('window.cardFixture.begins===1 && !!window.cardFixture.beginResolve')
  await js("window.cardFixture.emit('waiting_for_user')")
  await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Cancel"&&!b.disabled)')
  await click('Cancel')
  await wait('window.cardFixture.cancels===1 && [...document.querySelectorAll("button")].some(b=>b.textContent.includes("Connect Meta")&&!b.disabled)')
  const cancelledPendingBegin = true
  await js("window.cardFixture.beginResolve({definition:{id:'metaAds'},status:'waiting_for_user',connected:false})")
  await new Promise(r=>setTimeout(r,50))
  const lateBeginIgnored = await js('document.body.textContent.includes("Connect Meta") && !document.body.textContent.includes("Complete Pipeboard / Meta authorization")')
  await js('window.cardFixture.beginFails=true')
  await click('Connect Meta')
  await wait('document.body.textContent.includes("Could not complete this action") && document.querySelector("section").getAttribute("aria-busy")==="false"')
  const failureReleased = await js('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Try again"&&!b.disabled)')
  await js('window.cardFixture.beginFails=false')
  await click('Try again')
  await wait('window.cardFixture.begins===3')
  await js("window.cardFixture.emit('waiting_for_user')")
  await wait('document.body.textContent.includes("Complete Pipeboard / Meta authorization")')
  await js("window.cardFixture.emit('connected')")
  await wait('document.body.textContent.includes("Connected. You can")')
  await js("window.cardFixture.beginResolve({definition:{id:'metaAds'},status:'waiting_for_user',connected:false,authorizationUrl:'https://example.test/authorize'})")
  await new Promise(r=>setTimeout(r,50))
  const retryConnected = await js('document.body.textContent.includes("Connected. You can")')
  await js('window.cardFixture.disconnectFails=true')
  await click('Disconnect')
  await wait('document.body.textContent.includes("Could not complete this action") && [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Disconnect"&&!b.disabled)')
  const failedDisconnectRetry = true
  await js('window.cardFixture.disconnectFails=false')
  await click('Disconnect')
  await wait('window.cardFixture.disconnects===2 && [...document.querySelectorAll("button")].some(b=>b.textContent.includes("Connect Meta")&&!b.disabled)')
  const disconnected = true
  await js("window.cardFixture.listener({definition:{id:'metaAds'},status:'failed',connected:false})")
  await wait('document.body.textContent.includes("Connect Meta")')
  const noDeveloperForm = await js('!document.querySelector("input") && [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Connect Meta"&&!b.disabled)')
  await js('window.cardFixture.remount()')
  await wait('!!window.cardFixture.initial && !!window.cardFixture.listener')
  await js('window.cardFixture.initialReject(new Error("synthetic status failure"))')
  await wait('document.body.textContent.includes("Could not load the Meta connection status")')
  const statusFailureRecoverable = await js('!document.querySelector("input") && !document.body.textContent.includes("Meta app settings") && [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Connect Meta"&&!b.disabled)')
  await click('Try again')
  await js('window.cardFixture.initialReject(new Error("No handler registered for meta-ads:status"))')
  await wait('document.body.textContent.includes("Restart the updated app")')
  const staleMainExplained = true
  console.log('E2E_RESULT '+JSON.stringify({staleInitialIgnored,cancelledPendingBegin,lateBeginIgnored,failureReleased,retryConnected,failedDisconnectRetry,disconnected,noDeveloperForm,statusFailureRecoverable,staleMainExplained}))
 } catch (error) { console.log('E2E_RESULT '+JSON.stringify({fatal:String(error)})); process.exitCode=1 }
 finally { win?.destroy(); app.quit() }
})
`
